#!/usr/bin/env bash
set -euo pipefail

# Swap the prebuilt Bun binary over GoReleaser's Go stub (its prebuilt builder is Pro-only).
dest="$1"

# Match GoReleaser's destination to a package .bin key so the release never hardcodes any
# executable name outside the manifest/configuration boundary. EVERY bin key is a candidate: the
# daemon package also ships its browser worker. The first key of each package is still checked to
# exist, because it is the package's own executable name (the two-name model).
prefix=""
for package in packages/cli packages/daemon; do
  own="$(jq -r '.bin | to_entries[0].key' "${package}/package.json")"
  [ -z "${own}" ] || [ "${own}" = "null" ] && echo "❌ no .bin entry in ${package}/package.json" >&2 && exit 1
  while IFS= read -r candidate; do
    if [ "$(basename "${dest}")" = "${candidate}" ]; then
      prefix="${candidate}"
      break 2
    fi
  done < <(jq -r '.bin | keys_unsorted[]' "${package}/package.json")
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
