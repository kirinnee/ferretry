#!/usr/bin/env bash
# Usage: <file-list> | init-state.sh <state-file> <source-paths-json> <concurrent> <output-dir>
# Reads the file list from stdin, one file per line.
set -euo pipefail

[ "$#" -eq 4 ] || {
  echo "❌ usage: <file-list> | $(basename "$0") <state-file> <source-paths-json> <concurrent> <output-dir>" >&2
  exit 1
}

STATE_FILE="$1"
SOURCE_PATHS="$2"
CONCURRENT="$3"
OUTPUT_DIR="$4"

# The caller only names the paths; this script owns creating them.
mkdir -p "$(dirname "${STATE_FILE}")" "${OUTPUT_DIR}"

FILES_JSON=$(jq -R -s 'split("\n") | map(select(. != ""))')

jq -n \
  --argjson sourcePaths "${SOURCE_PATHS}" \
  --arg outputDir "${OUTPUT_DIR}" \
  --argjson concurrent "${CONCURRENT}" \
  --argjson files "${FILES_JSON}" \
  --arg startTime "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{
    sourcePaths: $sourcePaths,
    outputDir: $outputDir,
    concurrentAgents: $concurrent,
    filesToProcess: $files,
    processedFiles: [],
    pendingFiles: $files,
    startTime: $startTime
  }' >"${STATE_FILE}"

echo "✅ Initialized '${STATE_FILE}' with $(jq 'length' <<<"${FILES_JSON}") files"
