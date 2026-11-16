#!/usr/bin/env bash
set -euo pipefail

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

# The orchestration invokes this mode for each part. Tests keep the parent's priority;
# formatting, gates and builds yield CPU to them without changing any test budget.
if [[ ${1:-} == --part ]]; then
  part=${2:?quick part required}
  [[ ${part} == unit-* ]] && exec ./scripts/ci/quick-part.sh "${part}"
  exec nice -n 10 ./scripts/ci/quick-part.sh "${part}"
fi

# FY_CI_QUICK_DRY_RUN=1 decides the scope and prints what this run WOULD run, then stops: no install, no test, no gate.
dry_run=0
[[ ${FY_CI_QUICK_DRY_RUN:-} == 1 ]] && dry_run=1

# One install before the children. The caller enters the dev shell (including hooks) once.
[[ ${dry_run} == 1 ]] || ./scripts/ci/setup.sh
export FY_CI_SETUP_DONE=1
export FY_CI_QUICK_GATES=1
# One spelling of the incremental tsc cache directory: the one the workflow's cache action mounts
# (`~/.cache/ferretry-tsc`), derived from ${HOME}. Main deletes it first, so main always re-seeds the
# cache pull requests read from a clean, non-incremental proof. A local run keeps no cache.
if [[ ${CI:-} == true ]]; then
  export FY_TSC_CACHE_DIR="${HOME}/.cache/ferretry-tsc"
  # Empty it rather than remove it: the cache action may have mounted the directory itself.
  if [[ ${FY_CI_MAIN:-} == 1 && -d ${FY_TSC_CACHE_DIR} ]]; then
    find "${FY_TSC_CACHE_DIR}" -mindepth 1 -delete || true
  fi
fi
printf 'Quick cache action hit: %s\n' "${FY_CI_CACHE_HIT:-unknown (no cache action output)}" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"

limit=${FY_CI_QUICK_PARALLEL:-2}
[[ ${limit} =~ ^[1-9][0-9]*$ ]] || {
  echo "❌ FY_CI_QUICK_PARALLEL must be a positive integer" >&2
  exit 2
}
[[ ${CI:-} != true && ${limit} -gt 2 ]] && limit=2

# THE STATIC PARTS - formatting, every pre-commit gate (typecheck included) and the build checks - judge the whole
# tree whatever the scope, and none of them reads a test result. CI runs them as their own job (`Static Checks`,
# `quick.sh --static`) BESIDE the unit tier instead of after it: on one runner they waited ~13 min for the tests and
# then added ~105 s. Unscoped, on every event Quick runs. `quick.sh` alone (a local run) runs both halves in turn.
# `guards` (config/static-tests.txt) runs AFTER the pool, alone: it opens the whole tree's TypeScript program, and
# beside the typecheck gate's tsc it got tsc OOM-killed on the 8x16 (PR 1730 run 43860826531). Both always run;
# the second does not wait for the first to pass.
static_parts=(format gates build)
run_static() {
  local status=0
  ./scripts/ci/parallel.sh coverage/ci/quick/static "${limit}" ./scripts/ci/quick.sh --part -- "${static_parts[@]}" || status=1
  ./scripts/ci/parallel.sh coverage/ci/quick/static/guards 1 ./scripts/ci/quick.sh --part -- guards || status=1
  return "${status}"
}
if [[ ${1:-} == --static ]]; then
  [[ ${dry_run} == 1 ]] && echo "DRY RUN static parts: ${static_parts[*]} guards" && exit 0
  run_static
  exit $?
fi

# THE CHANGED-PLUGIN SCOPE (scripts/ci/scope.ts, docs/standards/ci-cd "Changed-plugin scope"): a pull request into
# rebuild/5.0-after that only touches plugin packages runs those plugins, what depends on them and the platform
# packages' tests. Every other run (a push, main, another base, the full-ci label, any file outside the plugins, any
# doubt) is FULL and unchanged. The decision is printed here, at the top, and in the step summary. `scope.ts decide`
# never fails: whatever goes wrong it writes FULL.
# THE DECLARATION GATE runs first on EVERY run, scoped or not, before anything is filtered: a `// scope-deps:` line that
# names nothing that exists is a failure, never a warning (a bogus declaration would pretend to be an input).
bun scripts/ci/scope.ts check || {
  echo "❌ a scope-deps declaration is wrong (see above); fix it or remove it" >&2
  exit 1
}
scope_file=coverage/ci/scope.json
rm -f "${scope_file}"
bun scripts/ci/scope.ts decide "${scope_file}" || {
  echo "CI scope: FULL - scope.ts crashed. Every unit test runs." | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
  rm -f "${scope_file}"
}
scope_mode="$(jq -r '.mode' "${scope_file}" 2>/dev/null || true)"
if [[ ${scope_mode} == scoped ]]; then
  # Exported so every part (unit test group, ledger) reads the same decision.
  export FY_CI_SCOPE_FILE="${PWD}/${scope_file}"
