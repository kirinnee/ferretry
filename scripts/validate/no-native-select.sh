#!/usr/bin/env bash
set -euo pipefail

# Keeps the browser's own `<select>` out of the app (owner, r11: "for dropdown, please use a custom component instead of the
# browser's default"). Every choice from a list is a `SelectBox` (packages/app/src/ui/select-box.tsx): drawn by the app, so
# every theme styles it, searchable, and a centred dialog on a phone.
#
# WHAT IS MATCHED. A JSX `<select` element in a product `.tsx` file: `packages/app/src`, `packages/core/*/app` and
# `packages/plugins/*/app`. Tests and fixtures are not product code.
#
# MODE. `report` (the default while the adoption PRs S3a-S3f land) lists every file that still draws one and exits 0.
# `fail` makes any hit exit 1. The flip is one word, `MODE` below, and belongs to r11 S3f, the last adoption PR.
# `FY_NO_NATIVE_SELECT=fail|report` overrides it for a local run.
#
# Exit codes follow the repo convention: 0 clean (or report mode), 1 a violation in fail mode, 2 a broken gate.

MODE="report"
MODE="${FY_NO_NATIVE_SELECT:-${MODE}}"
case "${MODE}" in
report | fail) ;;
*) echo "❌ FY_NO_NATIVE_SELECT must be report or fail, not '${MODE}'" >&2 && exit 2 ;;
esac

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

hits="$(mktemp)"
trap 'rm -f "${hits}"' EXIT

status=0
git grep -n -E '<select([[:space:]>]|$)' -- \
  'packages/app/src/**/*.tsx' 'packages/core/*/app/**/*.tsx' 'packages/plugins/*/app/**/*.tsx' >"${hits}" || status=$?
[ "${status}" -gt 1 ] && echo "❌ git grep failed (exit ${status}) while searching for native selects" >&2 && exit 2

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
