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
  # The strict-guarantee report (ci.yaml `FY_STRICT_GUARANTEES_BLOCKING`, the workflow env this script inherits) is
  # report-only while the switch is 'false': whatever that job ends as (a failed setup step, the timeout) cannot turn
  # Full CI red. Once the switch is 'true' it must succeed like every other job.
  proof_reused=false
  # Proof reuse on main (scripts/ci/proof-reuse.sh): a push whose tree the merged pull request already
  # proved with the whole set. Only a `push` may say so, and it is honoured only with a URL to show for it.
  if [[ ${PROOF_REUSED:-} == true ]]; then
    # Same predicate as every job in ci.yaml: `proved` counts only when the proof job SEALED its decision
    # (`decided`, written by its last step). A job that wrote proved=true and then died is not a proof.
    if [[ ${PROOF_DECIDED:-} == true && ${EVENT_NAME:-} == push && -n ${PROOF_URL:-} ]]; then
      proof_reused=true
    else
      echo "⚠️ PROOF_REUSED=true ignored: only a sealed decision on a push with a proof URL may reuse a proof; judging the jobs" >&2
    fi
  fi
  if [[ ${proof_reused} == true ]]; then
    # Belt and braces: the jobs were skipped on purpose, so a failed or cancelled one is something else.
    if jq -e 'all(.[]; .result != "failure" and .result != "cancelled")' <<<"${NEEDS:?job results required}" >/dev/null; then
      state=success
      description="proof reused: this tree already passed the full set in ${PROOF_URL}"
    fi
  elif jq -e --arg macos "${MACOS_SMOKE:-}" --arg event "${EVENT_NAME:-}" --arg strict "${FY_STRICT_GUARANTEES_BLOCKING:-}" '
    . as $needs |
    ["quick", "static", "perf", "int", "full-gates", "compile", "smoke"]
      | all(.[]; $needs[.].result == "success")
    and ($strict == "false" or $needs["strict-guarantees"].result == "success")
    and ($needs["full-pending"].result == "success" or
      ($event != "pull_request" and $needs["full-pending"].result == "skipped"))
    and ($needs["smoke-darwin"].result == "success" or
      (($macos | ascii_downcase) == "skip" and $needs["smoke-darwin"].result == "skipped"))
  ' <<<"${NEEDS:?job results required}" >/dev/null; then
    state=success
    description='quick checks and the full set passed on this commit'
    # Record WHAT was proved: the tree this run's checkout holds. For a pull request that is GitHub's merge
    # commit (github.sha), exactly the tree every job tested, not the PR head's own tree. `main` reads it back
    # (proof-reuse.sh) to skip a second run of the identical suite. No tree is no claim: the status stays
    # success without one and is simply never reused.
    if [[ ${EVENT_NAME:-} == pull_request ]]; then
      if tested_tree="$(git rev-parse 'HEAD^{tree}' 2>/dev/null)" && [[ ${tested_tree} =~ ^[0-9a-f]{40}$ ]]; then
        description="${description}; tree ${tested_tree}"
      else
        echo "⚠️ could not read the tested tree; the status carries none and main will not reuse it" >&2
      fi
    fi
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
  if jq -e 'del(.proof) | any(.[]; .result == "failure")' <<<"${NEEDS}" >/dev/null; then
    remove_label=true
  elif jq -e 'del(.proof) | any(.[]; .result == "cancelled")' <<<"${NEEDS}" >/dev/null; then
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
