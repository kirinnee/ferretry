#!/usr/bin/env bash
set -euo pipefail

# Builds the 5.0 programs (fy, fyd, fyd-browser-worker) at ONE commit into a folder, and stamps the folder with that commit
# (BUILD.json), which `slot.ts upgrade-v5` needs. The commit is checked out in a DETACHED worktree of this repository under
# /tmp/claude-1000/sweep/build-<short>, built with the hosted 5.0 preview's origin, and the worktree is removed afterwards.
# Nothing in this repository's own checkout changes.
#
#   sweep-build-v5.sh <commit> <out-dir>
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
commit="${1:?usage: sweep-build-v5.sh <commit> <out-dir>}"
out="${2:?usage: sweep-build-v5.sh <commit> <out-dir>}"
repo="$(git -C "${here}" rev-parse --show-toplevel)"
full="$(git -C "${repo}" rev-parse --verify "${commit}^{commit}")"
tree="/tmp/claude-1000/sweep/build-${full:0:10}"
out="$(mkdir -p "${out}" && cd "${out}" && pwd)"

[ -e "${tree}" ] && {
  echo "❌ ${tree} already exists; remove it (git worktree remove --force) and retry" >&2
  exit 1
}
git -C "${repo}" worktree add --detach "${tree}" "${full}" >/dev/null
cleanup() { git -C "${repo}" worktree remove --force "${tree}" >/dev/null 2>&1 || true; }
trap cleanup EXIT

raw="${tree}-compiled"
(
  cd "${tree}"
  bun install --frozen-lockfile >/dev/null
  COMPILE_OUTDIR="${raw}" COMPILE_TARGETS=linux-x64-baseline \
    FY_HOSTED_APP_ORIGIN=https://ferretry-v5.pages.dev bash scripts/release/compile.sh
)
# compile.sh names each program <name>-<target>; the kit's folders hold them under their plain names.
for name in fy fyd fyd-browser-worker; do
  install -m 0755 "${raw}/${name}-linux-x64-baseline" "${out}/${name}"
done
rm -rf "${raw}"
bun "${here}/slot.ts" stamp-v5 "${out}" "${full}"
