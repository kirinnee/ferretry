#!/usr/bin/env bash
set -euo pipefail

version="${1:-}"
[ -z "${version}" ] && echo "❌ version argument not set" >&2 && exit 1

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

git checkout HEAD -- packages/cli/package.json VERSION
(cd packages/cli && bun pm pkg set "version=${version#v}")
printf '%s\n' "${version#v}" >VERSION

echo "✅ packages/cli/package.json and VERSION stamped to ${version#v}"
