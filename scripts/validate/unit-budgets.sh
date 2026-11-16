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
# THE RATCHET: the list may only SHRINK. Every listed path must also be on the BASE version of the list (CI's
# FY_CHECK_BASE, scripts/ci/check-base.sh; origin/rebuild/5.0-after locally), so neither a new exemption nor a
# re-added one gets in. A base with no list at all is the bootstrap (the change that introduces it): the current list
# is accepted. A base that cannot be read for any other reason FAILS; it is never skipped.
base_ref="${FY_CHECK_BASE:-origin/rebuild/5.0-after}"
if ! git rev-parse --verify --quiet "${base_ref}^{commit}" >/dev/null; then
  refuse "cannot read the base ${base_ref} to hold ${perf_pending} to its shrink-only ratchet (fetch it, or set FY_CHECK_BASE)"
elif git cat-file -e "${base_ref}:${perf_pending}" 2>/dev/null; then
  declare -A pending_base=()
  while IFS= read -r entry; do
    [[ -z ${entry} || ${entry} == \#* ]] && continue
    pending_base[${entry}]=1
  done < <(git show "${base_ref}:${perf_pending}")
  for entry in "${!pending_unit[@]}"; do
    [[ -n ${pending_base[${entry}]:-} ]] ||
      refuse "${perf_pending}: ${entry} is not on the list at ${base_ref}; the list only shrinks, so move its budget to the perf tier instead of listing it"
  done
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
