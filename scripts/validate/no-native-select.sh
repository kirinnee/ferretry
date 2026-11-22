#!/usr/bin/env bash
set -euo pipefail

# Keeps the browser's own `<select>` out of the app (owner, r11: "for dropdown, please use a custom component instead of the
# browser's default"). Every choice from a list is a `SelectBox` (packages/app/src/ui/select-box.tsx): drawn by the app, so
# every theme styles it, searchable, and a centred dialog on a phone.
#
# WHAT IS MATCHED. A JSX `<select` element (spaced, `>`-closed or compact `<select/>`) in a product `.tsx` file: `packages/app/src`,
# `packages/core/*/app` and `packages/plugins/*/app`, each searched recursively. The globs are component-bounded (`*` is one
# path component, `**` the descendants), so `packages/plugins/<id>/tests/**` and its fixtures are never reached.
#
# MODE. `fail` (the default since r11 S3f, the last adoption PR) makes any hit exit 1. `report` lists every file that still
# draws one and exits 0, for a local look. A line that is only a comment (`*`, `//`, `/*`, or closed `/* … */` blocks and nothing else) may name the element: it draws none.
# Code after a closed block comment (`/* x */ <select>`) still counts.
# `FY_NO_NATIVE_SELECT=fail|report` overrides it for a local run.
#
# Exit codes follow the repo convention: 0 clean (or report mode), 1 a violation in fail mode, 2 a broken gate.

MODE="fail"
MODE="${FY_NO_NATIVE_SELECT:-${MODE}}"
case "${MODE}" in
report | fail) ;;
*) echo "❌ FY_NO_NATIVE_SELECT must be report or fail, not '${MODE}'" >&2 && exit 2 ;;
esac

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

hits="$(mktemp)"
trap 'rm -f "${hits}" "${hits}.raw"' EXIT

status=0
git grep -n -E '<select([[:space:]/>]|$)' -- \
  ':(glob)packages/app/src/**/*.tsx' ':(glob)packages/core/*/app/**/*.tsx' ':(glob)packages/plugins/*/app/**/*.tsx' >"${hits}.raw" || status=$?
[ "${status}" -gt 1 ] && echo "❌ git grep failed (exit ${status}) while searching for native selects" >&2 && exit 2

# Drop a hit whose line is only a comment: the closed `/* … */` blocks at its start are removed first, so `/* x */ <select>`
# still counts (code follows the comment) while `/* <select/> */`, `// <select>` and ` * <select>` do not.
awk '
  {
    text = $0
    sub(/^[^:]*:[0-9]+:/, "", text)
    while (match(text, /^[[:space:]]*\/\*([^*]|\*+[^*\/])*\*+\//)) text = substr(text, RLENGTH + 1)
    if (text ~ /^[[:space:]]*(\*|\/\/|\/\*|$)/) next
    print
  }
' "${hits}.raw" >"${hits}"
rm -f "${hits}.raw"

if [ ! -s "${hits}" ]; then
  echo "✅ no native <select> in product code (every list choice is a SelectBox)"
  exit 0
fi

files="$(cut -d: -f1 "${hits}" | sort -u)"
count="$(wc -l <"${hits}" | tr -d ' ')"
file_count="$(printf '%s\n' "${files}" | wc -l | tr -d ' ')"
if [ "${MODE}" = "fail" ]; then
  echo "❌ ${count} native <select> element(s) in ${file_count} file(s); use SelectBox (packages/app/src/ui/select-box.tsx):" >&2
  sed 's/^/  /' "${hits}" >&2
  exit 1
fi
echo "ℹ️  report mode: ${count} native <select> element(s) in ${file_count} file(s) still to move to SelectBox:"
printf '%s\n' "${files}" | sed 's/^/  /'
