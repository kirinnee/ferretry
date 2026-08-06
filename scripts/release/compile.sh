#!/usr/bin/env bash
set -euo pipefail

# Cross-compile every standalone executable from its package's .bin entry for every supported target.
./scripts/ci/setup.sh

CLI_PKG="packages/cli"
DAEMON_PKG="packages/daemon"

package_bins() {
  local package="$1" entry prefix
  entry="$(jq -r '.bin | to_entries[0].value' "${package}/package.json")"
  prefix="$(jq -r '.bin | to_entries[0].key' "${package}/package.json")"
  [ -z "${entry}" ] || [ "${entry}" = "null" ] && echo "❌ no .bin entry in ${package}/package.json" >&2 && exit 1
  [ -z "${prefix}" ] || [ "${prefix}" = "null" ] && echo "❌ no .bin entry in ${package}/package.json" >&2 && exit 1
  printf '%s\t%s\t%s\n' "${package}" "${entry}" "${prefix}"
}

OUTDIR="${COMPILE_OUTDIR:-dist/bin}"
mkdir -p "${OUTDIR}"

# The daemon imports the hosted directory default from @ferretry/relay. Do not add a build define
# here: a release-only define was why Nix and GoReleaser could produce different reachability.

# bunTarget<TAB>artifactSuffix — x64 uses the -baseline build (no AVX2) so it runs under QEMU too.
targets="bun-linux-x64-baseline	linux-x64-baseline
bun-linux-arm64	linux-arm64
bun-darwin-arm64	darwin-arm64"

count=0
while IFS=$'\t' read -r target suffix; do
  [ -z "${target}" ] && continue
  while IFS=$'\t' read -r package entry prefix; do
    artifact="${prefix}-${suffix}"
    echo "🔨 compiling ${package} for ${target} -> ${OUTDIR}/${artifact}"
    bun build "./${package}/${entry}" --compile --target="${target}" \
      --outfile "${OUTDIR}/${artifact}"
    count=$((count + 1))
  done < <(
    package_bins "${CLI_PKG}"
    package_bins "${DAEMON_PKG}"
  )
done <<<"${targets}"

ls -la "${OUTDIR}"
echo "✅ compiled ${count} target(s) into ${OUTDIR}"
