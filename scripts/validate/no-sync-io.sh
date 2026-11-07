#!/usr/bin/env bash
set -euo pipefail

# Fails when daemon code gains a blocking file call (or `spawnSync`) that the ledger does not list.
#
# WHY. The daemon's main thread answers every client, and a synchronous call holds it for as long as the
# disk takes. On 2026-11-05 the owner's daemon stalled for up to 61.9 s while swap saturated its disk; a
# synchronous `fsync` there had measured 38 s before. Async calls run on the runtime's I/O threads, so the
# loop keeps answering while the disk is slow.
#
# HOW. `no-sync-io.ts` parses every tracked TypeScript file of a daemon half (`packages/core/*/daemon`,
# `packages/plugins/*/daemon`) and of the kernel host (`packages/core/kernel/host`), and counts each use of a blocking
# function as a value — nested calls, `fs.x()`, `x.native()` and references handed on included — and refuses
# any import or destructuring that binds one to another name. Its header says exactly what counts and why a
# regular expression was not enough.
#
# THE LEDGER (`scripts/validate/sync-io-allowlist.txt`) holds the exact count per file and the reason each
# remaining use may block. EXACT BOTH WAYS: more fails (a new blocking call), fewer fails too (lower the
# line), so the ledger is always the true inventory rather than a ceiling that drifts.
#
# Exit codes follow the repo convention: 0 clean, 1 a violation, 2 a broken gate.

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

walker="scripts/validate/no-sync-io.ts"
[ ! -f "${walker}" ] && echo "❌ missing synchronous-IO counter: ${walker}" >&2 && exit 2
! command -v bun >/dev/null 2>&1 && echo "❌ bun is required to run ${walker}" >&2 && exit 2

exec bun "${walker}" "${root_dir}"
