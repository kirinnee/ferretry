#!/usr/bin/env bash
set -euo pipefail

# Cross-compile the standalone CLI (entry from the CLI package's .bin) for every supported target.
./scripts/ci/setup.sh

CLI_PKG="packages/cli"

ENTRY="$(jq -r '.bin | to_entries[0].value' "${CLI_PKG}/package.json")"
[ -z "${ENTRY}" ] && echo "❌ no .bin entry in ${CLI_PKG}/package.json" >&2 && exit 1
[ "${ENTRY}" = "null" ] && echo "❌ no .bin entry in ${CLI_PKG}/package.json" >&2 && exit 1

# Artifact prefix is the .bin key (the CLI's own name) — never hardcode the name.
PREFIX="$(jq -r '.bin | to_entries[0].key' "${CLI_PKG}/package.json")"
[ -z "${PREFIX}" ] && echo "❌ no .bin entry in ${CLI_PKG}/package.json" >&2 && exit 1
[ "${PREFIX}" = "null" ] && echo "❌ no .bin entry in ${CLI_PKG}/package.json" >&2 && exit 1

OUTDIR="${COMPILE_OUTDIR:-dist/bin}"
mkdir -p "${OUTDIR}"

# bunTarget<TAB>artifactSuffix — x64 uses the -baseline build (no AVX2) so it runs under QEMU too.
targets="bun-linux-x64-baseline	linux-x64-baseline
bun-linux-arm64	linux-arm64
bun-darwin-arm64	darwin-arm64"

count=0
while IFS=$'\t' read -r target suffix; do
  [ -z "${target}" ] && continue
  artifact="${PREFIX}-${suffix}"
  echo "🔨 compiling ${target} -> ${OUTDIR}/${artifact}"
  bun build "./${CLI_PKG}/${ENTRY}" --compile --target="${target}" --outfile "${OUTDIR}/${artifact}"
  count=$((count + 1))
done <<<"${targets}"

ls -la "${OUTDIR}"
echo "✅ compiled ${count} target(s) into ${OUTDIR}"
