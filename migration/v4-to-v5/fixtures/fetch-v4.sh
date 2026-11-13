#!/usr/bin/env bash
set -euo pipefail

# Downloads the released v4 binaries ONCE and caches them. This is the ONLY network access the fixture tooling does.
#
# Source: GitHub release v4.291.15 of kirinnee/ferretry. The archive for this machine is checked against the release's
# checksums.txt (SHA-256) before it is unpacked, and the cache is keyed by version, so a second run downloads nothing.
#
# stdout: the single line `<directory holding fy and fyd>`. Everything else goes to stderr, so
#   v4_dir="$(bash fetch-v4.sh)"
# is safe to use.
#
# Environment: XDG_CACHE_HOME (default ~/.cache), FY_V4_FIXTURE_REPO (default kirinnee/ferretry, for a fork).

version="4.291.15"
repo="${FY_V4_FIXTURE_REPO:-kirinnee/ferretry}"
cache="${XDG_CACHE_HOME:-${HOME}/.cache}/ferretry-v4-fixtures/${version}"

# Which asset is this machine's.
case "$(uname -s)/$(uname -m)" in
Linux/x86_64) asset="fy_linux_amd64.tar.gz" ;;
Linux/aarch64 | Linux/arm64) asset="fy_linux_arm64.tar.gz" ;;
Darwin/arm64) asset="fy_darwin_arm64.tar.gz" ;;
*)
  echo "❌ no v4 ${version} release archive for $(uname -s)/$(uname -m)" >&2
  exit 1
  ;;
esac

extracted="${cache}/extracted-${asset%.tar.gz}"

# Cache hit: the unpacked tree is only ever created last, after the checksum passed.
if [ -x "${extracted}/fy" ] && [ -f "${cache}/${asset}.verified" ]; then
  echo "✅ v4 ${version} already cached at ${extracted}" >&2
  echo "${extracted}"
  exit 0
fi

mkdir -p "${cache}"
work="$(mktemp -d "${cache}/.download.XXXXXX")"
trap 'rm -rf "${work}"' EXIT

# Download: gh when it is signed in, the public URL otherwise.
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  echo "⬇️  downloading ${asset} and checksums.txt with gh" >&2
  gh release download "v${version}" --repo "${repo}" --dir "${work}" --pattern "${asset}" --pattern "checksums.txt" >&2
else
  echo "⬇️  downloading ${asset} and checksums.txt with curl" >&2
  base="https://github.com/${repo}/releases/download/v${version}"
  curl --fail --silent --show-error --location --retry 3 --output "${work}/${asset}" "${base}/${asset}"
  curl --fail --silent --show-error --location --retry 3 --output "${work}/checksums.txt" "${base}/checksums.txt"
fi

# Verify: the archive's SHA-256 must be the one checksums.txt names for it.
expected="$(awk -v name="${asset}" '$2 == name || $2 == "*" name { print $1 }' "${work}/checksums.txt")"
if [ -z "${expected}" ]; then
  echo "❌ checksums.txt does not list ${asset}" >&2
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "${work}/${asset}" | awk '{ print $1 }')"
else
  actual="$(shasum -a 256 "${work}/${asset}" | awk '{ print $1 }')"
fi
if [ "${expected}" != "${actual}" ]; then
  echo "❌ checksum mismatch for ${asset}: expected ${expected}, got ${actual}" >&2
  exit 1
fi
echo "✅ ${asset} matches checksums.txt (${actual})" >&2

# Unpack into a scratch folder, then move it into place so a half-unpacked tree is never mistaken for a cache hit.
mkdir "${work}/unpacked"
tar -xzf "${work}/${asset}" -C "${work}/unpacked"
# Some archives nest their files in one folder; the binaries are wherever `fy` is.
fy_path="$(find "${work}/unpacked" -type f -name fy -print -quit)"
if [ -z "${fy_path}" ]; then
  echo "❌ ${asset} holds no fy binary" >&2
  exit 1
fi
rm -rf "${extracted}"
mv "$(dirname "${fy_path}")" "${extracted}"
chmod +x "${extracted}/fy"
[ -f "${extracted}/fyd" ] && chmod +x "${extracted}/fyd"
cp "${work}/${asset}" "${cache}/${asset}"
printf '%s\n' "${actual}" >"${cache}/${asset}.verified"

echo "✅ v4 ${version} cached at ${extracted}" >&2
echo "${extracted}"
