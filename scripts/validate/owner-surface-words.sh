#!/usr/bin/env bash
set -euo pipefail

# Fails when a string the PWA can show makes a card the one asking: "your answer for the card", a "Card &F12:"
# heading, or the daemon's bookkeeping word "card ask" (docs/agenda.md § One model: the agenda asks, the card shows).
#
# The owner restated "cards have no actions" eight times in five days; each fix patched one screen and the words came
# back on the next, because nothing failed when they did — a test even pinned the wrong heading. This gate makes the
# rule a contract. It PARSES every PWA, agenda, board, mount and protocol source file (scripts/validate/owner-surface-words.ts) and reads only what can
# reach a screen — string and template literals and JSX text — so comments, identifiers (`cardAsk`) and data attributes
# (`data-agenda-card-ask`) never trip it.
#
# Exit codes follow the repo convention: 0 clean, 1 a violation, 2 a broken gate.

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

scanner="scripts/validate/owner-surface-words.ts"
[ ! -f "${scanner}" ] && echo "❌ missing owner-surface words scanner: ${scanner}" >&2 && exit 2
! command -v bun >/dev/null 2>&1 && echo "❌ bun is required to run ${scanner}" >&2 && exit 2

exec bun "${scanner}" "${root_dir}"
