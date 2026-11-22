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

# Shape 4: Tailwind utility classes in JSX, which the stylesheet greps above cannot see. `git grep -l` finds the files that name a
# 2-6px side-border class, the awk below reads each one with its comments blanked, and `grep` keeps the records (a line, or an
# element's opening tag across lines) that name both that class and an accent / tone colour.
cls_end='([^A-Za-z0-9_-]|$)'
cls_start='(^|[^A-Za-z0-9_-])([a-z0-9_&>[\]-]+:)*'
side="${cls_start}border-(l|s)-(\\[-?[2-6](\\.[0-9]+)?px\\]|[2-6]|heavy)${cls_end}"
hue="${cls_start}border-(accent|tone|warn|err|ok)(-[a-z]+)?(/[0-9]+)?${cls_end}|border-\\[[^]]*var\\(--(accent|tone|warn|err|ok)"
status=0
git grep -l -I -E -e "${side}" -- '*.tsx' >"${tmp_dir}/tw-files" 2>"${tmp_dir}/err" || status=$?
case "${status}" in
0 | 1) ;;
*)
  echo "❌ git grep failed (exit ${status}):" >&2
  cat "${tmp_dir}/err" >&2
  exit 2
  ;;
esac
# The awk turns each candidate file into `path:line:text` records with comments blanked (a `/* … */` block, also a JSX `{/* … */}`
# one, may span lines; a line that starts with `//` or `*` is a comment line). It emits every line, and every element's opening tag
# as ONE record (from its `<` to the `>` that closes it outside any `{ }`, lines joined by a space), so a side class and its tone
# class split across two lines of one string or one class list are read together while two neighbouring elements, or a closed tag
# and the code after it, never are. A `<` inside an opening tag (a comparison) does not end it. A string ('"`) is read whole, so a
# `/*` inside one is no comment; outside strings `/*` opens a comment only after the start of a line, a space or `{(;,}`.
if [ -s "${tmp_dir}/tw-files" ]; then
  # shellcheck disable=SC2016 # the awk program is single-quoted on purpose: its `$0` is awk's, not the shell's
  tr '\n' '\0' <"${tmp_dir}/tw-files" | xargs -0 awk '
    # `res` is the current line without its comments, `seg` the opening tag being read. Both are fed by add().
    function add(s) {
      res = res s
      if (intag) seg = seg s
    }
    function flush() {
      if (seg != "" && segline != segend) print file ":" segline ":" seg
      seg = ""
    }
    FNR == 1 { flush(); file = FILENAME; inblock = 0; instr = ""; intag = 0 }
    {
      line = $0
      res = ""
      if (!inblock && instr == "" && line ~ /^[[:space:]]*(\/\/|\*)/) next
      for (i = 1; i <= length(line); i++) {
        c = substr(line, i, 1)
        if (inblock) {
          if (c == "*" && substr(line, i + 1, 1) == "/") { inblock = 0; i++; add(" ") }
          continue
        }
        if (instr != "") {
          add(c)
          if (c == "\\") { i++; add(substr(line, i, 1)) }
          else if (c == instr) instr = ""
          continue
        }
        if (c == "\"" || c == "\047" || c == "`") { instr = c; add(c); continue }
        if (c == "/" && substr(line, i + 1, 1) == "*") {
          prev = (res == "") ? " " : substr(res, length(res), 1)
          if (prev ~ /[[:space:]{(;,}]/) { inblock = 1; i++; continue }
        }
        if (intag) {
          if (c == "{") depth++
          else if (c == "}" && depth > 0) depth--
          add(c)
          if (c == ">" && depth == 0) { segend = FNR; flush(); intag = 0 }
          continue
        }
        if (c == "<" && substr(line, i + 1, 1) ~ /[A-Za-z>]/ &&
            (res !~ /[A-Za-z0-9_)\]][[:space:]]*$/ || res ~ /(^|[^A-Za-z0-9_$])return[[:space:]]*$/)) {
          intag = 1; depth = 0; seg = ""; segline = FNR
        }
        add(c)
      }
      if (instr == "\047" || instr == "\"") { if (!intag) instr = "" }
      if (intag) { seg = seg " "; segend = FNR }
      if (res != "") print file ":" FNR ":" res
    }
    END { flush() }
  ' >"${tmp_dir}/tw"
  { grep -E -e "${side}" "${tmp_dir}/tw" || true; } | { grep -E -e "${hue}" || true; } >>"${tmp_dir}/lines"
fi

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