else
  scope_mode=full
  unset FY_CI_SCOPE_FILE
fi

# THE UNIT TIER RUNS AS SEVERAL GROUPS SIDE BY SIDE (config/test-groups.json, longest first): each group is one bun
# process with its own ledger, judged together below. One group of all 3,398 files took 794 s on one core of the 8x16;
# the groups split it by package and the kernel group (~260 s) is the floor. The repository tooling's own tests
# (`scripts`) are one more part in the same pool, because the guarantee proof below reads their JUnit report.
mapfile -t groups < <(jq -r '.unit[].name | "unit-" + .' config/test-groups.json)
test_parts=("${groups[@]}" scripts)
rm -rf coverage/unit/groups
status=0

# The always-run proofs: whatever the scope, these judge the whole repository. Only the PASS proof of the test-owned
# rows needs every unit test's report, so a scoped run proves those rows by EXISTENCE and says so.
if [[ ${scope_mode} == scoped ]]; then
  guarantee_args=(--strict --tier unit --existence-only)
  parity_args=(--tier unit)
  guarantee_note="guarantees: SCOPED run - rows are proved by test EXISTENCE only (--existence-only); the unit tests of skipped plugins did not run, so their PASS is not proved here"
  ledger_note="coverage ledger: SCOPED - judges the platform packages and the selected plugins only, NOT the complete unit production ledger"
else
  guarantee_args=(--strict --tier unit --results coverage/unit --results coverage/scripts)
  parity_args=(--tier unit --results coverage/unit --results coverage/scripts)
  guarantee_note="guarantees: FULL run - every kept row's test must exist and have PASSED"
  ledger_note="coverage ledger: complete unit production ledger"
fi
if [[ ${dry_run} == 1 ]]; then
  # What this run would do, from the SAME variables the real run uses.
  # The files test.sh would run, from the same script it asks.
  planned=()
  for group in "${groups[@]}"; do
    mapfile -t group_files < <(./scripts/ci/group-files.sh unit "${group#unit-}" 2>/dev/null)
    planned+=("${group_files[@]}")
  done
  echo "DRY RUN scope mode: ${scope_mode}"
  echo "DRY RUN unit groups: ${groups[*]#unit-}"
  echo "DRY RUN unit test files: ${#planned[@]}"
  printf 'DRY RUN unit file %s\n' "${planned[@]}"
  echo "DRY RUN always-run parts: ${static_parts[*]} guards scripts"
  echo "DRY RUN ${guarantee_note}"
  echo "DRY RUN ${ledger_note}"
  echo "DRY RUN check.ts guarantees ${guarantee_args[*]}"
  echo "DRY RUN check.ts parity-ticks ${parity_args[*]}"
  exit 0
fi
# The static parts are NOT in this pool: in CI they are their own job (above), and a test's timing budget is never raised
# to make room for them. Locally (`quick.sh` with no flag) they run after the tests, as before.
./scripts/ci/parallel.sh coverage/ci/quick "${limit}" ./scripts/ci/quick.sh --part -- "${test_parts[@]}" || status=1
bun scripts/ci/unit-timings.ts || status=1
# Judge even a red run: a missing group or uncovered source is reported alongside test failures.
./scripts/ci/coverage-ledger.sh unit --groups coverage/unit/groups || status=1
if [[ ${FY_CI_STATIC_JOB:-} != 1 ]]; then
  run_static || status=1
fi
# THE GUARANTEE PROOF (redesign §10.5): every kept Appendix D row has a test named with its id AND that test passed in the
# unit tier's JUnit reports (the unit groups, and the repository tooling's own `scripts` part). Judged after every part, so a
# red run still reports it, and ANY default-mode finding fails the job. `--tier unit` leaves the rows tested only in the
# integration tier to the integration job (scripts/ci/integration.sh), which judges them from its own report.
# STRICT MODE is required (the count reached 0, merge-bar line 1): `--strict` also checks the rows of the packages still
# pending, which were skipped by design until then, and check.ts passes it to `guarantee-owner` too (enforcer symbols
# and the owner's own suite). integration.sh judges its own tier the same way.
echo "📝 ${guarantee_note}" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
bun scripts/gen/check.ts guarantees "${guarantee_args[@]}" || status=1
# THE TICK PROOF: every `[x]` parity row names a test that exists AND passed in these same reports (integration.sh judges its own tier).
# LOAD-BEARING: a row whose test is under tests/integration/ is skipped here by design and judged only by the integration job, which
# a pull request runs only with the `full-ci` label. Without that label such a tick is not proven by any run; keep the label on
# the rebuild PR (or run integration.sh) before trusting an integration-tier tick.
bun scripts/gen/check.ts parity-ticks "${parity_args[@]}" || status=1
exit "${status}"
