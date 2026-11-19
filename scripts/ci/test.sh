#!/usr/bin/env bash
set -euo pipefail

# Tests run offline: no booted daemon follows the published model catalog, asks the hosted relay directory
# or checks for updates.
export FY_MODEL_CATALOG="${FY_MODEL_CATALOG:-off}"
export FY_LOCAL_MODELS="${FY_LOCAL_MODELS:-off}"
export FY_RELAY_DIRECTORY_ORIGIN="${FY_RELAY_DIRECTORY_ORIGIN:-off}"
export FY_UPDATE_CHECK="${FY_UPDATE_CHECK:-off}"

mode="${1:-}"
group="${2:-}"
[[ ${mode} != "unit" && ${mode} != "int" && ${mode} != "sit" && ${mode} != "realworld" && ${mode} != "perf" ]] && echo "❌ usage: $0 <unit|int|sit|realworld|perf> [group]" >&2 && exit 2
[[ (${mode} == "realworld" || ${mode} == "perf") && -n ${group} ]] && echo "❌ the ${mode} tier has no groups" >&2 && exit 2

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

./scripts/ci/setup.sh
./scripts/validate/pinned-toolchain.sh
# The hosts and the test host import the git-ignored generated registries: regenerate them first.
./scripts/local/gen.sh

# How many test files a tier directory holds across every workspace package (any depth).
tier_file_count() {
  find packages -path '*/node_modules' -prune -o -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) -path "*/tests/$1/*" -print | wc -l | tr -d ' '
}
# A whole-tier run (realworld, SIT) with no test file at all says so and passes, out loud in the job summary:
# Bun fails a run that matches nothing, and a tier nobody has written yet is not a failing tier. The day the
# first file lands, the tier runs it.
empty_tier() {
  echo "⚠️ the $1 tier holds no test file yet (packages/**/tests/$2/): nothing to run" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
  exit 0
}
if [[ ${mode} == "realworld" ]]; then
  # THE REALWORLD TIER (bunfig.realworld.toml): machine-dependent tests, swept like every other tier but
  # with no ledger, no quarantine and no rerun — a failure here files an issue, it never gates anything.
  [[ "$(tier_file_count realworld)" -eq 0 ]] && empty_tier realworld realworld
  mkdir -p coverage/realworld
  echo "🧪 Running realworld tests..."
  set +e
  ./scripts/test/swept.sh bun test --config=bunfig.realworld.toml --timeout 120000 --reporter=junit --reporter-outfile=coverage/realworld/junit.xml 2>&1 | tee coverage/realworld/console.log
  realworld_status=${PIPESTATUS[0]}
  set -e
  [[ ${realworld_status} -ne 0 ]] && echo "❌ realworld tests failed (exit ${realworld_status})" >&2 && exit "${realworld_status}"
  echo "✅ realworld tests passed"
  exit 0
