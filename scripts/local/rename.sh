#!/usr/bin/env bash
set -euo pipefail

# Rename the product in one shot. The bin key in packages/cli/package.json is the single source
# of the name; this script rewrites that key plus the few static files that cannot derive it
# (GoReleaser config, cask, installer, docs), then reports any leftovers.
#
# Usage: scripts/local/rename.sh <new-name>

new="${1:-}"
[ -z "${new}" ] && echo "❌ usage: $0 <new-name>" >&2 && exit 2
[[ ${new} =~ ^[a-z][a-z0-9-]*$ ]] || {
  echo "❌ new name must match ^[a-z][a-z0-9-]*$ (CLI-friendly, lowercase)" >&2
  exit 2
}

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

old="$(jq -r '.bin | to_entries[0].key' packages/cli/package.json)"
[ -z "${old}" ] || [ "${old}" = "null" ] && echo "❌ no .bin entry in packages/cli/package.json" >&2 && exit 1
[ "${old}" = "${new}" ] && echo "✅ already named '${new}' — nothing to do" && exit 0

echo "🔁 renaming '${old}' -> '${new}'"

# 1. The single source of truth: package name + bin key + entry path.
entry_old="$(jq -r '.bin | to_entries[0].value' packages/cli/package.json)"
entry_new="${entry_old/${old}/${new}}"
jq --arg old "${old}" --arg new "${new}" --arg entry "${entry_new}" \
  '.name = $new | .bin = { ($new): $entry }' \
  packages/cli/package.json >packages/cli/package.json.tmp
mv packages/cli/package.json.tmp packages/cli/package.json

# 2. Files whose *names* carry the product name.
git mv "packages/cli/${entry_old}" "packages/cli/${entry_new}"
git mv "Casks/${old}.rb" "Casks/${new}.rb"

# 3. Static configs and docs that cannot derive the name at runtime.
for file in \
  ".goreleaser.yaml" \
  "Casks/${new}.rb" \
  "go.mod" \
  "scripts/release/install.sh" \
  "INSTALLATION.md" \
  "README.md" \
  "packages/cli/tests/sit/driver.ts" \
  "packages/cli/${entry_new}"; do
  [ -f "${file}" ] && sed -i "s/${old}/${new}/g" "${file}"
done

# 4. Refresh the lockfile so the workspace package name matches.
bun install

echo ""
echo "🔎 leftover occurrences of '${old}' (fix by hand if any matter):"
rg -n --hidden -g '!.git' -g '!node_modules' "${old}" || echo "  (none)"

echo ""
echo "📝 remaining manual steps:"
echo "  - rename the repo directory / GitHub repo itself"
echo "  - re-run: task setup && task lint && task test"
echo "✅ rename complete: ${old} -> ${new}"
