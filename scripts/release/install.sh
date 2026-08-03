#!/usr/bin/env bash
set -euo pipefail

# One-line installer served from the GitHub release:
#   curl -fsSL https://github.com/kirinnee/ferretry/releases/latest/download/install.sh | bash
# REPO carries the product name and BINARY carries the archive prefix. Both are rewritten by
# scripts/local/rename.sh when either changes. Executable names themselves are taken from the
# verified archive so a normal install receives every shipped binary, including the daemon.
REPO="kirinnee/ferretry"
BINARY="fy"

VERSION="${VERSION:-latest}"
BIN_DIR="${BIN_DIR:-${HOME}/.local/bin}"

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "${os}" in
linux | darwin) ;;
*)
  echo "❌ unsupported OS: ${os}" >&2
  exit 1
  ;;
esac

case "$(uname -m)" in
x86_64 | amd64) arch="amd64" ;;
aarch64 | arm64) arch="arm64" ;;
*)
  echo "❌ unsupported architecture: $(uname -m)" >&2
  exit 1
  ;;
esac

# Only darwin arm64 ships (no Intel mac) — fail clearly instead of 404ing on a missing archive.
[[ ${os} == "darwin" && ${arch} == "amd64" ]] && echo "❌ Intel macOS is not supported (arm64 only)" >&2 && exit 1

archive="${BINARY}_${os}_${arch}.tar.gz"

if [[ ${VERSION} == "latest" ]]; then
  base="https://github.com/${REPO}/releases/latest/download"
else
  base="https://github.com/${REPO}/releases/download/${VERSION}"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT

echo "⬇️  downloading ${archive} ..."
curl -fsSL --connect-timeout 30 --max-time 600 "${base}/${archive}" -o "${tmp}/${archive}"
curl -fsSL --connect-timeout 30 --max-time 600 "${base}/checksums.txt" -o "${tmp}/checksums.txt"

echo "🔐 verifying checksum ..."
(
  cd "${tmp}"
  expected="$(grep " ${archive}\$" checksums.txt | awk '{print $1}' || true)"
  [[ -z ${expected} ]] && echo "❌ no checksum entry for ${archive}" >&2 && exit 1
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s  %s\n' "${expected}" "${archive}" | sha256sum -c -
  else
    actual="$(shasum -a 256 "${archive}" | awk '{print $1}')"
    [[ ${actual} != "${expected}" ]] && echo "❌ checksum mismatch" >&2 && exit 1
  fi
  # The success echo also keeps the guard off the subshell's final line (a false guard returns 1).
  echo "✅ checksum verified"
)

echo "📦 installing to ${BIN_DIR} ..."
mkdir -p "${BIN_DIR}"
contents="${tmp}/contents"
mkdir -p "${contents}"
tar -xzf "${tmp}/${archive}" -C "${contents}"

installed=()
for artifact in "${contents}"/*; do
  [ -f "${artifact}" ] && [ -x "${artifact}" ] || continue
  binary="$(basename "${artifact}")"
  install -m 0755 "${artifact}" "${BIN_DIR}/${binary}"
  installed+=("${binary}")
done
[ "${#installed[@]}" -ge 2 ] || {
  echo "❌ archive must contain the CLI and daemon executables" >&2
  exit 1
}

echo "📝 ensure ${BIN_DIR} is on your PATH."
echo "✅ installed ${installed[*]} to ${BIN_DIR}"
