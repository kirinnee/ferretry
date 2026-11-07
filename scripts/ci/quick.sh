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

# One install before the children. The caller enters the dev shell (including hooks) once.
./scripts/ci/setup.sh
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
mapfile -t groups < <(jq -r '.unit[].name | "unit-" + .' config/test-groups.json)
rm -rf coverage/unit/groups
status=0
limit=${FY_CI_QUICK_PARALLEL:-2}
[[ ${limit} =~ ^[1-9][0-9]*$ ]] || {
  echo "❌ FY_CI_QUICK_PARALLEL must be a positive integer" >&2
  exit 2
}
[[ ${CI:-} != true && ${limit} -gt 2 ]] && limit=2
# First measurement doubled the archive test from its separate-run ~3.4s baseline to 8.37s.
# Finish the complete unit tier before starting static/build CPU work; never raise timeouts.
./scripts/ci/parallel.sh coverage/ci/quick "${limit}" ./scripts/ci/quick.sh --part -- "${groups[@]}" || status=1
bun scripts/ci/unit-timings.ts || status=1
# Judge even a red run: a missing group or uncovered source is reported alongside test failures.
./scripts/ci/coverage-ledger.sh unit --groups coverage/unit/groups || status=1
./scripts/ci/parallel.sh coverage/ci/quick/static "${limit}" ./scripts/ci/quick.sh --part -- format gates build scripts || status=1
exit "${status}"
