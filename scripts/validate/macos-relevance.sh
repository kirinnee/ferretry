#!/usr/bin/env bash
set -euo pipefail

# The macOS jobs of the REALWORLD workflow, which a pull request runs only when their inputs change.
#
# `scripts/ci/macos-relevance.sh` decides, from a pull request's changed files, whether Containment,
# Sandbox Shell (Safari) and the macos-15 leg of Harness Contract have anything to prove. The cost of a
# path list that misses an input is a macOS break that shows up on `main`, one merge later, so the
# lists are held to the scripts the jobs run instead of to a reviewer's memory:
#
#   1. every test path a job runs, and every file those tests import, selects THAT job;
#   2. a docs-only or unrelated change selects none, and the toolchain, the lockfile and the workflows
#      select all three, so the lists cannot silently become "never" or "always";
#   3. `main`, a manual dispatch and any doubt run all three;
#   4. realworld.yaml gates exactly those jobs on the decision, ci.yaml no longer runs them, and CI's
#      Smoke darwin-arm64 stays ungated;
#   5. realworld.yaml's `pull_request.paths` triggers on every input of every job, so a pull request that
#      changes one is never left without the run that would measure it.
#   6. the macOS RUNNER POLICY (section 7 below): macOS is advisory on a pull request, so a runner GitHub
#      never gave a job cannot fail a required check, and required and retried on `main` and a release tag;
#      only the free standard `macos-15` is ever asked for.

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

decider="scripts/ci/macos-relevance.sh"
workflow=".github/workflows/realworld.yaml"
ci_workflow=".github/workflows/ci.yaml"
containment_script="scripts/ci/darwin-confinement.sh"
safari_script="scripts/ci/safari-render-proof.sh"
harness_script="packages/fleet/tests/contract/run.sh"

fail() {
  echo "❌ $*" >&2
  exit 1
}

for required in "${decider}" "${workflow}" "${ci_workflow}" "${containment_script}" "${safari_script}" "${harness_script}"; do
  [ -f "${required}" ] || fail "macOS relevance input is missing: ${required}"
done

tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT

# decide <path>... → prints "containment safari harness" for a pull request that changes exactly them.
decide() {
  local out="${tmp_dir}/out"
  printf '%s\n' "$@" >"${tmp_dir}/files"
  : >"${out}"
  MACOS_RELEVANCE_FILES="${tmp_dir}/files" GITHUB_OUTPUT="${out}" "${decider}" >/dev/null
  printf '%s %s %s' \
    "$(sed -n 's/^containment=//p' "${out}")" "$(sed -n 's/^safari=//p' "${out}")" "$(sed -n 's/^harness=//p' "${out}")"
}

expect() {
  local want="$1" why="$2" got
  shift 2
  got="$(decide "$@")"
  [ "${got}" = "${want}" ] || fail "${why}: expected containment/safari/harness = ${want}, got ${got} (changed: $*)"
}

# A directory a script names is represented by a file inside it.
as_file() { if [ -d "$1" ]; then echo "$1/x.ts"; else echo "$1"; fi; }

# Relative imports of a TypeScript file, resolved to repo-relative paths.
imports_of() {
  local file="$1" spec
  { rg --no-filename --only-matching "from '[.][^']*'" "${file}" || true; } |
    sed -E "s/^from '(.*)'\$/\\1/" |
    while IFS= read -r spec; do
      realpath -m --relative-to="${root_dir}" "$(dirname "${file}")/${spec}"
    done
}

ts_files_under() { git ls-files "$@" | { rg '[.]ts$' || true; }; }

# ─── 1. every input a job's script reads selects that job ───────────────────────────────────────

# expect_job <label> <column 1..3> <path>... — each path, changed alone, must select the job. Every path
# is also recorded in `all_inputs`, which section 5 holds the workflow's `pull_request.paths` to.
all_inputs=()
expect_job() {
  local job="$1" column="$2" path got
  shift 2
  for path in "$@"; do
    [ -e "${path}" ] || fail "${job}: ${path} is read by its script but does not exist; update ${decider}"
    all_inputs+=("$(as_file "${path}")")
    got="$(decide "$(as_file "${path}")" | cut -d' ' -f"${column}")"
    [ "${got}" = true ] || fail "${job}: an input of its script does not select it (changed: ${path}); update ${decider}"
  done
}

