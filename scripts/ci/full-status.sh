#!/usr/bin/env bash
set -euo pipefail

mode=${1:?pending, verdict or judge required}
state=pending
description='full set not run on this commit: add the full-ci label'
case "${mode}" in
pending) ;;
verdict | judge)
  state=failure
  description='one or more checks in the full set did not succeed'
  # Only the documented optional skips pass. In particular, failed relevance cannot turn skipped
  # downstream jobs into a green gate. The reusable darwin verdict already owns PR advisory policy.
  if jq -e --arg macos "${MACOS_SMOKE:-}" --arg event "${EVENT_NAME:-}" '
    . as $needs |
    ["quick", "int", "full-gates", "compile", "sit", "smoke", "pwa-relevance", "relevance", "summary"]
      | all(.[]; $needs[.].result == "success")
    and ($needs["full-pending"].result == "success" or
      ($event != "pull_request" and $needs["full-pending"].result == "skipped"))
    and ($needs["pwa-screenshot"].result == "success" or
      ($needs["pwa-relevance"].outputs.run == "false" and $needs["pwa-screenshot"].result == "skipped"))
    and ($needs["smoke-darwin"].result == "success" or
      (($macos | ascii_downcase) == "skip" and $needs["smoke-darwin"].result == "skipped"))
    and ($needs.journeys.result == "success" or
      ($needs.relevance.result == "success" and $needs.relevance.outputs.run == "false" and $needs.journeys.result == "skipped"))
  ' <<<"${NEEDS:?job results required}" >/dev/null; then
    state=success
    description='quick checks and the full set passed on this commit'
  fi
  printf 'Full CI: %s — %s\n' "${state}" "${description}" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
  # Read-only fixture mode, also usable to diagnose a saved needs document.
  if [[ ${mode} == judge ]]; then
    [[ ${state} == success ]]
    exit $?
  fi
  ;;
*) echo "❌ usage: $0 pending|verdict|judge" >&2 && exit 2 ;;
esac

gh api --method POST "repos/${GITHUB_REPOSITORY:?repository required}/statuses/${HEAD_SHA:?head SHA required}" \
  -f context='Full CI' -f state="${state}" -f description="${description}" \
  -f target_url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID:?run id required}" >/dev/null

# A failed proof turns the expensive tier off for fix pushes. A job that ended `cancelled` while the PR
# head is still the tested SHA is a timeout or a manual cancel, so it counts as a real failure here; a
# superseding push changes the head and is caught by the current-head check below. A failure caused only
# by skipped jobs does not remove the label.
if [[ ${mode} == verdict && ${state} == failure && ${EVENT_NAME:-} == pull_request ]] &&
  jq -e 'any(.[]; .result == "failure" or .result == "cancelled")' <<<"${NEEDS}" >/dev/null; then
  current_head="$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER:?PR number required}" --jq .head.sha)"
  if [[ ${current_head} == "${HEAD_SHA}" ]]; then
    # Read labels first: deleting an already absent label is a 404, not another failed gate.
    if [[ "$(gh api "repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/labels" --jq 'any(.[]; .name == "full-ci")')" == true ]]; then
      gh api --method DELETE "repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/labels/full-ci" >/dev/null
      echo "📝 Removed full-ci after a failed full set; fix pushes run Quick until relabeled"
    fi
  fi
fi
[[ ${state} != failure ]]
