#!/usr/bin/env bash
set -euo pipefail
#
# The base the only-down checks (`ports-pending`, `after-merge`) compare against in CI. A checkout of one commit
# holds no other commit, so without this those checks hold the tree to its own baseline and never ask whether the
# baseline itself grew. The commit hook runs the same rule locally, but a hook can be skipped; CI cannot.
#
#   FY_PR_BASE_SHA   the pull request's base commit (empty on a push)
#   FY_PUSH_BEFORE   the commit before this push to main (empty or all zeros when there is none)
#
# The first commit that holds `docs/rebuild/after-merge.json` wins: the pull request's base (every pull request
# once 5.0 is on main), then the commit before a push to main. When neither holds the list (the 5.0 pull request
# itself, and the push that merges it), the base is ANCHOR: the commit that set the owner-approved baseline. A
# pull request's own earlier head is never the base, because a second push would then hide a first push that
# grew the list. The chosen commit is fetched at depth 1 and written to $GITHUB_ENV as FY_CHECK_BASE, which
# `scripts/gen/check.ts` reads as its `--base`. A base it cannot fetch fails the job.

list="docs/rebuild/after-merge.json"
zero="0000000000000000000000000000000000000000"
# The commit that wrote the approved baseline (docs/rebuild/merge-bar.md, !A480). Never moved forward by hand.
ANCHOR="7573243d27c42a4cdb23cdfdee7bd954c911c7e6"

# Whether a given commit holds the list, fetching it first. An empty or all-zero commit holds nothing.
holds_list() {
  [[ -n $1 && $1 != "${zero}" ]] || return 1
  git fetch --no-tags --quiet --depth=1 origin "$1" || {
    echo "❌ could not fetch ${1} for the only-down checks" >&2
    exit 1
  }
  git cat-file -e "${1}:${list}" 2>/dev/null
}

chosen="${ANCHOR}"
if holds_list "${FY_PR_BASE_SHA:-}"; then
  chosen="${FY_PR_BASE_SHA}"
elif holds_list "${FY_PUSH_BEFORE:-}"; then
  chosen="${FY_PUSH_BEFORE}"
elif ! holds_list "${ANCHOR}"; then
  echo "❌ the anchor ${ANCHOR} holds no ${list}" >&2
  exit 1
fi

echo "FY_CHECK_BASE=${chosen}" >>"${GITHUB_ENV:?GITHUB_ENV is set by GitHub Actions}"
echo "✅ only-down checks compare against ${chosen}"