fi
if [[ ${mode} == "perf" ]]; then
  # THE PERF TIER (bunfig.perf.toml): every speed or size budget, in its own CI job (`perf`) with nothing but perf
  # tests on the runner. FY_CI_PERF_PARALLEL bun processes (default 1; CI sets it to HALF the runner's vCPUs, so every
  # process keeps a spare core for its GC and JIT threads and a budget measures the code, not a neighbour). No ledger,
  # so the files are dealt one by one, round robin in path order: the same split on every run. The runner, its
  # verdict (REPORT-ONLY on a pull request, BLOCKING with one re-run of the failing files on main) and its summary
  # live in scripts/ci/perf-tier.sh; this branch only enumerates the files.
  # ONE enumeration, status-checked: a failing `find` must never read as an empty tier (nothing would run, green).
  perf_list="$(mktemp)"
  if ! { find packages -path '*/node_modules' -prune -o -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) -path '*/tests/perf/*' -print | sort; } >"${perf_list}"; then
    echo "❌ could not enumerate the perf test files (find or sort failed)" >&2 && rm -f "${perf_list}" && exit 1
  fi
  mapfile -t perf_files <"${perf_list}"
  rm -f "${perf_list}"
  [[ ${#perf_files[@]} -eq 0 ]] && empty_tier perf perf
  exec ./scripts/ci/perf-tier.sh "${perf_files[@]}"
fi
# THE REPOSITORY CONTRACTS ARE NOT CHECKED HERE. Pages config, the hosted relay config, macOS relevance and
# the test tiers each have a pre-commit hook, and Quick's gates part runs every hook over every file on
# every pull request and `main` push (pages-config also runs in `Build Checks`). Running them again here
# cost ~23 s in each of the ten test jobs (13.6 s of macOS relevance alone) to prove nothing about tests.

# The per-test budget, ON THE COMMAND LINE. `[test] timeout` in a bunfig is ignored by
# Bun, so a tier that needs longer than the 5-second default has to say so here. The
# unit tier deliberately keeps the default: a unit test that needs two minutes is a unit
# test that is doing something else.
timeout_flag=()
if [[ ${mode} != "unit" ]]; then
  timeout_flag=(--timeout 120000)
fi

if [[ ${mode} == "sit" ]]; then
  [[ -d dist/bin ]] && chmod -R +x dist/bin
  [[ -n ${CLI_BIN:-} ]] && chmod +x "${CLI_BIN}"
  [[ "$(tier_file_count sit)" -eq 0 ]] && empty_tier sit sit
  echo "🧪 Running sit tests..."
  SIT_DRIVER=binary ./scripts/test/swept.sh bun test --config=bunfig.sit.toml "${timeout_flag[@]}"
  echo "✅ sit tests passed"
  exit 0
fi

config="bunfig.${mode}.toml"
coverage_file="coverage/${mode}/lcov.info"
files=()

# A TEST GROUP (config/test-groups.json) runs one share of the tier's files, so CI can run the
# shares on parallel runners. Each test file belongs to the first group with a prefix of its path.
# A group writes its own ledger and does not judge it: only all the groups together can, which is
# the CI ledger job's `scripts/ci/coverage-ledger.sh`. Without a group the whole tier runs here
# serially and is judged here, exactly as before.
if [[ -n ${group} ]]; then
  groups="config/test-groups.json"
  # The group's files (and the changed-plugin scope's narrowing of them) are group-files.sh's.
  # group-files.sh's status is CARRIED, never inferred from its output: it exits 0 with no file only for a group the
  # scope emptied, and exits non-zero (with the reason) for everything else, a crashed filter included.
  group_list="$(mktemp)"
  group_status=0
  ./scripts/ci/group-files.sh "${mode}" "${group}" >"${group_list}" || group_status=$?
  [[ ${group_status} -ne 0 ]] && echo "❌ ${mode} test group ${group}: group-files.sh failed (exit ${group_status})" >&2 && rm -f "${group_list}" && exit "${group_status}"
  mapfile -t files <"${group_list}"
  rm -f "${group_list}"
  coverage_file="coverage/${mode}/groups/${group}/lcov.info"
  if [[ ${#files[@]} -eq 0 ]]; then
    # group-files.sh succeeded with no file: only a SCOPED unit run can do that. Leave an empty ledger and a marker, so
    # the ledger and the timings report the group as scoped out instead of missing.
    if [[ ${mode} == unit && -n ${FY_CI_SCOPE_FILE:-} ]]; then
      mkdir -p "${coverage_file%/*}"
      : >"${coverage_file}"
      echo "scoped out" >"${coverage_file%/*}/scoped-out"
      echo "📝 ${mode} test group ${group}: scoped out, nothing to run"
      exit 0
    fi
    echo "❌ ${mode} test group ${group} holds no test files" >&2 && exit 1
  fi
  # `--coverage-dir` loses to the bunfig's `coverageDir`, so the group gets a copy that names its own.
  config="coverage/${mode}/groups/${group}/bunfig.toml"
  mkdir -p "${config%/*}"
  sed "s|^coverageDir = .*|coverageDir = \"${coverage_file%/*}\"|" "bunfig.${mode}.toml" >"${config}"
  echo "🧪 ${mode} test group ${group}: ${#files[@]} files"
  # A group may run its files in more than one bun process INSIDE its one runner ("processes" in
  # config/test-groups.json). The owner's last resort for a group that cannot get under two minutes by
  # faster tests alone: no new job, every test still blocking. See run_processes below for the isolation.
  processes="$(jq -r --arg mode "${mode}" --arg group "${group}" '.[$mode][] | select(.name == $group) | .processes // 1' "${groups}")"
  # A group that has been cleaned of leaks turns a DOM leak guard from "clean up" into "fail" (the app's test preload reads it).
  [[ "$(jq -r --arg mode "${mode}" --arg group "${group}" '.[$mode][] | select(.name == $group) | .leakGuard // false' "${groups}")" == "true" ]] && export FY_DOM_LEAK_GUARD=enforce
fi

# The integration tier starts real Chromes, and the first one on a fresh runner is slow — paid once
# here rather than inside whichever test happens to start it (see the script).
[[ ${mode} == "int" && ${FY_CI_CHROME_WARM:-} != 1 ]] && ./scripts/ci/warm-chrome.sh

echo "🧪 Running ${mode} tests with coverage..."
rm -f "${coverage_file}"

coverage_dir="${coverage_file%/*}"
mkdir -p "${coverage_dir}"
# A TEST PROCESS THAT DIED: it ended non-zero and wrote no JUnit report, so it never reached its summary (a signal,
# the kernel's OOM killer, a crash, a stray process.exit). Before this the only line was quarantine.ts's
# "no JUnit report", and the status became its 2: on 2026-11-19 the kernel group died that way three times in
# private-files-pinned.test.ts and the log said neither the signal nor the memory. Say how it ended, the last file
# and test it printed, and what the memory cgroup counted, so the next one is diagnosable from the log alone.
say_how_it_died() {
  local status=$1 log=$2 how
  how="exit ${status}"
  if ((status > 128 && status < 160)); then
    how="exit ${status} = signal SIG$(kill -l $((status - 128)) 2>/dev/null || echo "$((status - 128))")"
  fi
  [[ ${status} -eq 124 ]] && how="exit 124 = stalled: stall-watch.ts killed it (see STALLED above)"
  {
    echo "❌ ${mode} test process died before writing its JUnit report: ${how}"
    echo "   last file it started: $(grep -a -E '\.test\.tsx?:$' "${log}" | tail -1)"
    echo "   last test it printed: $(grep -a -E '\((pass|fail|skip|todo)\)' "${log}" | tail -1 | cut -c1-300)"
    [[ ${status} -eq 137 ]] &&
      echo "   SIGKILL with no crash report and no STALLED line is almost always the kernel's OOM killer: the runner ran out of memory."
    # cgroup v2: this job's memory events (oom_kill counts every OOM kill in it, the host's own included) and what is left.
    local cgroup
    cgroup="$(sed -n 's|^0::||p' /proc/self/cgroup 2>/dev/null || true)"
    [[ -n ${cgroup} && -r /sys/fs/cgroup${cgroup}/memory.events ]] &&
      echo "   memory.events of ${cgroup}: $(tr '\n' ' ' <"/sys/fs/cgroup${cgroup}/memory.events")"
    [[ -r /proc/meminfo ]] && echo "   now: $(grep -E '^(MemTotal|MemAvailable):' /proc/meminfo | tr -s ' ' | tr '\n' ' ')"
  } >&2
}

# ONE PROCESS: the files run in one bun process, its ledger at ${coverage_file}.
run_one() {
  local run_config=$1 run_dir=$2
  shift 2
  set +e
  ./scripts/test/swept.sh bun scripts/test/stall-watch.ts "${FY_TEST_STALL_SECONDS:-300}" -- bun test --config="${run_config}" "${timeout_flag[@]}" --coverage --reporter=junit --reporter-outfile="${run_dir}/junit.xml" "$@" 2>&1 | tee "${run_dir}/console.log"
  local status=${PIPESTATUS[0]}
  if [[ ${status} -ne 0 && ! -s "${run_dir}/junit.xml" ]]; then
    # Nothing to rescue without a report: keep the process's own status, never quarantine's generic 2.
    say_how_it_died "${status}" "${run_dir}/console.log"
    set -e
    return "${status}"
  fi
  ./scripts/test/swept.sh bun scripts/ci/quarantine.ts "${mode}" "${status}" "${run_config}" "${run_dir}" "${run_dir}/console.log" "${timeout_flag[@]}"
  status=$?
  set -e
  return "${status}"
}

# SEVERAL PROCESSES, each wholly isolated from the others. Every one runs under its own `swept.sh`, so
# it has its own TMPDIR, HOME and leak sweep; every test already makes its homes under TMPDIR, binds
# ports the OS chooses (scripts/validate/test-tiers.sh holds that) and keeps its tmux sockets in its own
# home, so two processes share no file, port or tmux server. Each process writes its own LCOV; the group's
# ledger is their concatenation, which coverage-ledger.sh judges per file exactly as it judges groups: a
# source file must reach 100% inside ONE process, so one package never spans two
# processes: files are split by package (scripts/test/partition-files.ts), the same on every run.
run_processes() {
  local count=$1
  shift
  local -a pids=()
  local index
  for ((index = 0; index < count; index++)); do
    local part_dir="${coverage_dir}/process-${index}"
    mkdir -p "${part_dir}"
    local part_config="${part_dir}/bunfig.toml"
    sed "s|^coverageDir = .*|coverageDir = \"${part_dir}\"|" "${config}" >"${part_config}"
    local -a part_files=()
    mapfile -t part_files < <(bun scripts/test/partition-files.ts "${count}" "$@" | awk -v share="${index}" '$1 == share { print $2 }')
    echo "🧪 process ${index}: ${#part_files[@]} files"
    run_one "${part_config}" "${part_dir}" "${part_files[@]}" >"${part_dir}/process.log" 2>&1 &
    pids+=($!)
  done
  local status=0
  for ((index = 0; index < count; index++)); do
    wait "${pids[index]}" || status=$?
    echo "──── process ${index} ────"
    cat "${coverage_dir}/process-${index}/process.log"
  done
  cat "${coverage_dir}"/process-*/lcov.info >"${coverage_file}" 2>/dev/null || true
  return "${status}"
}

set +e
# `swept.sh` gives each run its own TMPDIR and FERRETRY_TEST=1, and fails it if a tmux server outlives
# it — see the script. The quarantine rerun below is a second run, so it is swept on its own.
# `stall-watch.ts` kills a run that has printed nothing for FY_TEST_STALL_SECONDS — over twice the
# per-test budget, so only a wedged test or a run that will not exit — and says which threads and
# processes it held; a test whose main thread is stuck cannot fire its own timeout. See the script.
# A red run whose every failure is a quarantined flake reruns those files once, and its exit is the
# run's from here on: 0 when green or rescued, the original status otherwise — see the script.
if [[ ${processes:-1} -gt 1 ]]; then
  run_processes "${processes}" "${files[@]}"
else
  run_one "${config}" "${coverage_dir}" "${files[@]}"
fi
test_status=$?
set -e

if [[ -n ${group} ]]; then
  # Present but possibly EMPTY: a group whose suites load no in-scope source has nothing to report.
  [[ ! -f ${coverage_file} ]] && echo "❌ No coverage artifact found at ${coverage_file}" >&2 && exit 1
  echo "✅ ${mode} test group ${group} wrote its ledger: ${coverage_file} (judged with the other groups' by scripts/ci/coverage-ledger.sh)"
else
  ./scripts/ci/coverage-ledger.sh "${mode}" "${coverage_file}"
fi
[[ ${test_status} -ne 0 ]] && echo "❌ ${mode} tests failed (exit ${test_status})" >&2 && exit "${test_status}"
echo "✅ ${mode} tests passed"
