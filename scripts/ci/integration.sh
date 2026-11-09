#!/usr/bin/env bash
set -euo pipefail

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"
./scripts/ci/setup.sh
export FY_CI_SETUP_DONE=1
mapfile -t groups < <(jq -r '.int[].name' config/test-groups.json)
# A tier with no group holds no test file: scripts/validate/test-tiers.sh refuses an integration test that
# no group would run. So an empty list is the honest "nothing to run yet", never a skipped suite.
if [[ ${#groups[@]} -eq 0 ]]; then
  echo "✅ No integration test group is configured and no integration test exists yet: nothing to run" |
    tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
  exit 0
fi
./scripts/ci/warm-chrome.sh
export FY_CI_CHROME_WARM=1
rm -rf coverage/int/groups
status=0
# test.sh writes each group's own LCOV/config. Its swept.sh makes a unique /tmp/fyt.* root,
# sealed HOME, Chrome profiles and tmux sockets; ports are OS-assigned (test-tiers contract).
./scripts/ci/parallel.sh coverage/ci/int 6 ./scripts/ci/test.sh int -- "${groups[@]}" || status=1
./scripts/ci/coverage-ledger.sh int --groups coverage/int/groups || status=1
# THE GUARANTEE PROOF (redesign §10.5), integration half: the rows with a test in tests/integration/ passed in the
# JUnit reports this job just wrote (the unit rows are proven by quick.sh from the unit reports). Only the `guarantees` check
# runs here: `guarantee-owner` reads source alone and quick.sh already judges it.
# STRICT MODE becomes required once `ports-pending.json` is empty: add `--strict` here too (see quick.sh).
bun scripts/validate/guarantees.ts --tier int --results coverage/int || status=1
bun scripts/validate/parity-ticks.ts --tier int --results coverage/int || status=1
exit "${status}"
