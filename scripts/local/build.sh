#!/usr/bin/env bash
set -euo pipefail

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

CLI_PKG="packages/cli"
entry="$(jq -r '.bin | to_entries[0].value' "${CLI_PKG}/package.json")"
[[ -z ${entry} || ${entry} == "null" ]] && echo "❌ no .bin entry in ${CLI_PKG}/package.json" >&2 && exit 1
artifact="dist/$(basename "${entry}" .ts).js"

echo "🔨 Building CLI bundle..."
bun build "./${CLI_PKG}/${entry}" --outdir ./dist --target bun

[[ ! -f ${artifact} ]] && echo "❌ Build artifact missing: ${artifact}" >&2 && exit 1
echo "✅ Build artifact present: ${artifact}"
