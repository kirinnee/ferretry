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

# THE RELAY DIRECTORY ORIGIN, BAKED INTO THE DAEMON — and only into the daemon.
#
# The daemon has to dial a rendezvous for a browser that is not on this machine's network to reach it
# at all, and it has no address to dial until something tells it one. What is compiled in is the
# DIRECTORY: a service origin that identifies the relay's advertisement, never a carrier, never a
# daemon and never a person. The relay address and the operator's kill switch both live behind it at
# runtime, which is what lets the carrier be withdrawn without cutting a release.
#
# Resolved by the SAME script the PWA's Pages build uses, from the same inputs, because a session
# crosses a relay only if both ends are on it — two halves pointed at different directories carry
# nothing. `.github/workflows/cd.yaml` runs it with `--require` and exports the answer; an unset
# variable here is a local build or a fork, which ships no directory, asks nobody anything, and says
# so on the boot trail rather than inventing a hostname.
relay_directory="${FY_RELAY_DIRECTORY_ORIGIN:-}"
if [ -n "${relay_directory}" ]; then
  echo "ℹ️  daemon relay directory: ${relay_directory}"
else
  echo "⚠️  no FY_RELAY_DIRECTORY_ORIGIN: this daemon build ships no relay directory and stays direct-only"
fi

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
    # The define is applied to the daemon alone: the CLI talks to a daemon on this machine and has
    # no use for a rendezvous directory, so compiling one into it would be a constant nothing reads.
    defines=()
    if [ "${package}" = "${DAEMON_PKG}" ]; then
      defines=(--define "__FY_RELAY_DIRECTORY__=\"${relay_directory}\"")
    fi
    bun build "./${package}/${entry}" --compile --target="${target}" ${defines[@]+"${defines[@]}"} \
      --outfile "${OUTDIR}/${artifact}"
    count=$((count + 1))
  done < <(
    package_bins "${CLI_PKG}"
    package_bins "${DAEMON_PKG}"
  )
done <<<"${targets}"

ls -la "${OUTDIR}"
echo "✅ compiled ${count} target(s) into ${OUTDIR}"
