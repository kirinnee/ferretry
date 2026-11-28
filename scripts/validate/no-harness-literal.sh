#!/usr/bin/env bash
set -euo pipefail

# Fails when Runtimes' daemon names a shipped harness by a string literal: `'claude'` or `'codex'` in packages/plugins/runtimes/daemon.
#
# WHY. What a harness DOES inside Runtimes is its plugin's (claude-code, codex) `RuntimesHarnessKit` (E-276), looked up by the
# harness a runtime is for. A literal `'claude'` or `'codex'` in a Runtimes daemon file is the old `x === 'claude' ? <Claude> : <Codex>`
# in another spelling: a third harness would quietly get one of the two answers. A harness's stored word lives in four files and
# nowhere else (they are the stored file shapes and the one table of words: lib/harness-kind.ts, lib/account/schema.ts,
# lib/account/halves.ts, lib/config.ts).
#
# HOW. `no-harness-literal.ts` reads every tracked packages/plugins/runtimes/daemon/**/*.ts(x), drops comments, and counts the
# string literals that are exactly `claude` or `codex` (either quote style, or a template with no placeholder), per file.
#
# THE LIST. `scripts/validate/no-harness-literal-remaining.txt` names what a part of E-276 has not moved yet as `path::N  # why`.
# It is a named, shrinking list and never an exemption: exact both ways against the tree (a new literal, a higher count, or a
# row for a file that is now clean all fail) and a ratchet against the base ref (CI's FY_CHECK_BASE; origin/rebuild/5.0-after
# locally): a row the base does not hold, or a count above the base's, fails.
#
# `--print` writes the rows for the current tree. Exit codes follow the repo convention: 0 clean, 1 a violation, 2 a broken gate.

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

scanner="scripts/validate/no-harness-literal.ts"
[ ! -f "${scanner}" ] && echo "❌ missing scanner: ${scanner}" >&2 && exit 2
! command -v bun >/dev/null 2>&1 && echo "❌ bun is required to run ${scanner}" >&2 && exit 2

exec bun "${scanner}" "${root_dir}" "$@"
