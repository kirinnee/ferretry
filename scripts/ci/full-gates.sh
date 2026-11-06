#!/usr/bin/env bash
set -euo pipefail

./scripts/ci/setup.sh
export FY_CI_SETUP_DONE=1
# Format is not here: Quick runs the all-files treefmt check on this same SHA and is in the verdict's needs.
status=0
mapfile -t hooks < <(bun scripts/ci/gate-hooks.ts full)
# Knip needs more than 4GB; keep its two modes serial on this job's 4x8 PR runner.
./scripts/ci/parallel.sh coverage/ci/full-gates 1 ./scripts/ci/gate-hook.sh -- "${hooks[@]}" || status=1
exit "${status}"
