#!/usr/bin/env bash
set -euo pipefail

# The one status for a sharded e2e run: `E2E Journeys` (and `E2E Slow Journeys`). Branch protection and
# merge tooling wait on a single name, so the shards report here and this job is what they see.
#
# Usage: e2e-summary.sh <evidence-dir> <expected-shards>
#   env RELEVANCE: the relevance job's result, RUN: its `run` output (unset when there is none),
#       SHARDS: the shard matrix's result.
#
# Green when the run had nothing to prove, or when every shard job finished. The journeys themselves
# are ADVISORY (docs/standards/ci-cd/index.md, "E2E tier"): a failing journey is tallied, annotated and
# listed here, and does not turn this red until the tier is made required. A shard job that did not
# finish — a runner that died, a setup step that failed, a cancelled matrix — is red, as it was before
# the tier was sharded. So is a run where NO shard left a result: every shard job was green but not one
# journey ran (the harness died before the first, as a typecheck error once did), and "advisory" must
# not mean "silently never runs". A result without numeric tallies is no result, and a set that ran
# nothing (0 pass, 0 fail) with any non-zero exit status is the same failure. A partial set (some shards without a result) stays a warning.

dir="${1:?usage: e2e-summary.sh <evidence-dir> <expected-shards>}"
expected="${2:?usage: e2e-summary.sh <evidence-dir> <expected-shards>}"
summary_file="${GITHUB_STEP_SUMMARY:-/dev/stdout}"

if [ -n "${RELEVANCE:-}" ] && [ "${RELEVANCE}" != "success" ]; then
  echo "❌ deciding whether the journeys had to run did not finish (${RELEVANCE})" >&2
  exit 1
fi
if [ "${RUN:-true}" = "false" ]; then
  echo "### E2E skipped: only documentation or model catalogs changed" >>"${summary_file}"
  echo "✅ nothing for the journeys to prove; reporting success"
  exit 0
fi
if [ "${SHARDS:-}" != "success" ]; then
  echo "❌ the e2e shards did not all finish (${SHARDS:-unknown}); see the shard jobs" >&2
  exit 1
fi

# `<dir>/e2e-result-<shard>-<attempt>/result.json`: a re-run of failed jobs leaves the earlier attempt's
# result beside the new one, so only each shard's latest attempt counts.
mapfile -t results < <(
  find "${dir}" -path '*/e2e-result-*-*/result.json' -type f 2>/dev/null |
    awk '{ match($0, /e2e-result-[0-9]+-[0-9]+\/result\.json$/); split(substr($0, RSTART + 11), part, /[-\/]/)
           if (!(part[1] in attempt) || part[2] + 0 > attempt[part[1]] + 0) { attempt[part[1]] = part[2]; path[part[1]] = $0 } }
         END { for (shard in path) print shard "\t" path[shard] }' |
    sort -n | cut -f2
)
# A result counts only when it carries numeric tallies. A shard whose harness died before printing its
# tally writes `passed: null, failed: null` (e2e.sh); counting that as a result made "0 pass / 0 fail
# across 3 of 3" a green run in which no journey ran.
counted=()
for result in "${results[@]}"; do
  if jq -e '(.passed | type) == "number" and (.failed | type) == "number"' "${result}" >/dev/null 2>&1; then
    counted+=("${result}")
  fi
done
results=("${counted[@]}")
if [ "${#results[@]}" -eq 0 ] ||
  { [ "$(jq -s 'map(.passed + .failed) | add' "${results[@]}" </dev/null)" = "0" ] &&
    [ "$(jq -s 'map(.status // 0 | if . == 0 then 0 else 1 end) | add' "${results[@]}" </dev/null)" != "0" ]; }; then
  echo "### E2E harness produced no results: the journeys did not run" >>"${summary_file}"
  echo "❌ E2E harness produced no results: the journeys did not run (0 of ${expected} shards left a result)" >&2
  exit 1
fi
totals="$(jq -s '{passed: (map(.passed // 0) | add // 0), failed: (map(.failed // 0) | add // 0),
  slowest: (map(.seconds) | max // 0), failures: (map(.failures[]) | unique)}' "${results[@]}" </dev/null)"
passed="$(jq -r .passed <<<"${totals}")"
failed="$(jq -r .failed <<<"${totals}")"
headline="E2E: ${passed} pass / ${failed} fail across ${#results[@]} of ${expected} shards (slowest $(jq -r .slowest <<<"${totals}")s)"

{
  echo "### ${headline}"
  echo
  echo "| shard | tier | pass | fail | exit | seconds |"
  echo "| ----- | ---- | ---- | ---- | ---- | ------- |"
  for result in "${results[@]}"; do
    jq -r '"| \(.shard) | \(.tier) | \(.passed // "?") | \(.failed // "?") | \(.status) | \(.seconds) |"' "${result}"
  done
  jq -r '.failures[] | "- " + .' <<<"${totals}"
} >>"${summary_file}"
echo "${headline}"

if [ "${#results[@]}" -ne "${expected}" ]; then
  echo "::warning title=E2E (advisory)::${#results[@]} of ${expected} shards left a result; the others' journeys did not run to the end"
elif [ "${failed}" != "0" ]; then
  echo "::warning title=E2E (advisory)::${headline}"
fi
exit 0
