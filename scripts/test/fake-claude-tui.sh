#!/bin/sh
# A stand-in for the `claude` TUI, for the full-product E2E journeys. Never a real account.
#
# What a session needs from a harness, and nothing more:
#   - a prompt the daemon recognises as ready (`> ` at column 0, redrawn after every line, or the
#     turn "lands but stays in the composer" — see scripts/release/smoke.sh);
#   - a Claude JSONL transcript at the path the daemon recorded for this launch:
#     <CLAUDE_CONFIG_DIR>/projects/<cwd with every non-alphanumeric as '-'>/<--session-id>.jsonl
#     so the app has a real transcript to render, with a reply this run can recognise.
#
# `--version` answers like the real CLI so the setup scan can call it installed.
set -u

case "${1:-}" in
--version | -v)
  echo "2.1.0 (Claude Code)"
  exit 0
  ;;
esac

sid=""
prev=""
for arg in "$@"; do
  [ "${prev}" = "--session-id" ] && sid="${arg}"
  prev="${arg}"
done
[ -n "${sid}" ] || sid="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || date +%s)"

config="${CLAUDE_CONFIG_DIR:-${HOME}/.claude}"
project="$(pwd | sed 's/[^A-Za-z0-9]/-/g')"
dir="${config}/projects/${project}"
mkdir -p "${dir}"
transcript="${dir}/${sid}.jsonl"
[ -n "${FY_E2E_FAKE_CLAUDE_LOG:-}" ] && printf '%s\t%s\t%s\n' "$(pwd)" "${transcript}" "$*" >>"${FY_E2E_FAKE_CLAUDE_LOG}"

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

record() {
  # $1 role, $2 uuid, $3 parent, $4 text
  at="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  parent='null'
  [ -n "$3" ] && parent="\"$3\""
  printf '{"type":"%s","uuid":"%s","parentUuid":%s,"sessionId":"%s","timestamp":"%s","message":{"role":"%s","content":[{"type":"text","text":"%s"}]}}\n' \
    "$1" "$2" "${parent}" "${sid}" "${at}" "$1" "$(json_escape "$4")" >>"${transcript}"
}

printf 'Fake Claude ready\n> '
n=0
last=""
while IFS= read -r line; do
  n=$((n + 1))
  record user "u${n}-${sid}" "${last}" "${line}"
  record assistant "a${n}-${sid}" "u${n}-${sid}" "FAKE-REPLY ${n}: I read \"${line}\""
  last="a${n}-${sid}"
  printf 'working\n> '
done
exec sleep 600
