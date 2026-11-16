#!/usr/bin/env bash
set -euo pipefail
#
# The history the changed-plugin scope (scripts/ci/scope.ts) diffs: `git diff <base>...<head>` needs the MERGE-BASE of the
# pull request's base and head, and a one-commit checkout holds neither. Only a pull request into the scoped base needs
# it, so every other run returns at once. The fetch is best effort and deepens in steps: a merge-base that is still
# missing after the last one is not an error here, it is the scope's own reason to run FULL (`scope.ts decide` says so).
# The repository is public, so the fetch needs no credentials.
#
#   FY_SCOPE_EVENT / FY_SCOPE_BASE_REF / FY_SCOPE_BASE_SHA / FY_SCOPE_HEAD_SHA   as `scope.ts decide` reads them

scoped_base="rebuild/5.0-after"
if [[ ${FY_SCOPE_EVENT:-} != "pull_request" || ${FY_SCOPE_BASE_REF:-} != "${scoped_base}" ]]; then
  echo "scope: not a pull request into ${scoped_base}; no history to fetch"
  exit 0
fi

base="${FY_SCOPE_BASE_SHA:-}"
head="${FY_SCOPE_HEAD_SHA:-}"
if [[ ! ${base} =~ ^[0-9a-f]{40,64}$ || ! ${head} =~ ^[0-9a-f]{40,64}$ ]]; then
  echo "scope: the base or head sha is missing; the scope will run FULL"
  exit 0
fi

for depth in 50 250 1000 5000; do
  git fetch --no-tags --quiet --depth="${depth}" origin "${base}" "${head}" || echo "scope: fetch at depth ${depth} failed"
  if git merge-base "${base}" "${head}" >/dev/null 2>&1; then
    echo "scope: merge-base found at depth ${depth}: $(git merge-base "${base}" "${head}")"
    exit 0
  fi
done
echo "scope: no merge-base of ${base} and ${head} after the deepest fetch; the scope will run FULL"
