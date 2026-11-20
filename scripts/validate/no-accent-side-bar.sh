#!/usr/bin/env bash
set -euo pipefail

# Fails when a stylesheet draws a coloured bar on the side of a selected or current item.
#
# WHY. The owner said of the settings nav's current item: "this side highlight thing is VERY LLM, please dont use it"
# (r11 S2). A selected item reads by a soft fill, the body colour and a heavier weight; never by a 2-6px accent strip
# down its leading edge. Style files are included, so every style keeps the rule.
#
# WHAT IS MATCHED, in every tracked `*.css` file (the exact shapes the product had):
#   1. an inset shadow that is a bar:            `inset 3px 0 0 <colour>`, `inset -3px 0 0 <colour>`, and the colourless
#      `inset 3px 0 0;` (the shadow then takes the element's current colour, so it still draws a bar)
#   2. a 2-6px accent or tone border on one side: `border-left: 3px solid var(--accent)`, `border-inline-start`, the
#      `-width` and `-color` longhands pointing at `var(--accent…)` / `var(--tone…)`
#   3. a 2-6px wide `::before` / `::after` that paints an accent or tone background
# A neutral 1px divider, a hard offset shadow (`3px 3px 0`) and a round dot are not bars.
#
# THE LEDGER. `scripts/validate/no-accent-side-bar-allowlist.txt` lists the files whose bar is still owned by an open
# r11 theme unit; the unit that removes the bar deletes its line. EXACT BOTH WAYS: a listed file with no bar left fails too.
#
# Exit codes follow the repo convention: 0 clean, 1 a violation, 2 a broken gate.

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

ledger="scripts/validate/no-accent-side-bar-allowlist.txt"
[ ! -f "${ledger}" ] && echo "❌ missing ledger: ${ledger}" >&2 && exit 2

tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT

num='-?[2-6](\.[0-9]+)?px'
zero='0(px)?'
tone='var\(--(accent|tone)'
# What may follow the last zero of an inset bar: a colour (whitespace), or no colour at all, which draws currentColor.
# So a declaration or list delimiter, `!important`, a closing paren or the end of the line also ends the shape.
end='([[:space:];,!)}]|$)'

# `path:line:text` hits of shapes 1 and 2.
status=0
git grep -n -I -E \
  -e "inset[[:space:]]+${num}[[:space:]]+${zero}[[:space:]]+${zero}${end}" \
  -e "border-(left|inline-start)(-width)?:[[:space:]]*${num}[[:space:]]+(solid|dashed|double)[[:space:]]+${tone}" \
  -e "border-(left|inline-start)-color:[[:space:]]*${tone}" \
  -- '*.css' >"${tmp_dir}/lines" 2>"${tmp_dir}/err" || status=$?
case "${status}" in
0 | 1) ;;
*)
  echo "❌ git grep failed (exit ${status}):" >&2
  cat "${tmp_dir}/err" >&2
  exit 2
  ;;
esac

# Shape 3: a `::before` / `::after` block 2-6px wide that paints the accent or tone.
git ls-files -- '*.css' | while IFS= read -r file; do
  awk -v file="${file}" '
    /\{/ { sel = $0; start = NR; strip = 0; paint = 0 }
    sel ~ /::(before|after)/ && /(^|[^-])(inline-size|width):[[:space:]]*-?[2-6](\.[0-9]+)?px/ { strip = 1 }
    sel ~ /::(before|after)/ && /background(-color)?:[[:space:]]*var\(--(accent|tone)/ { paint = 1 }
    /\}/ { if (strip && paint) print file ":" start ":" sel; strip = 0; paint = 0; sel = "" }
  ' "${file}"
done >>"${tmp_dir}/lines"

sort -u "${tmp_dir}/lines" -o "${tmp_dir}/lines"
sed -E 's/^([^:]+):.*/\1/' "${tmp_dir}/lines" | sort -u >"${tmp_dir}/hit-files"
{ sed -E 's/[[:space:]]*#.*$//; /^[[:space:]]*$/d' "${ledger}" || true; } | sort -u >"${tmp_dir}/listed"

problems=0
while IFS= read -r file; do
  [ -z "${file}" ] && continue
  if ! grep -qxF "${file}" "${tmp_dir}/listed"; then
    if [ "${problems}" -eq 0 ]; then echo "❌ an accent bar on the side of a selected item:" >&2; fi
    problems=1
    grep -E "^${file//./\\.}:" "${tmp_dir}/lines" | sed 's/^/  /' >&2
  fi
done <"${tmp_dir}/hit-files"
if [ "${problems}" -ne 0 ]; then
  cat >&2 <<'GUIDANCE'

A current or selected item reads by a soft fill (`var(--accent-soft)`), the body colour and a 600 weight, never a side bar.
GUIDANCE
  exit 1
fi

while IFS= read -r file; do
  if ! grep -qxF "${file}" "${tmp_dir}/hit-files"; then
    echo "❌ ${ledger} lists ${file}, which has no accent bar left: delete its line" >&2
    problems=1
  fi
done <"${tmp_dir}/listed"
[ "${problems}" -ne 0 ] && exit 1

echo "✅ no stylesheet draws an accent bar on a selected item ($(wc -l <"${tmp_dir}/listed" | tr -d ' ') declared)"
