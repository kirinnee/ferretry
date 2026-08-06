#!/usr/bin/env bash
set -euo pipefail

# The lexical walk is TypeScript because route paths are expressions, not grep-shaped text. This is
# the repository-gate entry point that gives it a stable pre-commit command and validates its inputs.

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

walker="scripts/validate/route-agreement.ts"
allowlist="scripts/validate/route-agreement-allowlist.txt"

[ ! -f "${walker}" ] && echo "❌ missing route-agreement walker: ${walker}" >&2 && exit 2
[ ! -f "${allowlist}" ] && echo "❌ missing route-agreement allowlist: ${allowlist}" >&2 && exit 2
! command -v bun >/dev/null 2>&1 && echo "❌ bun is required to run ${walker}" >&2 && exit 2

exec bun "${walker}" "${root_dir}" "${allowlist}"
