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
  # Only the documented optional skips pass: Full CI Pending on a non-PR run, and the darwin smoke under
  # the owner's MACOS_SMOKE=skip switch. The reusable darwin verdict already owns PR advisory policy.
  if jq -e --arg macos "${MACOS_SMOKE:-}" --arg event "${EVENT_NAME:-}" '
    . as $needs |
    ["quick", "int", "full-gates", "compile", "smoke"]
      | all(.[]; $needs[.].result == "success")
    and ($needs["full-pending"].result == "success" or
      ($event != "pull_request" and $needs["full-pending"].result == "skipped"))
    and ($needs["smoke-darwin"].result == "success" or
      (($macos | ascii_downcase) == "skip" and $needs["smoke-darwin"].result == "skipped"))
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
  # `Full CI` is the merge gate and belongs to a pull request's own run. A `main` push or a dispatch (even
  # one on a PR branch, which proves the branch alone and not its merge with main) only exits with the
  # verdict: posting it onto the PR head would let a late green dispatch overwrite a red pull_request run.
  if [[ ${EVENT_NAME:-} != pull_request ]]; then
    [[ ${state} != failure ]]
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
# by skipped jobs does not remove the label. Re-adding `full-ci` on the SAME head cancels this run and
# starts another: that cancellation is no failure, so a cancelled job alone is ignored when a newer run of
# this workflow exists for the same head SHA. A real `failure` always counts.
remove_label=false
if [[ ${mode} == verdict && ${state} == failure && ${EVENT_NAME:-} == pull_request ]]; then
  if jq -e 'any(.[]; .result == "failure")' <<<"${NEEDS}" >/dev/null; then
    remove_label=true
  elif jq -e 'any(.[]; .result == "cancelled")' <<<"${NEEDS}" >/dev/null; then
    newer_run="$(gh api "repos/${GITHUB_REPOSITORY}/actions/runs?head_sha=${HEAD_SHA}&event=pull_request&per_page=100" \
      --jq "any(.workflow_runs[]; .id > ${GITHUB_RUN_ID} and .name == \"${GITHUB_WORKFLOW:-CI}\")")"
    [[ ${newer_run} == true ]] || remove_label=true
  fi
fi
if [[ ${remove_label} == true ]]; then
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
