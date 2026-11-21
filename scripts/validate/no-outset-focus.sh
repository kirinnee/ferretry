#!/usr/bin/env bash
set -euo pipefail

# A keyboard focus ring is drawn INSIDE its control, never outside it (britnee F, r11 S13: "focus rings clipped app-wide").
# An `outline-offset` that pushes the ring outward is painted past the element's border box, so any ancestor with an
# `overflow` other than visible (a scrolling list, a card, a sheet) cuts it. The rule is `outline-offset: calc(-1 *
# var(--focus-width))` (packages/app/src/styles/index.css); the real-browser measure is
# packages/app/tests/integration/focus-ring.visual.test.ts.
#
# WHAT IS MATCHED. An `outline-offset:` declaration in any `*.css` under `packages/` whose value pushes OUTWARD: a positive
# length (`2px`, `0.25rem`), or `var(--focus-offset ...)` (that token is positive in every style). A bare `0` is reported
# too: the ring then sits entirely outside the border box. A negative length and `calc(-1 * ...)` draw it inside and pass.
#
# MODE. `report` (the default until r11-3's gate) lists every declaration and exits 0. `fail` makes any hit exit 1. The flip is
# one word, `MODE` below, and belongs to r11-3's gate. `FY_NO_OUTSET_FOCUS=fail|report` overrides it for a local run.
#
# Exit codes follow the repo convention: 0 clean (or report mode), 1 a violation in fail mode, 2 a broken gate.

MODE="report"
MODE="${FY_NO_OUTSET_FOCUS:-${MODE}}"
case "${MODE}" in
report | fail) ;;
*) echo "❌ FY_NO_OUTSET_FOCUS must be report or fail, not '${MODE}'" >&2 && exit 2 ;;
esac

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

hits="$(mktemp)"
trap 'rm -f "${hits}"' EXIT

status=0
git grep -n -E 'outline-offset:[[:space:]]*(var\(--focus-offset|\+?(0*[1-9][0-9]*(\.[0-9]+)?|0*\.[0-9]*[1-9][0-9]*|0+(\.0+)?)(px|rem|em)?[[:space:]]*(;|!|\}|$))' -- \
  'packages/**/*.css' ':!**/node_modules/**' >"${hits}" || status=$?
[ "${status}" -gt 1 ] && echo "❌ git grep failed (exit ${status}) while searching for outset focus rings" >&2 && exit 2

if [ ! -s "${hits}" ]; then
  echo "✅ every keyboard focus ring is drawn inside its control (no outward outline-offset)"
  exit 0
fi

count="$(wc -l <"${hits}" | tr -d ' ')"
file_count="$(cut -d: -f1 "${hits}" | sort -u | wc -l | tr -d ' ')"
if [ "${MODE}" = "fail" ]; then
  echo "❌ ${count} outward outline-offset declaration(s) in ${file_count} file(s); draw the ring inside: calc(-1 * var(--focus-width)):" >&2
  sed 's/^/  /' "${hits}" >&2
  exit 1
fi
echo "ℹ️  report mode: ${count} outward outline-offset declaration(s) in ${file_count} file(s) still to draw inside:"
cut -d: -f1 "${hits}" | sort | uniq -c | sort -rn | sed 's/^/  /'
