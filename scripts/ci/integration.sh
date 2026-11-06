#!/usr/bin/env bash
set -euo pipefail

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"
./scripts/ci/setup.sh
export FY_CI_SETUP_DONE=1
./scripts/ci/warm-chrome.sh
export FY_CI_CHROME_WARM=1
mapfile -t groups < <(jq -r '.int[].name' config/test-groups.json)
rm -rf coverage/int/groups
status=0
# test.sh writes each group's own LCOV/config. Its swept.sh makes a unique /tmp/fyt.* root,
# sealed HOME, Chrome profiles and tmux sockets; ports are OS-assigned (test-tiers contract).
./scripts/ci/parallel.sh coverage/ci/int 6 ./scripts/ci/test.sh int -- "${groups[@]}" || status=1
./scripts/ci/coverage-ledger.sh int --groups coverage/int/groups || status=1
exit "${status}"
