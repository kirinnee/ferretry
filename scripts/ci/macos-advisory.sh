#!/usr/bin/env bash
set -euo pipefail

# The summary of the realworld workflow's macOS jobs on a PULL REQUEST, where they are advisory: a runner
# that never came (the job cancelled with no step run) is written down, never turned into a red check.
# Reads NEEDS (`toJSON(needs)` of the macOS jobs). A job that ran and failed is masked by its own
# `continue-on-error`, so GitHub reports it here as a success: its failed step stays in the job's log, and
# `Realworld` never gates a pull request (docs/standards/ci-cd, "Release gating"). Always exits 0.

needs="${NEEDS:?NEEDS (toJSON(needs)) is required}"
summary="${GITHUB_STEP_SUMMARY:-/dev/stdout}"

unavailable="$(jq -r '[to_entries[] | select(.value.result == "cancelled") | .key] | join(", ")' <<<"${needs}")"

if [[ -n ${unavailable} ]]; then
  printf '%s\n\n%s\n' "macOS runner not available; advisory on PRs" "Cancelled without a result: ${unavailable}. GitHub's macOS pool gave these jobs no runner; nothing failed. \`main\` and the nightly run them and file an issue if they fail." >>"${summary}"
  echo "::warning::macOS runner not available; advisory on PRs (${unavailable})"
else
  echo "macOS jobs: nothing to report"
fi
