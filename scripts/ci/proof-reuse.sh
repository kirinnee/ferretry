#!/usr/bin/env bash
set -euo pipefail

# Proof reuse on `main` (docs/standards/ci-cd, "Proof reuse on main").
#
# A pull request into `main` is proved by its own `pull_request` run, whose `full` job posts the commit
# status `Full CI` = success on the PR head with the TREE it tested in the description
# (scripts/ci/full-status.sh). When `main`'s push of that PR's merge is a byte-identical tree, re-running the
# same suite proves nothing new. This script decides, for the push run, whether that is the case.
#
# It FAILS CLOSED: proved=true only when every check below holds, and any doubt (an API error, a missing
# field, a mismatch, a malformed value) prints why and writes proved=false, so every job runs as it always
# did. It exits 0 on a decision either way; a crash leaves the outputs unset, which the jobs read as "not
# proved" too (`needs.proof.outputs.proved != 'true'`).
#
#   a. the event is a push to refs/heads/main;
#   b. vars.MACOS_SMOKE is `skip`: a PR's darwin smoke is advisory but main's is required, so with the macOS
#      smoke on the PR proof never covered what main requires;
#   c. T = the tree of this push's commit;
#   d. the commit belongs to exactly one pull request that is merged into `main`; H = its head SHA;
#   e. the newest `Full CI` status on H is success, from github-actions[bot], and names tree T;
#   f. that status points at a run of THIS repository of .github/workflows/ci.yaml, event pull_request, on head
#      H, whose conclusion is success.
#
# Inputs (GitHub's own names): GITHUB_EVENT_NAME GITHUB_REF GITHUB_SHA GITHUB_REPOSITORY GITHUB_SERVER_URL
# GITHUB_OUTPUT GITHUB_STEP_SUMMARY, and GH_TOKEN for `gh`. MACOS_SMOKE is vars.MACOS_SMOKE.

