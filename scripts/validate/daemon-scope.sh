#!/usr/bin/env bash
set -euo pipefail

# Fails when a PWA surface can read one daemon's data as another's. One browser can be paired to
# several daemons at once, and the ids a daemon mints are unique only within it, so anything the
# bundle remembers about daemon-owned data has to be keyed by (daemonId, …).
#
# The check needs cleaned source — comments blanked and string bodies emptied before a single
# pattern is matched, because a grep for `daemonId` passes on a file that only mentions it in a
# comment — so it lives in the sibling TypeScript module and this script is the repo-gate entry
# point around it.

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

walker="scripts/validate/daemon-scope.ts"
allowlist="scripts/validate/daemon-scope-allowlist.txt"

[ ! -f "${walker}" ] && echo "❌ missing daemon-scope walker: ${walker}" >&2 && exit 2
[ ! -f "${allowlist}" ] && echo "❌ missing daemon-scope allowlist: ${allowlist}" >&2 && exit 2
! command -v bun >/dev/null 2>&1 && echo "❌ bun is required to run ${walker}" >&2 && exit 2

exec bun "${walker}" "${root_dir}" "${allowlist}"
