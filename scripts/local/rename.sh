#!/usr/bin/env bash
set -euo pipefail

# Rename the product and/or the CLI binary in one shot (two-name model).
#   PRODUCT name — root package.json `name` (repo, goreleaser project_name, cask, tap, installer repo)
#   BINARY  name — `bin` key in packages/cli/package.json (binary, archives, entry file, cask binary stanza)
# This script rewrites those sources plus the few static files that cannot derive them,
# then reports any leftovers.
#
# Usage: scripts/local/rename.sh [--product <name>] [--bin <name>]

new_product=""
new_bin=""
while [ "$#" -gt 0 ]; do
  case "$1" in
  --product)
    new_product="${2:-}"
    shift 2
    ;;
  --bin)
    new_bin="${2:-}"
    shift 2
    ;;
  *)
    echo "❌ usage: $0 [--product <name>] [--bin <name>]" >&2
    exit 2
    ;;
  esac
done
[ -z "${new_product}" ] && [ -z "${new_bin}" ] && echo "❌ usage: $0 [--product <name>] [--bin <name>]" >&2 && exit 2
for value in ${new_product:+"${new_product}"} ${new_bin:+"${new_bin}"}; do
  [[ ${value} =~ ^[a-z][a-z0-9-]*$ ]] || {
    echo "❌ names must match ^[a-z][a-z0-9-]*$ (CLI-friendly, lowercase), got '${value}'" >&2
    exit 2
  }
done

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

old_product="$(jq -r '.name' package.json)"
old_bin="$(jq -r '.bin | to_entries[0].key' packages/cli/package.json)"
[ -z "${old_bin}" ] || [ "${old_bin}" = "null" ] && echo "❌ no .bin entry in packages/cli/package.json" >&2 && exit 1

# The static files that carry either name; sed rewrites are word-bounded so short binary
# names cannot clobber substrings.
static_files=(
  ".goreleaser.yaml"
  "go.mod"
  "scripts/release/install.sh"
  "INSTALLATION.md"
  "README.md"
  "CLAUDE.md"
)

rewrite() {
  local old="$1" new="$2" file
  for file in "${static_files[@]}" Casks/*.rb; do
    [ -f "${file}" ] && sed -i "s/\b${old}\b/${new}/g" "${file}"
  done
}

if [ -n "${new_product}" ] && [ "${new_product}" != "${old_product}" ]; then
  echo "🔁 product: '${old_product}' -> '${new_product}'"
  jq --arg new "${new_product}" '.name = $new' package.json >package.json.tmp
  mv package.json.tmp package.json
  git mv "Casks/${old_product}.rb" "Casks/${new_product}.rb"
  rewrite "${old_product}" "${new_product}"
fi

if [ -n "${new_bin}" ] && [ "${new_bin}" != "${old_bin}" ]; then
  echo "🔁 binary: '${old_bin}' -> '${new_bin}'"
  entry_old="$(jq -r '.bin | to_entries[0].value' packages/cli/package.json)"
  entry_new="bin/${new_bin}.ts"
  jq --arg new "${new_bin}" --arg entry "${entry_new}" \
    '.name = $new | .bin = { ($new): $entry }' \
    packages/cli/package.json >packages/cli/package.json.tmp
  mv packages/cli/package.json.tmp packages/cli/package.json
  git mv "packages/cli/${entry_old}" "packages/cli/${entry_new}"
  sed -i "s|bin/${old_bin}|bin/${new_bin}|g" packages/cli/tests/sit/driver.ts
  rewrite "${old_bin}" "${new_bin}"
fi

# Refresh the lockfile so the workspace package names match.
bun install

echo ""
for old in "${old_product}" "${old_bin}"; do
  echo "🔎 leftover occurrences of '${old}' (fix by hand if any matter):"
  rg -n --hidden -g '!.git' -g '!node_modules' "\b${old}\b" || echo "  (none)"
done

echo ""
echo "📝 remaining manual steps:"
echo "  - rename the repo directory / GitHub repo itself (product renames)"
echo "  - re-run: task setup && task lint && task test"
echo "✅ rename complete"
