#!/usr/bin/env bash
set -euo pipefail

# Writes, or checks, the SHA-256 manifest of the compiled binaries CI hands from `Compile Binaries` to
# the jobs that run them.
#
# WHY THIS EXISTS. `actions/download-artifact` can stop part-way through a download and still exit 0: its
# log ends at "Starting download of artifact" with no digest line, and the step is green. That left
# `dist/bin` without the daemon on `main` (`Smoke linux-x64-baseline`: "no daemon binary at
# dist/bin/fyd-linux-x64-baseline") while the other two smoke jobs downloaded the same artifact whole —
# actions/download-artifact#454, still open. A manifest written beside the binaries is the one thing a
# consumer can hold the download to, so a short download fails as itself, or is fetched again, instead of
# surfacing as a missing file in whatever ran next.
#
# `shasum -a 256` is on every runner image, Linux and macOS, so one format is written and checked on both.
#
# Usage: binaries-manifest.sh write|check [dir]   (dir defaults to dist/bin)
# Local reproduction: `./scripts/release/compile.sh && ./scripts/ci/binaries-manifest.sh write`.

mode="${1:-}"
dir="${2:-dist/bin}"
manifest="SHA256SUMS"

[ ! -d "${dir}" ] && echo "❌ no binaries directory at ${dir}" >&2 && exit 1
cd "${dir}"

case "${mode}" in
write)
  rm -f "${manifest}"
  files=()
  for file in *; do
    [ -f "${file}" ] && files+=("${file}")
  done
  [ "${#files[@]}" -eq 0 ] && echo "❌ nothing to list in ${dir}" >&2 && exit 1
  shasum -a 256 "${files[@]}" >"${manifest}.tmp"
  mv "${manifest}.tmp" "${manifest}"
  echo "✅ listed $(wc -l <"${manifest}" | tr -d ' ') binaries in ${dir}/${manifest}"
  ;;
check)
  [ ! -f "${manifest}" ] && echo "❌ no ${manifest} in ${dir}: the download is incomplete or was never listed" >&2 && exit 1
  if ! shasum -a 256 -c --quiet "${manifest}"; then
    echo "❌ ${dir} does not match its ${manifest}: the download is incomplete" >&2
    exit 1
  fi
  echo "✅ every binary in ${dir}/${manifest} arrived whole"
  ;;
*)
  echo "❌ usage: binaries-manifest.sh write|check [dir]" >&2
  exit 1
  ;;
esac
