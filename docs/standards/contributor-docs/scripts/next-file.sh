#!/usr/bin/env bash
# Usage: next-file.sh <state-file> [--batch N]
# Prints the next pending file(s), one per line. Empty output if none remain.
set -euo pipefail

[ "$#" -ge 1 ] || {
  echo "❌ usage: $(basename "$0") <state-file> [--batch N]" >&2
  exit 1
}

STATE_FILE="$1"
shift

BATCH=1
while [ "$#" -gt 0 ]; do
  case "$1" in
  --batch)
    BATCH="${2:-}"
    [ -n "${BATCH}" ] || {
      echo "❌ '--batch' needs a value" >&2
      exit 1
    }
    shift 2
    ;;
  *) shift ;;
  esac
done

[ -f "${STATE_FILE}" ] || {
  echo "❌ state file '${STATE_FILE}' does not exist" >&2
  exit 1
}

PENDING=$(jq -r --argjson n "${BATCH}" '.pendingFiles[:$n][]' "${STATE_FILE}")

if [ -n "${PENDING}" ]; then
  echo "${PENDING}"
fi
