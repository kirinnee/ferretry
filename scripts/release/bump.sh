#!/usr/bin/env bash
set -euo pipefail

version="${1:-}"
[ -z "${version}" ] && echo "❌ version argument not set" >&2 && exit 1

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

# BOTH shipped executables, because both stamp their own manifest version into what they report: the
# CLI (packages/cli) and the daemon host, which is the kernel (packages/core/kernel). A 4.x release that
# skipped the daemon shipped a daemon answering `/v1/health` with 0.0.0.
git checkout HEAD -- packages/cli/package.json packages/core/kernel/package.json VERSION
for package_dir in packages/cli packages/core/kernel; do
  (cd "${package_dir}" && bun pm pkg set "version=${version#v}")
done
printf '%s\n' "${version#v}" >VERSION

echo "✅ packages/cli/package.json, packages/core/kernel/package.json and VERSION stamped to ${version#v}"
