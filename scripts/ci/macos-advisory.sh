#!/usr/bin/env bash
set -euo pipefail

# The summary of the realworld workflow's macOS jobs on a PULL REQUEST, where they are advisory: they run,
# and a runner that never came (the job cancelled with no step run) or a proof that failed there is
# written down, never turned into a red required check. Reads NEEDS (`toJSON(needs)` of the macOS jobs).
# Always exits 0: the jobs' own checks say what happened, and `Realworld` never gates a pull request
# (docs/standards/ci-cd, "Release gating").

needs="${NEEDS:?NEEDS (toJSON(needs)) is required}"
summary="${GITHUB_STEP_SUMMARY:-/dev/stdout}"

unavailable="$(jq -r '[to_entries[] | select(.value.result == "cancelled") | .key] | join(", ")' <<<"${needs}")"
failed="$(jq -r '[to_entries[] | select(.value.result == "failure") | .key] | join(", ")' <<<"${needs}")"

if [[ -n ${unavailable} ]]; then
  printf '%s\n\n%s\n' "macOS runner not available; advisory on PRs" "Cancelled without a result: ${unavailable}. GitHub's macOS pool gave these jobs no runner; nothing failed. \`main\` and the nightly run them and file an issue if they do not." >>"${summary}"
  echo "::warning::macOS runner not available; advisory on PRs (${unavailable})"
fi
if [[ -n ${failed} ]]; then
  printf '%s\n' "Failed on a macOS runner, advisory on PRs: ${failed}. Read the job's log." >>"${summary}"
  echo "::warning::advisory macOS job failed: ${failed}"
fi
if [[ -z ${unavailable} && -z ${failed} ]]; then
  echo "macOS jobs: nothing to report"
fi
