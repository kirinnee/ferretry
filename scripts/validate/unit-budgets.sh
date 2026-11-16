#!/usr/bin/env bash
set -euo pipefail
#
# NO SPEED OR SIZE BUDGET IN THE UNIT TIER (scripts/validate/test-tiers.sh runs this; docs/standards/testing).
#
#   unit-budgets.sh
#
root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"
failures=0
refuse() {
  echo "❌ $*" >&2
  failures=$((failures + 1))
}
# The upper-bound assertions, spelled as test-tiers.sh's integration rule spells them.
upper='\.(below|belowOrEqual|lessThan|lessThanOrEqual)\(|toBeLessThan(OrEqual)?\('
# Owner, 2026-11-16: "dont mix performance and correctness test together". A unit test proves behaviour; a claim
# about how fast or how small the code ran is the PERF tier's (<package>/tests/perf/, bunfig.perf.toml, its own CI
# job on a runner with nothing else on it). A unit file may not read a real clock, CPU or memory counter, nor feed a
# clock difference or a named duration to an upper bound. A fake that REPLACES a clock marks the line
# `// not-a-budget: <reason>` (listed below for the reviewer). `config/perf-pending.txt` lists the files not moved yet:
# it only shrinks, and a listed file with nothing left to move fails too, so the list cannot rot.
budget_reads='(performance\.(now|measure)|Bun\.nanoseconds|process\.(hrtime(\.bigint)?|cpuUsage|threadCpuUsage|resourceUsage|memoryUsage))\('
unit_budget_claims=(
  "${budget_reads}"
  'linear-time'
  "Date\\.now\\(\\).*(${upper})"
  "(should|expect)\\(\\s*\\w*(elapsed|took|duration|latency|slice)\\w*[^)]*\\)\\.(be\\.|not\\.)?(${upper#\\.})"
  "(rss|heapUsed|addedMb|residentMb)[^;]*(${upper})"
)
perf_pending="config/perf-pending.txt"
declare -A pending_unit=()
if [[ -f ${perf_pending} ]]; then
  while IFS= read -r entry; do
    [[ -z ${entry} || ${entry} == \#* ]] && continue
    pending_unit[${entry}]=1
  done <"${perf_pending}"
fi
budget_args=()
for pattern in "${unit_budget_claims[@]}"; do budget_args+=(-e "${pattern}"); done
declare -A budget_files=()
not_a_budget=0
while IFS=: read -r file line text; do
  [[ -n ${file} ]] || continue
  if [[ ${text} =~ //[[:space:]]*not-a-budget:[[:space:]]*([^[:space:]].*)$ ]]; then
    not_a_budget=$((not_a_budget + 1))
    echo "  not a budget: ${file}:${line}: ${BASH_REMATCH[1]}"
    continue
  fi
  [[ ${text} =~ //[[:space:]]*not-a-budget ]] &&
    refuse "${file}:${line}: a not-a-budget marker needs a reason: say what the clock read is for"
  budget_files[${file}]=1
  [[ -n ${pending_unit[${file}]:-} ]] && continue
  refuse "${file}:${line}: the unit tier holds a speed or size budget (${text#"${text%%[![:space:]]*}"}); move the budget to ${file/\/tests\/unit\//\/tests\/perf\/} (the perf tier) and keep the correctness check here at a small size"
done < <(rg -n --no-heading "${budget_args[@]}" --glob '**/tests/unit/**' packages || true)
for entry in "${!pending_unit[@]}"; do
  [[ -n ${budget_files[${entry}]:-} ]] ||
    refuse "${perf_pending}: ${entry} holds no speed or size budget any more (or is gone); delete its line"
done
echo "unit files still holding a speed or size budget (${perf_pending}): ${#pending_unit[@]}; not-a-budget clock reads: ${not_a_budget}"
if [[ ${failures} -gt 0 ]]; then
  echo "❌ ${failures} unit-tier budget violation(s)" >&2
  exit 1
fi
