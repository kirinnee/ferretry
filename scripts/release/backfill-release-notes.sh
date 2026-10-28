#!/usr/bin/env bash
set -euo pipefail

# Rewrites the BODY of existing GitHub releases from Changelog.md. Releases published before the notes
# fix are header-only; this gives each one its section. It touches only the notes text, never assets.
#
#   scripts/release/backfill-release-notes.sh                  # dry run: list what would change
#   scripts/release/backfill-release-notes.sh --apply          # edit every release
#   scripts/release/backfill-release-notes.sh --apply v4.92.0  # edit just these tags
#
# Owner-run on purpose: editing a published release is visible to everyone, and GITHUB_TOKEN needs the
# `repo` scope. A rerun is harmless: the body is replaced with the same text.

apply=false
tags=()
for arg in "$@"; do
  case "${arg}" in
  --apply) apply=true ;;
  v*.*.*) tags+=("${arg}") ;;
  *) echo "❌ usage: $0 [--apply] [vX.Y.Z ...]" >&2 && exit 2 ;;
  esac
done

cd "$(git rev-parse --show-toplevel)"
[ -f Changelog.md ] || { echo "❌ Changelog.md not found" >&2 && exit 1; }

if [ "${#tags[@]}" -eq 0 ]; then
  mapfile -t tags < <(rg -o '^## \[([0-9]+\.[0-9]+\.[0-9]+)\]' -r 'v$1' Changelog.md)
fi

notes="$(mktemp)"
trap 'rm -f "${notes}"' EXIT

changed=0
for tag in "${tags[@]}"; do
  version="${tag#v}"
  # The section runs from its own header to the next one.
  awk -v header="## [${version}](" 'index($0, header) == 1 {on = 1; print; next} /^## \[/ {on = 0} on' Changelog.md >"${notes}"
  if [ "$(rg -c '^\* ' "${notes}" || true)" = "" ]; then
    echo "· ${tag}: no user-facing changes, left alone"
    continue
  fi
  if "${apply}"; then
    gh release edit "${tag}" --notes-file "${notes}" >/dev/null
    echo "✅ ${tag}: notes replaced"
  else
    echo "would edit ${tag} ($(rg -c '^\* ' "${notes}") entries)"
  fi
  changed=$((changed + 1))
done

"${apply}" || echo "dry run: ${changed} release(s) would change; rerun with --apply"
