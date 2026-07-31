#!/usr/bin/env bash
set -euo pipefail

# Typecheck every workspace project.
#
# The workspace is NOT one program. `packages/pwa` is browser code and needs the
# DOM lib; every other package is a Node/Bun program that must NOT be able to
# reach for `document` by accident. One `tsc --noEmit` over the whole tree would
# have to hand the DOM to all of them, so the root project excludes the PWA and
# the PWA is checked against its own config instead.

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

tsc="./node_modules/.bin/tsc"
[ ! -x "${tsc}" ] && echo "❌ typescript is not installed: ${tsc}" >&2 && exit 1

projects=(tsconfig.json)
while IFS= read -r project; do
  projects+=("${project}")
done < <(find packages -mindepth 2 -maxdepth 2 -name tsconfig.json | sort)

for project in "${projects[@]}"; do
  "${tsc}" --noEmit -p "${project}"
done

echo "✅ Typecheck passed: ${projects[*]}"
