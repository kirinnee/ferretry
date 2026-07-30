#!/usr/bin/env bash
set -euo pipefail

# Swap the prebuilt Bun binary over GoReleaser's Go stub (its prebuilt builder is Pro-only).
dest="$1"

# Artifact prefix is the .bin key (the CLI's own name) — never hardcode the name.
prefix="$(jq -r '.bin | to_entries[0].key' packages/cli/package.json)"
[ -z "${prefix}" ] && echo "❌ no .bin entry in packages/cli/package.json" >&2 && exit 1
[ "${prefix}" = "null" ] && echo "❌ no .bin entry in packages/cli/package.json" >&2 && exit 1

case "$2/$3" in
linux/amd64) suffix="linux-x64-baseline" ;;
linux/arm64) suffix="linux-arm64" ;;
darwin/arm64) suffix="darwin-arm64" ;;
*)
  echo "❌ unsupported target: $2/$3" >&2
  exit 1
  ;;
esac

srcpath="${PREBUILT_DIR:-prebuilt}/${prefix}-${suffix}"
[ ! -f "${srcpath}" ] && echo "❌ prebuilt binary not found: ${srcpath} (did compile.sh run into ${PREBUILT_DIR:-prebuilt}/?)" >&2 && exit 1
cp "${srcpath}" "${dest}"
echo "✅ swapped ${srcpath} -> ${dest}"
