#!/usr/bin/env bash
set -euo pipefail

# Does this run of `E2E` have anything to prove? Writes `run=true|false` to $GITHUB_OUTPUT.
#
# A pull request that changes ONLY documentation or the model catalogs skips the journeys: no binary,
# bundle or journey it could break is built from those files. Everything else runs them.
#
# WHY A JOB AND NOT `paths-ignore`. A workflow that `paths-ignore` filters out never starts, so its
# `E2E Journeys` status never appears and a merge waiting on it waits forever. The usual answer, a
# stub workflow reporting the same name on the ignored paths, fires on a MIXED pull request too and
# then posts a green `E2E Journeys` beside the real one. Deciding inside the workflow keeps exactly one
# status: the summary job reports success for a skipped run and the shards' outcome otherwise.
#
# It fails open: any doubt — not a pull request, an unreadable file list, an empty one — runs the tier.

out="${GITHUB_OUTPUT:-/dev/stdout}"

decide() {
  echo "run=$1" >>"${out}"
  echo "🧭 e2e journeys: run=$1 — $2"
  exit 0
}

[ "${GITHUB_EVENT_NAME:-}" != "pull_request" ] && decide true "not a pull request (${GITHUB_EVENT_NAME:-local})"
[ -z "${PR_NUMBER:-}" ] && decide true "no pull request number"

set +e
files="$(gh api --paginate "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}/files" --jq '.[].filename')"
listed=$?
set -e
[ "${listed}" -ne 0 ] && decide true "the pull request's files could not be listed"
[ -z "${files}" ] && decide true "the pull request lists no files"

# Documentation anywhere, and the model catalogs (docs/model-catalog.md): data a daemon reads at runtime
# whose shape the unit tier's schema test already holds to account.
relevant="$(grep -Ev '^docs/|\.md$|^packages/fleet/models/' <<<"${files}" || true)"
[ -z "${relevant}" ] && decide false "only documentation or model catalogs changed ($(wc -l <<<"${files}") files)"
decide true "$(wc -l <<<"${relevant}") changed files can affect a journey, e.g. $(head -1 <<<"${relevant}")"
