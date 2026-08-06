#!/usr/bin/env bash
set -euo pipefail

# A closed set copied across independently compiled packages has no compiler at the join. The
# sibling TypeScript pass reads both enumerations and compares membership in both directions.

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

walker="scripts/validate/closed-set-agreement.ts"
[ ! -f "${walker}" ] && echo "❌ missing closed-set walker: ${walker}" >&2 && exit 2
! command -v bun >/dev/null 2>&1 && echo "❌ bun is required to run ${walker}" >&2 && exit 2

exec bun "${walker}" "${root_dir}"
