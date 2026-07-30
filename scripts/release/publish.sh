#!/usr/bin/env bash
set -euo pipefail

# Release orchestration:
#   publish.sh            → real release: GoReleaser publishes the GitHub release + in-repo cask
#   publish.sh --snapshot → dry-run: build everything into dist/ with NO publish
SNAPSHOT=0
[ "${1:-}" = "--snapshot" ] && SNAPSHOT=1

# Prebuilt binaries go into prebuilt/ (survives GoReleaser's --clean, unlike dist/).
echo "🔨 Compiling prebuilt Bun binaries into prebuilt/ ..."
COMPILE_OUTDIR="prebuilt" ./scripts/release/compile.sh

if [ "${SNAPSHOT}" -eq 1 ]; then
  echo "📦 GoReleaser snapshot (no publish) ..."
  goreleaser release --snapshot --clean --skip=publish
  echo "✅ Snapshot complete — artifacts in dist/, nothing was published."
  exit 0
fi

[ -z "${GITHUB_TOKEN:-}" ] && echo "❌ 'GITHUB_TOKEN' env var not set" >&2 && exit 1

# Release notes = this version's changelog section (diff of Changelog.md vs Changelog.old.md).
echo "⚙️ Generating changelog diff ..."
if [ ! -f Changelog.md ] || [ ! -f Changelog.old.md ]; then
  touch IncrementalChangelog.md
else
  set +e
  diff --new-line-format='' --unchanged-line-format='' --old-line-format='%L' Changelog.md Changelog.old.md >IncrementalChangelog.md
  ec="$?"
  set -e
  [ "${ec}" -gt 1 ] && echo "❌ changelog diff failed" >&2 && exit 1
fi

echo "📦 GoReleaser release (creates the GitHub release, commits the in-repo cask) ..."
goreleaser release --clean --release-notes ./IncrementalChangelog.md

echo "✅ Release complete."
