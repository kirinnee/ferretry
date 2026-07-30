#!/usr/bin/env bash
# Usage: mark-done.sh <state-file> <filename>
# Moves filename from pendingFiles to processedFiles.
set -euo pipefail

[ "$#" -eq 2 ] || {
  echo "❌ usage: $(basename "$0") <state-file> <filename>" >&2
  exit 1
}

STATE_FILE="$1"
FILENAME="$2"

[ -f "${STATE_FILE}" ] || {
  echo "❌ state file '${STATE_FILE}' does not exist" >&2
  exit 1
}

# Write to a temp file and move it into place so an interrupted run never
# leaves a truncated state file behind.
TEMP=$(mktemp "${STATE_FILE}.XXXXXX")
trap 'rm -f "${TEMP}"' EXIT

jq --arg f "${FILENAME}" \
  '.pendingFiles -= [$f] | .processedFiles += [$f] | .processedFiles |= unique' \
  "${STATE_FILE}" >"${TEMP}"

mv "${TEMP}" "${STATE_FILE}"