mapfile -t containment_paths < <(rg --no-filename --only-matching 'packages/[A-Za-z0-9_./-]+' "${containment_script}" | sort -u)
[ "${#containment_paths[@]}" -ge 5 ] || fail "found only ${#containment_paths[@]} test paths in ${containment_script}; the extraction is stale"
mapfile -t containment_files < <(
  for path in "${containment_paths[@]}"; do
    if [ -d "${path}" ]; then ts_files_under "${path}"; else echo "${path}"; fi
  done
)
mapfile -t containment_imports < <(for file in "${containment_files[@]}"; do imports_of "${file}"; done | sort -u)
expect_job 'Containment (macOS)' 1 "${containment_script}" "${containment_paths[@]}" "${containment_files[@]}" "${containment_imports[@]}"

mapfile -t safari_files < <(ts_files_under packages/pwa/harness/fy-render-safari)
[ "${#safari_files[@]}" -ge 3 ] || fail "found only ${#safari_files[@]} files under packages/pwa/harness/fy-render-safari; the extraction is stale"
mapfile -t safari_imports < <(for file in "${safari_files[@]}"; do imports_of "${file}"; done | sort -u)
expect_job 'Sandbox Shell (Safari)' 2 "${safari_script}" "${safari_files[@]}" "${safari_imports[@]}" packages/pwa/public/_headers

mapfile -t harness_files < <(ts_files_under packages/fleet/tests/contract packages/daemon/tests/contract)
[ "${#harness_files[@]}" -ge 5 ] || fail "found only ${#harness_files[@]} contract files; the extraction is stale"
mapfile -t harness_imports < <(for file in "${harness_files[@]}"; do imports_of "${file}"; done | sort -u)
verified_file="$(rg --no-filename --only-matching 'packages/protocol/src/lib/harness-update[.]ts' "${harness_script}" | head -n 1)"
[ -n "${verified_file}" ] || fail "${harness_script} no longer names the file that holds VERIFIED_HARNESS_VERSIONS"
expect_job 'Harness Contract (macos-15)' 3 "${harness_script}" "${harness_files[@]}" "${harness_imports[@]}" "${verified_file}"

# ─── 2. the lists are neither "never" nor "always" ──────────────────────────────────────────────

expect 'false false false' 'documentation only' docs/standards/ci-cd/index.md README.md
expect 'false false false' 'a PWA feature unrelated to the sandbox shell' packages/pwa/src/features/settings/capability-list.tsx
expect 'false false false' 'a daemon route unrelated to the file viewer' packages/daemon/src/lib/grants/policy.ts
expect 'false false false' 'the CI workflow no longer runs these jobs' .github/workflows/ci.yaml .github/workflows/e2e.yaml
for always in flake.lock flake.nix nix/pre-commit.nix .github/workflows/realworld.yaml .github/actions/install-nix/action.yml bun.lock bunfig.realworld.toml; do
  expect 'true true true' "the toolchain, the lockfile or a workflow changed (${always})" "${always}"
done
expect 'true false false' 'only the containment script changed' scripts/ci/darwin-confinement.sh
expect 'false true false' 'only the Safari script changed' scripts/ci/safari-render-proof.sh
expect 'true false true' 'a change spanning two jobs selects both' scripts/ci/darwin-confinement.sh packages/fleet/src/index.ts

# ─── 3. main, manual dispatch and any doubt run all three ───────────────────────────────────────

run_with() {
  : >"${tmp_dir}/run-out"
  env "$@" GITHUB_OUTPUT="${tmp_dir}/run-out" "${decider}" >/dev/null
}

