#!/usr/bin/env bash
set -euo pipefail

# Cross-compile every standalone executable from EVERY .bin entry of each shipped package for every
# supported target. Every entry, not the first: a package may declare a helper beside its own executable,
# and a 4.x release that compiled only the first entry shipped a daemon whose browser worker could never
# start. The shipped packages are the CLI (`fy`, packages/cli), the daemon host (`fyd`, packages/core/kernel)
# and the browser worker the daemon runs beside it (`fyd-browser-worker`, packages/plugins/browsers: the
# kernel never points into a plugin, so the worker's bin entry is the Browsers package's own).
#
# `COMPILE_TARGETS` narrows that to the named artifact suffixes (space-separated, e.g. `linux-x64-baseline`)
# for a caller that runs only some of them (a local check of its own host's binary: compiling every
# target costs seconds per binary). UNSET, IT IS EVERY
# TARGET (a whitespace-only value counts as unset): the release path (publish.sh, the `compile` job) never
# sets it, and an unknown name fails
# rather than silently compiling less.
#
# `compile.sh --list` prints what one target compiles (package<TAB>entry<TAB>name per executable) and
# exits before installing or building anything: the release contracts read it to prove no compile omits
# an executable a release channel ships (scripts/validate/cli-contracts.sh release-helpers).
CLI_PKG="packages/cli"
DAEMON_PKG="packages/core/kernel"
# The daemon's helper executables that live in a plugin package and ship beside it.
BROWSERS_PKG="packages/plugins/browsers"

# The FIRST bin key is the package's own executable name (the two-name model reads
# `.bin | to_entries[0].key`); the remaining entries are helpers that ship beside it.
package_bins() {
  local package="$1" prefix
  prefix="$(jq -r '.bin | to_entries[0].key' "${package}/package.json")"
  [ -z "${prefix}" ] || [ "${prefix}" = "null" ] && echo "❌ no .bin entry in ${package}/package.json" >&2 && exit 1
  jq -r --arg package "${package}" '.bin | to_entries[] | [$package, .value, .key] | @tsv' "${package}/package.json"
}

# Every executable one target compiles, in order.
shipped_bins() {
  package_bins "${CLI_PKG}"
  package_bins "${DAEMON_PKG}"
  package_bins "${BROWSERS_PKG}"
}

if [ "${1:-}" = "--list" ]; then
  shipped_bins
  exit 0
fi
[ "$#" -gt 0 ] && echo "❌ usage: compile.sh [--list]" >&2 && exit 2

./scripts/ci/setup.sh

# bunTarget<TAB>artifactSuffix<TAB>os<TAB>cpu — x64 uses the -baseline build (no AVX2) so it runs under QEMU too.
all_targets="bun-linux-x64-baseline	linux-x64-baseline	linux	x64
bun-linux-arm64	linux-arm64	linux	arm64
bun-darwin-arm64	darwin-arm64	darwin	arm64"

targets="${all_targets}"
if [ -n "${COMPILE_TARGETS:-}" ] && [ -n "$(tr -d "[:space:]" <<<"${COMPILE_TARGETS}")" ]; then
  targets=""
  for wanted in ${COMPILE_TARGETS}; do
    row="$(awk -F '\t' -v wanted="${wanted}" '$2 == wanted' <<<"${all_targets}")"
    if [ -z "${row}" ]; then
      echo "❌ COMPILE_TARGETS names '${wanted}', which is not a release target ($(cut -f2 <<<"${all_targets}" | paste -sd' ' -))" >&2
      exit 1
    fi
    targets+="${row}"$'\n'
  done
fi

# The daemon embeds its WebRTC engine's native addon per TARGET (scripts/release/compile-executable.ts),
# and an ordinary install fetches only this runner's. Install the prebuilds for every platform being
# compiled so the cross-compiled darwin and arm64 daemons carry their own, not a Linux x64 one or none at
# all. Every target by default, which is the platform set this line always installed.
install_os=()
install_cpu=()
while IFS=$'\t' read -r _ _ os cpu; do
  [ -z "${os}" ] && continue
  install_os+=("--os=${os}")
  install_cpu+=("--cpu=${cpu}")
done <<<"${targets}"
mapfile -t install_os < <(printf '%s\n' "${install_os[@]}" | sort -u)
mapfile -t install_cpu < <(printf '%s\n' "${install_cpu[@]}" | sort -u)
bun install --frozen-lockfile "${install_os[@]}" "${install_cpu[@]}"
# The hosts import the git-ignored generated registries (the install above also runs it as postinstall).
./scripts/local/gen.sh

OUTDIR="${COMPILE_OUTDIR:-dist/bin}"
mkdir -p "${OUTDIR}"

# The daemon compiles the hosted directory default from its one source constant. Do not add a build define
# here: a release-only define was why Nix and GoReleaser could produce different reachability.

count=0
while IFS=$'\t' read -r target suffix _ _; do
  [ -z "${target}" ] && continue
  while IFS=$'\t' read -r package entry prefix; do
    artifact="${prefix}-${suffix}"
    echo "🔨 compiling ${package} for ${target} -> ${OUTDIR}/${artifact}"
    bun ./scripts/release/compile-executable.ts --entry "./${package}/${entry}" --target "${target}" \
      --outfile "${OUTDIR}/${artifact}"
    count=$((count + 1))
  done < <(shipped_bins)
done <<<"${targets}"

[ "${count}" -eq 0 ] && echo "❌ nothing was compiled: COMPILE_TARGETS names no target" >&2 && exit 1
ls -la "${OUTDIR}"
echo "✅ compiled ${count} target(s) into ${OUTDIR}"
