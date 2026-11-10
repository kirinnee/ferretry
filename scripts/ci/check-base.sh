#!/usr/bin/env bash
set -euo pipefail
#
# The base the only-down checks (`ports-pending`, `after-merge`) compare against in CI. A checkout of one commit
# holds no other commit, so without this those checks hold the tree to its own baseline and never ask whether the
# baseline itself grew. The commit hook runs the same rule locally, but a hook can be skipped; CI cannot.
#
#   FY_PR_BASE_SHA   the pull request's base commit (empty on a push)
#   FY_PUSH_BEFORE   the commit before this push or pull request update (empty or all zeros when there is none)
#
# The pull request's base wins when it already holds `docs/rebuild/after-merge.json` (every pull request once 5.0
# is on main). Otherwise the commit before this update (the 5.0 pull request itself, whose base has no list yet).
# The chosen commit is fetched at depth 1 and written to $GITHUB_ENV as FY_CHECK_BASE, which `scripts/gen/check.ts`
# reads as its `--base`. With no usable commit (a first run, or a label event on 5.0) it says so and sets nothing.

list="docs/rebuild/after-merge.json"
zero="0000000000000000000000000000000000000000"

fetched() {
  [[ -n $1 && $1 != "${zero}" ]] && git fetch --no-tags --quiet --depth=1 origin "$1"
}

chosen=""
if fetched "${FY_PR_BASE_SHA:-}" && git cat-file -e "${FY_PR_BASE_SHA}:${list}" 2>/dev/null; then
  chosen="${FY_PR_BASE_SHA}"
elif fetched "${FY_PUSH_BEFORE:-}"; then
  chosen="${FY_PUSH_BEFORE}"
fi

if [[ -z ${chosen} ]]; then
  echo "⚠️ no base commit for the only-down checks in this run: they hold the tree to its own baseline only"
  exit 0
fi
echo "FY_CHECK_BASE=${chosen}" >>"${GITHUB_ENV:?GITHUB_ENV is set by GitHub Actions}"
echo "✅ only-down checks compare against ${chosen}"