all_selected() {
  local what="$1" key
  for key in containment safari harness; do
    grep -qx "${key}=true" "${tmp_dir}/run-out" || fail "${what}: expected ${key}=true"
  done
  grep -qx 'harness_os=\["ubuntu-latest","macos-15"\]' "${tmp_dir}/run-out" || fail "${what}: harness_os must carry macos-15"
}

for event in push workflow_dispatch schedule; do
  run_with -u MACOS_RELEVANCE_FILES GITHUB_EVENT_NAME="${event}"
  all_selected "event ${event}"
done
: >"${tmp_dir}/empty-files"
run_with MACOS_RELEVANCE_FILES="${tmp_dir}/empty-files"
all_selected 'an empty file list'
printf 'README.md\n' >"${tmp_dir}/readme-files"
run_with MACOS_RELEVANCE_FILES="${tmp_dir}/readme-files"
grep -qx 'harness_os=\["ubuntu-latest"\]' "${tmp_dir}/run-out" || fail 'a docs-only change must leave Harness Contract on its Linux leg alone'

# ─── 4. realworld.yaml gates exactly these jobs ────────────────────────────────────────────────────────

job_block() {
  awk -v id="$1" '
    $0 == "  " id ":" { in_job = 1; print; next }
    in_job && /^  [A-Za-z0-9_-]+:$/ { exit }
    in_job { print }
  ' "${workflow}"
}

block_has() {
  local id="$1" pattern="$2" what="$3" block
  block="$(job_block "${id}")"
  [ -n "${block}" ] || fail "${workflow} has no job '${id}'"
  rg -q -- "${pattern}" <<<"${block}" || fail "${workflow}: job '${id}' ${what}"
}

block_has changes 'scripts/ci/macos-relevance[.]sh' 'must run scripts/ci/macos-relevance.sh'
block_has changes 'runs-on: ubuntu-latest' 'must run on GitHub, not Namespace'
block_has darwin-confinement '^    needs: changes$' 'must need changes'
block_has darwin-confinement "^    if: needs[.]changes[.]outputs[.]containment == 'true'\$" 'must run only when containment is true'
block_has safari-sandbox-shell '^    needs: changes$' 'must need changes'
block_has safari-sandbox-shell "^    if: needs[.]changes[.]outputs[.]safari == 'true'\$" 'must run only when safari is true'
block_has harness-contract '^    needs: changes$' 'must need changes'
block_has harness-contract 'os: [$][{][{] fromJSON[(]needs[.]changes[.]outputs[.]harness_os[)] [}][}]' 'must take its os matrix from harness_os'
for moved in changes darwin-confinement safari-sandbox-shell harness-contract; do
  grep -qx "  ${moved}:" "${ci_workflow}" && fail "${ci_workflow}: job '${moved}' belongs in ${workflow}, which no release waits on"
done
if awk '$0 == "  smoke:" { in_job = 1; next } in_job && /^  [A-Za-z0-9_-]+:$/ { exit } in_job { print }' "${ci_workflow}" | rg -q 'changes'; then
  fail "${ci_workflow}: Smoke darwin-arm64 must run on every pull request, not be gated on \`changes\`"
fi
if job_block harness-contract | rg -q '^    if:'; then
  fail "${workflow}: Harness Contract must not carry a job-level if: — its Linux leg always runs; gate the macos-15 leg through \`harness_os\`"
fi

# ─── 5. the workflow triggers on every input ────────────────────────────────────────────────────

