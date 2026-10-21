#!/usr/bin/env bash
set -euo pipefail

# Cross-compile every standalone executable from EVERY .bin entry of each shipped package for every
# supported target. Every entry, not the first: the daemon package also declares its browser worker,
# and a release that compiled only the first entry shipped a daemon whose browser pane could never
# start (the worker is run beside the daemon, see packages/daemon/src/lib/browser/runtime/worker-program.ts).
./scripts/ci/setup.sh

# The daemon embeds its WebRTC engine's native addon per TARGET (scripts/release/compile-executable.ts),
# and an ordinary install fetches only this runner's. Install the prebuilds for every platform below so
# the cross-compiled darwin and arm64 daemons carry their own, not a Linux x64 one or none at all.
bun install --frozen-lockfile --os=linux --os=darwin --cpu=x64 --cpu=arm64

CLI_PKG="packages/cli"
DAEMON_PKG="packages/daemon"

# The FIRST bin key is the package's own executable name (the two-name model reads
# `.bin | to_entries[0].key`); the remaining entries are helpers that ship beside it.
package_bins() {
  local package="$1" prefix
  prefix="$(jq -r '.bin | to_entries[0].key' "${package}/package.json")"
  [ -z "${prefix}" ] || [ "${prefix}" = "null" ] && echo "❌ no .bin entry in ${package}/package.json" >&2 && exit 1
  jq -r --arg package "${package}" '.bin | to_entries[] | [$package, .value, .key] | @tsv' "${package}/package.json"
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
    bun ./scripts/release/compile-executable.ts --entry "./${package}/${entry}" --target "${target}" \
      --outfile "${OUTDIR}/${artifact}"
    count=$((count + 1))
  done < <(
    package_bins "${CLI_PKG}"
    package_bins "${DAEMON_PKG}"
  )
done <<<"${targets}"

ls -la "${OUTDIR}"
echo "✅ compiled ${count} target(s) into ${OUTDIR}"
