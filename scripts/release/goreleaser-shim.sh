#!/usr/bin/env bash
set -euo pipefail

# Swap the prebuilt Bun binary over GoReleaser's Go stub (its prebuilt builder is Pro-only).
dest="$1"

# Match GoReleaser's destination to a package .bin key so the release never hardcodes either
# executable name outside the manifest/configuration boundary.
prefix=""
for package in packages/cli packages/daemon; do
  candidate="$(jq -r '.bin | to_entries[0].key' "${package}/package.json")"
  [ -z "${candidate}" ] || [ "${candidate}" = "null" ] && echo "❌ no .bin entry in ${package}/package.json" >&2 && exit 1
  if [ "$(basename "${dest}")" = "${candidate}" ]; then
    prefix="${candidate}"
    break
  fi
done
[ -z "${prefix}" ] && echo "❌ release destination does not match a standalone package binary: ${dest}" >&2 && exit 1

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