mapfile -t trigger_globs < <(awk '
  /^  pull_request:/ { in_pr = 1; next }
  in_pr && /^  [A-Za-z_]+:/ && !/^  pull_request:/ { in_pr = 0 }
  in_pr && /^      - / { sub(/^      - /, ""); gsub(/^'"'"'|'"'"'$/, ""); print }
' "${workflow}")
[ "${#trigger_globs[@]}" -ge 5 ] || fail "found only ${#trigger_globs[@]} pull_request paths in ${workflow}; the extraction is stale"

# A GitHub path glob as a regex: `**` crosses directories, `*` does not.
glob_regex() { sed -e 's/[.]/[.]/g' -e 's#[*][*]#\x01#g' -e 's#[*]#[^/]*#g' -e 's#\x01#.*#g' <<<"$1"; }
triggers_on() {
  local glob
  for glob in "${trigger_globs[@]}"; do
    grep -Eq "^$(glob_regex "${glob}")\$" <<<"$1" && return 0
  done
  return 1
}
for input in "${all_inputs[@]}"; do
  triggers_on "${input}" || fail "${workflow}: a pull request that changes ${input} would not run it; add it to \`on.pull_request.paths\`"
done

# ─── 6. the tmux 3.8 leg ────────────────────────────────────────────────────────────────────────

tmux38_of() {
  local out="${tmp_dir}/out"
  printf '%s\n' "$@" >"${tmp_dir}/files"
  : >"${out}"
  MACOS_RELEVANCE_FILES="${tmp_dir}/files" GITHUB_OUTPUT="${out}" "${decider}" >/dev/null
  sed -n 's/^tmux38=//p' "${out}"
}
for input in packages/daemon/src/lib/tmux/pane-proof.ts packages/daemon/src/adapters/tmux/control-tmux-process.ts \
  packages/daemon/src/adapters/session/lifecycle/tmux-session-exit-observer.ts packages/daemon/src/lib/session/health/exit.ts \
  packages/daemon/tests/integration/tmux/x.test.ts nix/packages.nix flake.lock scripts/ci/test.sh config/test-groups.json; do
  [ "$(tmux38_of "${input}")" = true ] || fail "a pull request that changes ${input} must run the tmux 3.8 leg"
  triggers_on "${input}" || fail "${workflow}: a pull request that changes ${input} would not run the tmux 3.8 leg"
done
for input in docs/x.md packages/pwa/src/x.ts packages/daemon/src/lib/grants/policy.ts; do
  [ "$(tmux38_of "${input}")" = false ] || fail "a pull request that changes only ${input} must not run the tmux 3.8 leg"
done
block_has tmux-38 '^    needs: changes$' 'must need changes'
block_has tmux-38 "^    if: needs[.]changes[.]outputs[.]tmux38 == 'true'\$" 'must run only when tmux38 is true'
block_has tmux-38 'nix develop [.]#ci-tmux38 ' 'must run in the ci-tmux38 shell'

# ─── 7. macOS is advisory on a pull request and required (and retried) on main and a release tag ────

smoke_workflow=".github/workflows/smoke-darwin.yaml"
cd_workflow=".github/workflows/cd.yaml"
[ -f "${smoke_workflow}" ] || fail "${smoke_workflow} is missing"
[ -f "${cd_workflow}" ] || fail "${cd_workflow} is missing"

workflow_job_block() {
  awk -v id="$2" '
    $0 == "  " id ":" { in_job = 1; print; next }
    in_job && /^  [A-Za-z0-9_-]+:$/ { exit }
    in_job { print }
  ' "$1"
}
workflow_job_has() {
  local file="$1" id="$2" pattern="$3" what="$4" block
  block="$(workflow_job_block "${file}" "${id}")"
  [ -n "${block}" ] || fail "${file} has no job '${id}'"
  rg -q -- "${pattern}" <<<"${block}" || fail "${file}: job '${id}' ${what}"
}

# No new spend: the only macOS runner is the free standard `macos-15` of a public repository — never a
# larger, a Namespace or a self-hosted one — and only the files that own a macOS job may use it.
mapfile -t mac_runner_files < <(rg -l -i 'macos|mac-os|darwin.*runs-on' .github/workflows | sort)
for file in "${mac_runner_files[@]}"; do
  case "${file}" in
  .github/workflows/smoke-darwin.yaml | .github/workflows/realworld.yaml | .github/workflows/harness-contract-latest.yaml | .github/workflows/ci.yaml | .github/workflows/cd.yaml) ;;
  *) fail "${file}: a workflow outside the macOS policy mentions macOS; route it through smoke-darwin.yaml or declare it here" ;;
  esac
