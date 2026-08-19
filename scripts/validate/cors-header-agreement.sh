#!/usr/bin/env bash
set -euo pipefail

# Header names are declared as constants and read through them, so the two lists that must agree are
# not grep-shaped text. The sibling TypeScript pass reads both as literals and compares membership in
# both directions. This is the repository-gate entry point that gives it a stable pre-commit command
# and validates its inputs.

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

walker="scripts/validate/cors-header-agreement.ts"
allowlist="scripts/validate/cors-header-agreement-allowlist.txt"

[ ! -f "${walker}" ] && echo "❌ missing cors-header-agreement walker: ${walker}" >&2 && exit 2
[ ! -f "${allowlist}" ] && echo "❌ missing cors-header-agreement allowlist: ${allowlist}" >&2 && exit 2
! command -v bun >/dev/null 2>&1 && echo "❌ bun is required to run ${walker}" >&2 && exit 2

exec bun "${walker}" "${root_dir}" "${allowlist}"
