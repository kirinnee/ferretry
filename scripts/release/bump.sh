#!/usr/bin/env bash
set -euo pipefail

version="${1:-}"
[ -z "${version}" ] && echo "❌ version argument not set" >&2 && exit 1

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

# BOTH shipped executables, because both stamp their own manifest version into what they report.
# The daemon was omitted here, so every daemon ever released answered `/v1/health` and its own
# version header with 0.0.0 — a version skew check would have rejected all of them, and a person
# reading 0.0.0 on a fresh install reasonably concludes the thing is broken.
git checkout HEAD -- packages/cli/package.json packages/daemon/package.json VERSION
for package_dir in packages/cli packages/daemon; do
  (cd "${package_dir}" && bun pm pkg set "version=${version#v}")
done
printf '%s\n' "${version#v}" >VERSION

echo "✅ packages/cli/package.json, packages/daemon/package.json and VERSION stamped to ${version#v}"