done
unexpected_macos="$(rg -N --no-filename -v '^[[:space:]]*#' .github/workflows scripts/ci/macos-relevance.sh | rg -o 'macos-[0-9]+[A-Za-z0-9-]*' | rg -v '^macos-15$' || true)"
[ -z "${unexpected_macos}" ] || fail "a macOS runner other than the free standard macos-15 is named: ${unexpected_macos}"
macos_jobs="$(rg -c '^    runs-on: macos-15$' .github/workflows/smoke-darwin.yaml .github/workflows/realworld.yaml | sort | tr '\n' ' ')"
[ "${macos_jobs}" = '.github/workflows/realworld.yaml:2 .github/workflows/smoke-darwin.yaml:3 ' ] ||
  fail "the macOS job inventory changed (smoke-darwin.yaml 3 attempts, realworld.yaml 2 jobs); update this validator and docs/standards/ci-cd together: ${macos_jobs}"
[ "$(rg -c 'os: \[ubuntu-latest, macos-15\]' .github/workflows/harness-contract-latest.yaml)" = 1 ] ||
  fail 'harness-contract-latest.yaml: the macos-15 matrix leg is the only macOS job allowed there'
if rg -n -i 'runs-on:.*(macos-[0-9]+-(large|xlarge|intel)|nscloud-mac|macos-latest-(large|xlarge))|runs-on:.*self-hosted' .github/workflows >/dev/null; then
  fail 'a workflow asks for a paid or self-hosted macOS runner; the macOS pool is the free standard macos-15 only (docs/standards/ci-cd, "macOS runner shortage")'
fi

# The reusable smoke: three attempts, each a bounded `macos-15` job that records that it started, a
# backoff between them that runs only on a pull-request-free, never-started attempt (read from `started`,
# never from `result`: GitHub gives a job it never ran `abandoned`), and one verdict.
for attempt in attempt-1 attempt-2 attempt-3; do
  workflow_job_has "${smoke_workflow}" "${attempt}" '^    runs-on: macos-15$' 'must run on the free macos-15 runner'
  workflow_job_has "${smoke_workflow}" "${attempt}" '^    timeout-minutes: [0-9]+$' 'must state timeout-minutes'
  workflow_job_has "${smoke_workflow}" "${attempt}" 'started=true' 'must record that it started, so the verdict can tell "no runner" from "failed"'
done
for backoff in backoff-1 backoff-2; do
  workflow_job_has "${smoke_workflow}" "${backoff}" "result != 'success' && needs[.]attempt-[12][.]result != 'skipped' && needs[.]attempt-[12][.]outputs[.]started != 'true'" 'must re-queue only an attempt that never started, whatever its result says'
  if workflow_job_block "${smoke_workflow}" "${backoff}" | rg -q "result == 'cancelled'"; then
    fail "${smoke_workflow}: job '${backoff}' must not key on result == 'cancelled': GitHub reports a job it never gave a runner as 'abandoned'"
  fi
done
workflow_job_has "${smoke_workflow}" backoff-1 '!inputs[.]advisory' 'must not retry on an advisory (pull request) run'
workflow_job_has "${smoke_workflow}" verdict 'scripts/ci/macos-smoke-verdict[.]sh' 'must judge through scripts/ci/macos-smoke-verdict.sh'
workflow_job_has "${smoke_workflow}" verdict 'ADVISORY: [$][{][{] inputs[.]advisory [}][}]' 'must pass inputs.advisory to the verdict'
rg -q '^  workflow_call:' "${smoke_workflow}" || fail "${smoke_workflow}: must be a workflow_call"
[ "$(rg -c 'runs-on: macos-' "${smoke_workflow}")" = 3 ] || fail "${smoke_workflow}: exactly three attempts may use a macOS runner"

# ci.yaml: Linux smoke stays a required matrix with no macOS leg; Darwin smoke is advisory only on a pull request.
if workflow_job_block "${ci_workflow}" smoke | rg -v "^[[:space:]]*#" | rg -qi "darwin|macos"; then
  fail "${ci_workflow}: the Linux smoke matrix must not carry a macOS leg; Smoke darwin-arm64 is the smoke-darwin job"
