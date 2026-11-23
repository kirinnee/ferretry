#!/usr/bin/env bash
set -euo pipefail

# Fails when product code outside the two harness plugins names the shipped harnesses as a CLOSED set.
#
# WHY. A third harness must never quietly get Claude's paths, flags or parser (runtimes plan, risk 1). A closed union
# `'claude' | 'codex'`, or a two-way `harness === 'codex' ? … : <Claude>`, is exactly that quiet default. A consumer reads a
# harness through the registry (`HarnessKey`, `harnessFacts(key)`) and refuses a key it does not know, in ONE place.
#
# HOW. `no-closed-harness.ts` counts by SYNTAX across the whole file (not line by line), in every tracked
# `packages/**/*.ts(x)` outside tests, the two harness plugins (packages/plugins/claude-code, packages/plugins/codex) and the
# file that declares the shipped keys (packages/core/ferrets/contract/ids.ts). One count per file and kind:
#   literal  a closed union, array or tuple of the two: `'claude' | 'codex'`, `["claude-code", "codex",]`, either quote style,
#            either order, split over any number of lines (a `z.enum([...])` of them is the array shape)
#   known    U4a's transitional closed spelling: `KnownHarnessKey`, `KnownHarnessKeySchema`, `isKnownHarnessKey`,
#            `KNOWN_HARNESS_KEYS`
#   branch   a harness-named operand compared with `==`/`===`/`!=`/`!==` to `'claude'`, `'claude-code'` or `'codex'`
#            (`resolution.harness === 'codex'`, `'codex' === harnessKey`). Only operands whose name ends in `harness`,
#            `harnessKey` or `harnessKind` count, so a provider, catalog half, tool or login preset that happens to be
#            called `claude` is not a hit. A `case 'codex':` and a compare through a differently named variable are
#            not seen: the unit that sweeps a file reads it whole.
# EVERY occurrence counts, so a second literal on a line that already holds one is a second hit.
#
# THE LEDGER. `scripts/validate/no-closed-harness-allowlist.txt` lists today's offenders as `path::kind=N  # part`. A part
# of the sweep deletes its rows; it can never add one. Two checks, both always on:
#   exact   against the CURRENT tree, both ways: a new offender, a higher count, and a listed row that is now lower or gone
#           all fail, so a stale row cannot hide a new hit.
#   ratchet against the BASE ledger (CI's FY_CHECK_BASE, scripts/ci/check-base.sh; origin/rebuild/5.0-after locally): a row
#           the base does not hold, or a count above the base's, fails, so a new union cannot be blessed by adding its own
#           row. A base with no ledger is the bootstrap; a base that cannot be read fails (exit 2), never skipped.
#
# `--print` writes the rows for the current tree (to rebuild a ledger line, not to bless a new offender).
# Exit codes follow the repo convention: 0 clean, 1 a violation, 2 a broken gate.

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

scanner="scripts/validate/no-closed-harness.ts"
[ ! -f "${scanner}" ] && echo "❌ missing scanner: ${scanner}" >&2 && exit 2
! command -v bun >/dev/null 2>&1 && echo "❌ bun is required to run ${scanner}" >&2 && exit 2

exec bun "${scanner}" "${root_dir}" "$@"
