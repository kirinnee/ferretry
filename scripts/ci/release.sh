#!/usr/bin/env bash
set -euo pipefail

# Releases `main` with semantic-release, and survives a push to `main` landing mid-release.
#
# THE RACE. @semantic-release/git commits the version bump and pushes it to `main` before the tag is
# made. When anything reached `main` after this run checked it out — a merge, or CD's own cask commit
# for the previous release — that push is rejected ("fetch first"), nothing was tagged, and on
# 2026-10-30 that turned a release red.
#
# WHAT HAPPENS THEN depends on what landed, read against CI's own `paths-ignore` (the files a commit
# can change without CI running for it):
# - Only ignored files (a cask update, a release stamp): no CI run will follow it, so no Release will
#   either. Start again from the new head, which holds no code CI has not proved. At most three tries.
# - Anything else: that commit has a CI run of its own, and its Release releases everything, this
#   version included. Releasing here would ship code no CI run has passed yet, so this run stops,
#   green, and says why.
#
# FY_SEMANTIC_RELEASE names another command to run in its place (the script's tests use a fake).

[ -z "${GITHUB_TOKEN:-}" ] && echo "❌ 'GITHUB_TOKEN' env var not set" >&2 && exit 1

semantic_release="${FY_SEMANTIC_RELEASE:-./node_modules/.bin/semantic-release}"
attempts=3

./scripts/ci/setup.sh
# The release commit ("release: x.y.z") must not fight local hooks in CI.
rm -f .git/hooks/*

# CI's own list of files a commit may change without a CI run: one fact, one owner.
mapfile -t ignored < <(yq -r '.on.push."paths-ignore"[]' .github/workflows/ci.yaml)
[[ ${#ignored[@]} -eq 0 ]] && echo "❌ could not read paths-ignore from .github/workflows/ci.yaml" >&2 && exit 2

# Whether every file in `$@` is one a commit can change without CI running for it.
only_ignored() {
  local file pattern matched
  for file in "$@"; do
    matched=false
    for pattern in "${ignored[@]}"; do
      # shellcheck disable=SC2053 # the pattern is a glob on purpose; in [[ ]] `*` also matches `/`
      [[ ${file} == ${pattern} ]] && matched=true && break
    done
    [[ ${matched} == false ]] && return 1
  done
  return 0
}

for attempt in $(seq 1 "${attempts}"); do
  base="$(git rev-parse HEAD)"
  log="$(mktemp)"
  set +e
  "${semantic_release}" 2>&1 | tee "${log}"
  status=${PIPESTATUS[0]}
  set -e
  if [[ ${status} -eq 0 ]]; then
    echo "✅ Release complete"
    exit 0
  fi
  if ! grep -qE '\[rejected\].*(fetch first|non-fast-forward)' "${log}"; then
    echo "❌ semantic-release failed (exit ${status})" >&2
    exit "${status}"
  fi

  git fetch --quiet origin main
  mapfile -t landed < <(git diff --name-only "${base}" origin/main)
  if ! only_ignored "${landed[@]}"; then
    echo "::notice title=Release superseded::main moved during this release with code that has a CI run of its own; that run's Release releases this version too"
    echo "ℹ️  main moved during this release (${base:0:9} → $(git rev-parse --short origin/main)) with: ${landed[*]}"
    echo "✅ Nothing released here: the newer commit's CI run releases it once it passes"
    exit 0
  fi
  echo "::warning title=Release retried::main moved during attempt ${attempt} with files CI ignores only (${landed[*]}); releasing again from its new head"
  git reset --quiet --hard origin/main
  git clean -fdq
done

echo "❌ main kept moving during ${attempts} release attempts" >&2
exit 1