fi
workflow_job_has "${ci_workflow}" smoke-darwin '^    uses: [.]/[.]github/workflows/smoke-darwin[.]yaml$' 'must call smoke-darwin.yaml'
workflow_job_has "${ci_workflow}" smoke-darwin "^      advisory: [\$][{][{] github[.]event_name == 'pull_request' [}][}]\$" 'must be advisory on a pull request and only there'
workflow_job_has "${ci_workflow}" smoke-darwin '^    needs: compile$' 'must need compile'
# The only `if:` it may carry is the owner's switch: unset (or anything but 'skip') runs it on every pull request.
[ "$(workflow_job_block "${ci_workflow}" smoke-darwin | rg -c '^    if:')" = 1 ] || fail "${ci_workflow}: Smoke darwin-arm64 must carry exactly one if:, the vars.MACOS_SMOKE switch, and not be gated on \`changes\`"
workflow_job_has "${ci_workflow}" smoke-darwin "^    if: [\$][{][{] vars[.]MACOS_SMOKE != 'skip' [}][}]\$" "must run unless vars.MACOS_SMOKE is exactly 'skip'"
workflow_job_has "${ci_workflow}" compile "if: [\$][{][{] vars[.]MACOS_SMOKE == 'skip' [}][}]" 'must say, in a job that runs, that the smoke was skipped by the switch'
workflow_job_has "${ci_workflow}" compile 'scripts/ci/macos-smoke-skipped[.]sh' 'must say, in a job that runs, that the smoke was skipped by the switch'

# cd.yaml: a release tag requires the darwin smoke, with its retries, before anything is published.
workflow_job_has "${cd_workflow}" smoke-darwin '^    uses: [.]/[.]github/workflows/smoke-darwin[.]yaml$' 'must call smoke-darwin.yaml'
workflow_job_has "${cd_workflow}" smoke-darwin '^      advisory: false$' 'must be required (advisory: false) on a release tag'
workflow_job_has "${cd_workflow}" smoke-darwin "^    if: [\$][{][{] vars[.]MACOS_SMOKE != 'skip' [}][}]\$" "must run unless vars.MACOS_SMOKE is exactly 'skip'"
workflow_job_has "${cd_workflow}" goreleaser '^    needs: \[compile, smoke-darwin\]$' 'must wait for the compile and the darwin smoke'
# A skipped smoke publishes only through the owner's switch, and never past a failed compile or smoke.
workflow_job_has "${cd_workflow}" goreleaser "^    if: [\$][{][{] !cancelled[(][)] && needs[.]compile[.]result == 'success' && [(]needs[.]smoke-darwin[.]result == 'success' [|][|] [(]vars[.]MACOS_SMOKE == 'skip' && needs[.]smoke-darwin[.]result == 'skipped'[)][)] [}][}]\$" 'must publish only after a green smoke, or a smoke skipped by vars.MACOS_SMOKE=skip, and a green compile'
workflow_job_has "${cd_workflow}" goreleaser 'scripts/ci/macos-smoke-skipped[.]sh' 'must say, in a job that runs, that the smoke was skipped by the switch'
workflow_job_has "${cd_workflow}" sign '^    needs: goreleaser$' 'must wait for goreleaser, so nothing is signed past a skipped publish'

# realworld.yaml: the macOS proofs are advisory on a pull request and unmasked everywhere else; the Linux
# leg of Harness Contract (and of its nightly twin) is never masked.
for job in darwin-confinement safari-sandbox-shell; do
  workflow_job_has "${workflow}" "${job}" "^    continue-on-error: [\$][{][{] github[.]event_name == 'pull_request' [}][}]\$" 'must be advisory on a pull request and only there'
