#!/usr/bin/env bash
set -euo pipefail

# Fails when production code under packages/*/src/** is never used by its package's composition
# root. The walk itself needs a real module graph — resolved specifiers, named imports, and
# barrels that only forward the names someone actually asked for — so it lives in the sibling
# TypeScript module and this script is the repo-gate entry point around it.

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

walker="scripts/validate/composition-reachability.ts"
allowlist="scripts/validate/reachability-allowlist.txt"

[ ! -f "${walker}" ] && echo "❌ missing reachability walker: ${walker}" >&2 && exit 2
[ ! -f "${allowlist}" ] && echo "❌ missing reachability allowlist: ${allowlist}" >&2 && exit 2
! command -v bun >/dev/null 2>&1 && echo "❌ bun is required to run ${walker}" >&2 && exit 2

exec bun "${walker}" "${root_dir}" "${allowlist}"
