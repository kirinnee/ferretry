#!/usr/bin/env bash
set -euo pipefail

# One perf `bun test` process over the files it is given, swept and stall-watched like every other tier process.
# Usage: perf-run-files.sh <out-dir> <test-file>...
# Writes <out-dir>/junit.xml and <out-dir>/console.log and exits with bun's own status. `scripts/ci/perf-tier.sh`
# is its only caller (it can be pointed at another executable through FY_PERF_RUN_FILES, which its test does).
out_dir="${1:?output directory required}"
shift
[[ $# -ge 1 ]] || { echo "❌ usage: $0 <out-dir> <test-file>..." >&2 && exit 2; }
mkdir -p "${out_dir}"
exec ./scripts/test/swept.sh bun scripts/test/stall-watch.ts "${FY_TEST_STALL_SECONDS:-300}" -- \
  bun test --config=bunfig.perf.toml --timeout 120000 --reporter=junit --reporter-outfile="${out_dir}/junit.xml" "$@" \
  >"${out_dir}/console.log" 2>&1