done
workflow_job_has "${workflow}" harness-contract "^    continue-on-error: [\$][{][{] github[.]event_name == 'pull_request' && startsWith[(]matrix[.]os, 'macos'[)] [}][}]\$" 'must mask only its macOS leg, and only on a pull request'
workflow_job_has ".github/workflows/harness-contract-latest.yaml" latest "^    continue-on-error: [\$][{][{] github[.]event_name == 'pull_request' && startsWith[(]matrix[.]os, 'macos'[)] [}][}]\$" 'must mask only its macOS leg, and only on a pull request'
workflow_job_has "${workflow}" macos-advisory 'scripts/ci/macos-advisory[.]sh' 'must say which macOS jobs had no runner'

# The verdict, run on canned results, decides as the doctrine says.
verdict() {
  NEEDS="$1" ADVISORY="$2" GITHUB_STEP_SUMMARY=/dev/null scripts/ci/macos-smoke-verdict.sh >/dev/null 2>&1
}
unstarted='{"attempt-1":{"result":"cancelled","outputs":{}},"attempt-2":{"result":"skipped","outputs":{}},"attempt-3":{"result":"skipped","outputs":{}}}'
verdict "${unstarted}" true || fail "a pull request whose macOS smoke never got a runner must not fail"
verdict "${unstarted}" false && fail "main or a release tag whose macOS smoke never got a runner must fail after its retries"
ran_and_failed='{"attempt-1":{"result":"failure","outputs":{"started":"true"}},"attempt-2":{"result":"skipped","outputs":{}},"attempt-3":{"result":"skipped","outputs":{}}}'
verdict "${ran_and_failed}" true && fail "a macOS smoke that ran and failed must fail, even on a pull request"
# GitHub hands `needs` the word "abandoned" for a job it never gave a runner (run 41856821125), not "cancelled".
abandoned='{"attempt-1":{"result":"abandoned","outputs":{}},"attempt-2":{"result":"skipped","outputs":{}},"attempt-3":{"result":"skipped","outputs":{}}}'
verdict "${abandoned}" true || fail "a pull request whose macOS smoke was abandoned for want of a runner must not fail"
verdict "${abandoned}" false && fail "main or a release tag whose macOS smoke was abandoned for want of a runner must fail after its retries"
failed_unstarted='{"attempt-1":{"result":"failure","outputs":{}},"attempt-2":{"result":"skipped","outputs":{}},"attempt-3":{"result":"skipped","outputs":{}}}'
verdict "${failed_unstarted}" true || fail "a smoke attempt that failed before its first step ran is a runner problem, not a failed smoke"
cut_short='{"attempt-1":{"result":"cancelled","outputs":{"started":"true"}},"attempt-2":{"result":"skipped","outputs":{}},"attempt-3":{"result":"skipped","outputs":{}}}'
verdict "${cut_short}" true || fail "a pull request whose macOS smoke was cut off after it started must not fail"
verdict "${cut_short}" false && fail "main or a release tag whose macOS smoke was cut off after it started must fail"
nothing_ran='{"attempt-1":{"result":"skipped","outputs":{}},"attempt-2":{"result":"skipped","outputs":{}},"attempt-3":{"result":"skipped","outputs":{}}}'
verdict "${nothing_ran}" true && fail "a verdict with no attempt at all must fail, even on a pull request"
failed_after_retry='{"attempt-1":{"result":"abandoned","outputs":{}},"attempt-2":{"result":"failure","outputs":{"started":"true"}},"attempt-3":{"result":"skipped","outputs":{}}}'
verdict "${failed_after_retry}" false && fail "a smoke that ran and failed on a retry must fail"
passed_late='{"attempt-1":{"result":"cancelled","outputs":{}},"attempt-2":{"result":"cancelled","outputs":{}},"attempt-3":{"result":"success","outputs":{"started":"true"}}}'
verdict "${passed_late}" false || fail "a macOS smoke that passes on a retry must pass"

echo "✅ macOS relevance holds: every input of the three optional macOS jobs selects its job, main runs them all, realworld.yaml triggers on each, and macOS is advisory on a pull request and required (and retried) on main and a release tag"
