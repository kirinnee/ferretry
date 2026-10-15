#!/usr/bin/env bash
# Which macOS-only proofs a PULL REQUEST needs, written to $GITHUB_OUTPUT as `<area>=true|false`.
#
# The three macOS proof jobs (containment, the Safari sandbox shell, the harness contract) are the
# slowest in CI and draw on the scarcest runners, and most pull requests cannot change what they
# measure. On a pull request each runs only when a path it depends on changed. On every other event
# — the `main` push that Release waits on, a manual dispatch — every area is `true`, so nothing
# reaches a release without every macOS proof.
#
# THE COST, said plainly: a pull request that breaks one of these proofs through a path not listed
# below goes green and fails on `main`, which holds Release until it is fixed. The lists are therefore
# generous — each package a proof imports, the toolchain, and this workflow — and a change to this
# script or to ci.yaml runs all of them.
#
# Only bash, grep and the runner's `gh`, like `smoke`: it gates jobs, so it must not wait on a nix shell.
set -euo pipefail

out="${GITHUB_OUTPUT:-/dev/stdout}"
areas=(containment safari harness)

if [[ ${GITHUB_EVENT_NAME:-} != "pull_request" ]]; then
  for area in "${areas[@]}"; do echo "${area}=true" >>"${out}"; done
  exit 0
fi

: "${PR_NUMBER:?PR_NUMBER is required on a pull_request}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
changed="$(gh api --paginate "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}/files" --jq '.[] | .filename, (.previous_filename // empty)')"
[[ -z ${changed} ]] && echo "❌ the pull request lists no changed files" >&2 && exit 1

# Everything every macOS proof stands on: the toolchain, the install, this gate.
common='^(flake\.nix|flake\.lock|nix/|package\.json|bun\.lock|bunfig\.[a-z]+\.toml|\.github/workflows/ci\.yaml|scripts/ci/(setup|changed-areas)\.sh|scripts/local/)'
declare -A own=(
  [containment]='^(packages/(daemon|protocol)/|scripts/ci/darwin-confinement\.sh)'
  [safari]='^(packages/(pwa|protocol)/|scripts/ci/safari-render-proof\.sh)'
  [harness]='^(packages/(fleet|protocol)/)'
)
for area in "${areas[@]}"; do
  if grep -qE "${common}|${own[${area}]}" <<<"${changed}"; then
    echo "${area}=true" >>"${out}"
    echo "🍎 ${area}: needed by this change"
  else
    echo "${area}=false" >>"${out}"
    echo "⏭️  ${area}: no path it depends on changed; it runs on main before any release"
  fi
done