event=${GITHUB_EVENT_NAME:-}
ref=${GITHUB_REF:-}
sha=${GITHUB_SHA:-}
repo=${GITHUB_REPOSITORY:-}
server=${GITHUB_SERVER_URL:-https://github.com}
summary=${GITHUB_STEP_SUMMARY:-/dev/null}
output=${GITHUB_OUTPUT:-/dev/null}

say() { printf '%s\n' "$*" | tee -a "${summary}"; }

# no <reason>: the one way out that is not a yes.
no() {
  say "Proof reuse: NO - $1. Every job runs."
  printf 'proved=false\nproof=\n' >>"${output}"
  exit 0
}

hex40='^[0-9a-f]{40}$'

# a. Only the push to main is ever a candidate.
if [[ ${event} != push || ${ref} != refs/heads/main ]]; then
  no "this is ${event:-an unknown event} on ${ref:-an unknown ref}, not a push to refs/heads/main"
fi
say "- a. push to refs/heads/main: ok"

# b. Main's darwin smoke is required, a PR's is advisory: only with the switch on is the PR proof the same set.
if [[ ${MACOS_SMOKE:-} != [Ss][Kk][Ii][Pp] ]]; then
  no "vars.MACOS_SMOKE is '${MACOS_SMOKE:-}', not 'skip': main's darwin smoke is required and the PR's was advisory"
fi
say "- b. vars.MACOS_SMOKE is skip: ok"

[[ ${repo} =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || no "GITHUB_REPOSITORY '${repo}' is not owner/name"
[[ ${sha} =~ ${hex40} ]] || no "GITHUB_SHA '${sha}' is not a 40-hex commit"

# c. The tree this push is about to prove.
tree="$(git rev-parse "${sha}^{tree}" 2>/dev/null)" || no "cannot read the tree of ${sha}"
[[ ${tree} =~ ${hex40} ]] || no "the tree of ${sha} ('${tree}') is not a 40-hex object"
say "- c. tree of ${sha}: ${tree}"

# d. The merged pull request. Exactly one: a commit that more than one merged PR claims is not a clean
# squash or merge of a single PR, and which head to trust is a guess.
pulls="$(gh api "repos/${repo}/commits/${sha}/pulls")" || no "API error listing the pull requests of ${sha}"
merged="$(jq -c '[.[] | select(.merged_at != null and .base.ref == "main")]' <<<"${pulls}" 2>/dev/null)" ||
  no "the pull requests of ${sha} could not be read"
count="$(jq 'length' <<<"${merged}")"
[[ ${count} == 1 ]] || no "${sha} belongs to ${count} pull requests merged into main, not exactly one"
number="$(jq -r '.[0].number // empty' <<<"${merged}")"
head="$(jq -r '.[0].head.sha // empty' <<<"${merged}")"
[[ ${number} =~ ^[0-9]+$ ]] || no "the merged pull request has no number"
[[ ${head} =~ ${hex40} ]] || no "pull request #${number} has no 40-hex head SHA ('${head}')"
say "- d. pull request #${number} merged into main, head ${head}: ok"

# e. The newest Full CI status on that head. `id` only grows, so the newest is the greatest id whatever order
# the API lists in; a head with no Full CI status has no proof.
statuses="$(gh api "repos/${repo}/commits/${head}/statuses?per_page=100")" || no "API error listing the statuses of ${head}"
status="$(jq -c '[.[] | select(.context == "Full CI")] | if length == 0 then empty else max_by(.id) end' <<<"${statuses}" 2>/dev/null)" ||
  no "the statuses of ${head} could not be read"
[[ -n ${status} ]] || no "${head} has no Full CI status"
state="$(jq -r '.state // empty' <<<"${status}")"
creator="$(jq -r '.creator.login // empty' <<<"${status}")"
description="$(jq -r '.description // empty' <<<"${status}")"
target="$(jq -r '.target_url // empty' <<<"${status}")"
[[ ${state} == success ]] || no "the newest Full CI status on ${head} is '${state}', not success"
[[ ${creator} == 'github-actions[bot]' ]] || no "the newest Full CI status on ${head} was posted by '${creator}', not github-actions[bot]"
proved_tree=''
if [[ ${description} =~ \;\ tree\ ([0-9a-f]{40})$ ]]; then
  proved_tree=${BASH_REMATCH[1]}
fi
[[ -n ${proved_tree} ]] || no "the Full CI status on ${head} names no tested tree ('${description}')"
[[ ${proved_tree} == "${tree}" ]] ||
  no "the PR tested tree ${proved_tree} but this push is tree ${tree}"
say "- e. newest Full CI on ${head} is success from github-actions[bot] and names tree ${tree}: ok"

# f. That status must be this repository's own pull_request run of ci.yaml on that head, and it must have
# passed: a status is only a claim, the run is the evidence.
run_prefix="${server}/${repo}/actions/runs/"
[[ ${target} == "${run_prefix}"* ]] || no "the Full CI status target '${target}' is not a run of ${repo}"
run_id=${target#"${run_prefix}"}
[[ ${run_id} =~ ^[0-9]+$ ]] || no "the Full CI status target '${target}' is not a plain run URL"
run="$(gh api "repos/${repo}/actions/runs/${run_id}")" || no "API error reading run ${run_id}"
run_ok="$(jq -r --arg head "${head}" '
  .path == ".github/workflows/ci.yaml" and .event == "pull_request" and .head_sha == $head and .conclusion == "success"
' <<<"${run}" 2>/dev/null)" || no "run ${run_id} could not be read"
if [[ ${run_ok} != true ]]; then
  got="$(jq -r '"path=\(.path) event=\(.event) head_sha=\(.head_sha) conclusion=\(.conclusion)"' <<<"${run}" 2>/dev/null || echo unreadable)"
  no "run ${run_id} is not a successful pull_request run of .github/workflows/ci.yaml on ${head} (${got})"
fi
say "- f. ${target} is a successful pull_request run of ci.yaml on ${head}: ok"

say "Proof reuse: YES - tree ${tree} passed the full set in ${target} (PR #${number} head ${head})"
printf 'proved=true\nproof=%s\n' "${target}" >>"${output}"
