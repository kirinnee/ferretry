#!/usr/bin/env bash
set -euo pipefail

# Fails when product code outside the two harness plugins names the shipped harnesses as a CLOSED set.
#
# WHY. A third harness must never quietly get Claude's paths, flags or parser (runtimes plan, risk 1). A closed union
# `'claude' | 'codex'`, or a two-way `harness === 'codex' ? … : <Claude>`, is exactly that quiet default. A consumer reads a
# harness through the registry (`HarnessKey`, `harnessFacts(key)`) and refuses a key it does not know, in ONE place.
#
# WHAT IS MATCHED, in every tracked `packages/**/*.ts(x)` outside tests, the two harness plugins
# (packages/plugins/claude-code, packages/plugins/codex) and the file that declares the shipped keys
# (packages/core/ferrets/contract/ids.ts). One count per file and kind:
#   literal  a closed union, array or tuple of the two: `'claude' | 'codex'`, `['claude-code', 'codex']`, either spelling
#            and either order (a `z.enum([...])` of them is the array shape)
#   known    U4a's transitional closed spelling: `KnownHarnessKey`, `KnownHarnessKeySchema`, `isKnownHarnessKey`,
#            `KNOWN_HARNESS_KEYS`
#   branch   a harness-named operand compared with `===` / `!==` to `'claude'`, `'claude-code'` or `'codex'`
#            (`resolution.harness === 'codex'`, `'codex' === harnessKey`). Only operands whose name ends in `harness`,
#            `harnessKey` or `harnessKind` count, so a provider, catalog half, tool or login preset that happens to be
#            called `claude` is not a hit. A `case 'codex':` and a compare through a differently named variable are
#            not seen: the unit that sweeps a file reads it whole.
#
# THE LEDGER. `scripts/validate/no-closed-harness-allowlist.txt` lists today's offenders as `path::kind=N  # part`. A part
# of the sweep deletes its rows; it can never add one. EXACT BOTH WAYS: a new offender, a higher count, and a listed
# row that is now lower or gone all fail, so the ledger only shrinks and a stale row cannot hide a new hit.
#
# `--print` writes the rows for the current tree (to rebuild a ledger line, not to bless a new offender).
# Exit codes follow the repo convention: 0 clean, 1 a violation, 2 a broken gate.

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

ledger="scripts/validate/no-closed-harness-allowlist.txt"
[ ! -f "${ledger}" ] && echo "❌ missing ledger: ${ledger}" >&2 && exit 2

tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT

# Case-insensitive on `Harness` only through the explicit alternatives: `harness`, `Harness`.
name='[A-Za-z_.?]*[Hh]arness(Key|Kind)?[]?]*'
lit='(claude|claude-code|codex)'

# `path:kind` lines, one per matching line.
scan() {
  local kind="$1"
  shift
  local status=0
  git grep -n -I -E "$@" -- 'packages/**/*.ts' 'packages/**/*.tsx' \
    ':!packages/**/tests/**' ':!packages/plugins/claude-code/**' ':!packages/plugins/codex/**' \
    ':!packages/core/ferrets/contract/ids.ts' >"${tmp_dir}/hits" 2>"${tmp_dir}/err" || status=$?
  case "${status}" in
  0) cut -d: -f1 "${tmp_dir}/hits" | awk -v kind="${kind}" '{ print $0 "::" kind }' ;;
  1) ;;
  *)
    echo "❌ git grep failed (exit ${status}):" >&2
    cat "${tmp_dir}/err" >&2
    exit 2
    ;;
  esac
}

{
  scan literal \
    -e "'(claude|claude-code)'[[:space:]]*\|[[:space:]]*'codex'" \
    -e "'codex'[[:space:]]*\|[[:space:]]*'(claude|claude-code)'" \
    -e "\[[[:space:]]*'(claude|claude-code)',[[:space:]]*'codex'[[:space:]]*\]" \
    -e "\[[[:space:]]*'codex',[[:space:]]*'(claude|claude-code)'[[:space:]]*\]"
  scan known -e 'KnownHarnessKey|isKnownHarnessKey|KNOWN_HARNESS_KEYS'
  scan branch \
    -e "${name}[[:space:]]*(===|!==)[[:space:]]*'${lit}'" \
    -e "'${lit}'[[:space:]]*(===|!==)[[:space:]]*${name}"
} | LC_ALL=C sort | uniq -c | awk '{ print $2 "=" $1 }' | sed -E 's/^(.*)::(.*)=([0-9]+)$/\1::\2=\3/' >"${tmp_dir}/actual"

if [ "${1:-}" = "--print" ]; then
  cat "${tmp_dir}/actual"
  exit 0
fi

# The ledger without comments and blank lines, in the same shape and order (byte order, so `comm` agrees with `sort`).
sed -E 's/[[:space:]]*#.*$//; /^[[:space:]]*$/d' "${ledger}" | LC_ALL=C sort >"${tmp_dir}/listed"
LC_ALL=C sort "${tmp_dir}/actual" -o "${tmp_dir}/actual"

# `comm` rather than `diff`: the pre-commit environment carries coreutils only.
LC_ALL=C comm -23 "${tmp_dir}/listed" "${tmp_dir}/actual" | sed 's/^/< /' >"${tmp_dir}/delta"
LC_ALL=C comm -13 "${tmp_dir}/listed" "${tmp_dir}/actual" | sed 's/^/> /' >>"${tmp_dir}/delta"
if [ ! -s "${tmp_dir}/delta" ]; then
  exit 0
fi

echo "❌ a closed harness set outside the two harness plugins differs from its ledger (${ledger})." >&2
echo "   '<' is the ledger, '>' is the code. A '>' row is a NEW (or more) closed use: read the harness through HarnessKey" >&2
echo "   and harnessFacts(key), and refuse a key you do not know with the shared refusal. A '<' row is a part that is now" >&2
echo "   clean or lower: delete or lower its row." >&2
cat "${tmp_dir}/delta" >&2
exit 1
