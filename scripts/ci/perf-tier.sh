#!/usr/bin/env bash
set -euo pipefail

# THE PERF TIER'S RUNNER and its verdict policy (lead ruling 2026-11-16: perf noise is 2.7x between runs of
# identical code - 52 perf jobs, same tests 618-2273 ms, suite wall 121-327 s - so a budget cannot gate a pull request).
#
#   pull request  (FY_PERF_REPORT_ONLY=true)  REPORT ONLY. Runs the tier, prints and summarises every test that went
#                 over budget with its time, writes `perf-failed: <files>`, and exits 0: the result is shown, it
#                 never fails the job, so it never fails Full CI. Budgets are not raised.
#   anything else (push to main)              BLOCKING, with ONE automatic re-run of just the failing FILES, one
#                 process per file. A file that passes on the re-run passes; a file that fails again fails the job.
#                 Both attempts' times are printed, and `perf-failed: <files>` names the files that failed twice, so
#                 a file failing twice in a row on main is visible to whoever reads the summary. No bot, no issue.
#
# Usage: perf-tier.sh <test-file>...   (paths relative to the repository root, as test.sh enumerates them)
# Env:   FY_CI_PERF_PARALLEL   processes for the first attempt (default 1)
#        FY_PERF_REPORT_ONLY   `true` on a pull request; anything else blocks
#        FY_PERF_RUN_FILES     the executable that runs one process (default scripts/ci/perf-run-files.sh)
#        FY_PERF_OUT           where the reports go (default coverage/perf, the uploaded artifact)
files=("$@")
[[ ${#files[@]} -ge 1 ]] || { echo "❌ usage: $0 <test-file>..." >&2 && exit 2; }
processes=${FY_CI_PERF_PARALLEL:-1}
[[ ${processes} =~ ^[1-9][0-9]*$ ]] || { echo "❌ FY_CI_PERF_PARALLEL must be a positive integer" >&2 && exit 2; }
[[ ${processes} -gt ${#files[@]} ]] && processes=${#files[@]}
report_only=false
[[ ${FY_PERF_REPORT_ONLY:-false} == true ]] && report_only=true
runner="${FY_PERF_RUN_FILES:-./scripts/ci/perf-run-files.sh}"
out="${FY_PERF_OUT:-coverage/perf}"
summary="${GITHUB_STEP_SUMMARY:-/dev/null}"
junit() { bun scripts/ci/perf-junit.ts "$@"; }

say() { printf '%s\n' "$*" | tee -a "${summary}"; }

rm -rf "${out}"
echo "🧪 Running ${#files[@]} perf test files in ${processes} process(es)..."
pids=()
for ((index = 0; index < processes; index++)); do
  dir="${out}/attempt-1/process-${index}"
  mkdir -p "${dir}"
  share=()
  for ((file = index; file < ${#files[@]}; file += processes)); do share+=("./${files[file]}"); done
  printf '%s\n' "${share[@]}" >"${dir}/files.txt"
  (
    set +e
    "${runner}" "${dir}" "${share[@]}"
  ) &
  pids+=("$!")
done
failed_files=()
failed_tests=0
for ((index = 0; index < processes; index++)); do
  dir="${out}/attempt-1/process-${index}"
  status=0
  wait "${pids[index]}" || status=$?
  echo "──── perf process ${index} ────"
  cat "${dir}/console.log" 2>/dev/null || true
  [[ ${status} -eq 0 ]] && continue
  # Which files failed: the ones a failed test names. A process that failed with no failed test named (a crash, a
  # stall kill, a file that did not load, no report) fails its WHOLE share - never a pass by omission.
  named="$(junit failed "${dir}/junit.xml")" || named=""
  if [[ -n ${named} ]]; then
    failed_tests=$((failed_tests + $(wc -l <<<"${named}")))
    while IFS= read -r name; do failed_files+=("${name}"); done < <(cut -f1 <<<"${named}" | sort -u)
    # A file of this share that reported no test at all (it failed to load) is named by no failed test: without this
    # it would pass by omission beside a file that did name itself. Retry it with the rest.
    reported="$(junit reported "${dir}/junit.xml")" || reported=""
    while IFS= read -r name; do
      name="${name#./}"
      if ! grep -qxF -- "${name}" <<<"${reported}"; then
        failed_files+=("${name}")
        failed_tests=$((failed_tests + 1))
      fi
    done <"${dir}/files.txt"
  else
    failed_tests=$((failed_tests + $(wc -l <"${dir}/files.txt")))
    while IFS= read -r name; do failed_files+=("${name#./}"); done <"${dir}/files.txt"
  fi
done

slowest() {
  say ""
  say "Slowest perf tests (attempt 1):"
  junit slowest 10 "${out}"/attempt-1/process-*/junit.xml | while IFS=$'\t' read -r ms file name; do
    say "- ${ms} ms  ${file}: ${name}"
  done
}

if [[ ${#failed_files[@]} -eq 0 ]]; then
  say "✅ perf: all ${#files[@]} files within budget"
  slowest
  exit 0
fi

mapfile -t failed_files < <(printf '%s\n' "${failed_files[@]}" | sort -u)
say "### Performance Tests: ${failed_tests} over budget in ${#failed_files[@]} file(s)"
for index in "${!failed_files[@]}"; do
  file="${failed_files[index]}"
  say "- ${file}"
  junit times "${file}" "${out}"/attempt-1/process-*/junit.xml | while IFS=$'\t' read -r ms verdict name; do
    # An `if`, not `[[ ]] && say`: that form returns 1 when the LAST test of the file passed, and pipefail + errexit
    # would kill the script mid-summary.
    if [[ ${verdict} == FAIL ]]; then say "    attempt 1: ${ms} ms FAIL  ${name}"; fi
  done
done

if [[ ${report_only} == true ]]; then
  say "⚠ perf: ${failed_tests} over budget (report-only on PRs)"
  say "perf-failed: ${failed_files[*]}"
  echo "::warning title=Performance Tests (report-only on PRs)::${failed_tests} over budget in ${#failed_files[@]} file(s): ${failed_files[*]}"
  slowest
  exit 0
fi

# BLOCKING: one re-run of just the failing files, one process per file (nothing else on the runner while it is timed).
say "↻ perf: re-running ${#failed_files[@]} failing file(s) once, one process each"
twice=()
flaked=()
for index in "${!failed_files[@]}"; do
  file="${failed_files[index]}"
  dir="${out}/attempt-2/file-${index}"
  mkdir -p "${dir}"
  status=0
  "${runner}" "${dir}" "./${file}" || status=$?
  echo "──── perf re-run: ${file} ────"
  cat "${dir}/console.log" 2>/dev/null || true
  say "- ${file}: re-run $([[ ${status} -eq 0 ]] && echo 'PASSED' || echo "FAILED (exit ${status})")"
  junit times "${file}" "${dir}/junit.xml" | while IFS=$'\t' read -r ms verdict name; do
    say "    attempt 2: ${ms} ms ${verdict}  ${name}"
  done
  if [[ ${status} -eq 0 ]]; then flaked+=("${file}"); else twice+=("${file}"); fi
done

[[ ${#flaked[@]} -gt 0 ]] && say "perf-flaked (failed once, passed on the re-run): ${flaked[*]}"
slowest
if [[ ${#twice[@]} -gt 0 ]]; then
  say "perf-failed: ${twice[*]}"
  echo "::error title=Performance Tests::failed twice in a row on main: ${twice[*]}" >&2
  echo "❌ perf tests failed twice: ${twice[*]}" >&2
  exit 1
fi
say "✅ perf tests passed (after one re-run of ${#flaked[@]} file(s))"
