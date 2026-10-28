#!/usr/bin/env bash
set -euo pipefail

# Tests run offline (packages/daemon/tests/support/offline-environment.ts preloads the same): no booted
# daemon follows the published model catalog, asks the hosted relay directory or checks for updates.
export FY_MODEL_CATALOG="${FY_MODEL_CATALOG:-off}"
export FY_LOCAL_MODELS="${FY_LOCAL_MODELS:-off}"
export FY_RELAY_DIRECTORY_ORIGIN="${FY_RELAY_DIRECTORY_ORIGIN:-off}"
export FY_UPDATE_CHECK="${FY_UPDATE_CHECK:-off}"

# The e2e tier, in CI: the compiled `fy`/`fyd`, the real built PWA, a real Chrome and a local
# rendezvous, driven through every product journey in `tests/e2e/` (`tests/e2e/README.md`).
#
# WHY IT RUNS HERE AT ALL. Every other tier was green on main while this one, run by hand, found
# twenty-one defects in the seams between packages — and the tier itself had rotted, fourteen tests
# and its own PWA build broken, because nothing ran it. A tier that runs when somebody remembers is a
# tier that finds the bug after the release.
#
# WHAT THIS SCRIPT OWNS AND WHAT IT DOES NOT. `scripts/test/run-e2e.sh` is the tier: it resolves the
# real tmux and the compiled CLI, typechecks the harness, owns the suite root and cleans it up. This
# script only prepares what that runner expects — the workspace, the compiled binaries, a browser —
# and points the journeys' evidence (screenshots, the step log, the relay ledger) at one directory
# the workflow uploads, on failure as well as success.
#
# NON-REQUIRED FOR NOW. See docs/standards/ci-cd/index.md ("E2E tier"): the job is advisory until
# two weeks of runs have measured its flake rate, and then it becomes a required check.

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

chrome="$(command -v google-chrome || command -v chromium || true)"
[ -z "${chrome}" ] && echo "❌ no google-chrome or chromium on PATH; the e2e journeys drive a real browser" >&2 && exit 2
command -v tmux >/dev/null 2>&1 || {
  echo "❌ no tmux on PATH; agent sessions in the e2e journeys live in a real tmux pane" >&2
  exit 2
}

./scripts/ci/setup.sh
./scripts/release/compile.sh

evidence="${FY_E2E_EVIDENCE_DIR:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/e2e-evidence}"
rm -rf "${evidence}"
mkdir -p "${evidence}"
export FY_E2E_EVIDENCE_ROOT="${evidence}/shots"
export FY_E2E_SHOTS_ROOT="${evidence}/shots"
export FY_E2E_JOURNEY_LOG="${evidence}/journeys.jsonl"
export FY_E2E_RELAY_REPORT="${evidence}/relay-journey.md"
export FY_E2E_RECONNECT_REPORT="${evidence}/relay-reconnect.md"
export FY_E2E_CHAT_LATENCY_REPORT="${evidence}/chat-latency.md"
export FY_E2E_JUNIT="${evidence}/junit.xml"

# Which journeys this runner owns (scripts/ci/e2e-shards.ts). Unset, it is every journey, as before.
tier="${FY_E2E_TIER:-all}"
shard="${FY_E2E_SHARD:-1/1}"

# Chrome's own stderr, through Playwright, so a browser that dies mid-journey says why in the log.
export DEBUG="${DEBUG:-pw:browser}"

echo "🧪 e2e tier (${tier}, shard ${shard}) — Chrome: $("${chrome}" --version), tmux: $(tmux -V), evidence: ${evidence}"
started=${SECONDS}
set +e
./scripts/test/run-e2e.sh 2>&1 | tee "${evidence}/tier.log"
status=${PIPESTATUS[0]}
set -e
elapsed=$((SECONDS - started))

# One line a reader sees without opening the log, and the tally the flake-rate window is measured by.
passed="$(grep -Eo '^ *[0-9]+ pass$' "${evidence}/tier.log" | tail -1 | tr -dc '0-9')"
failed="$(grep -Eo '^ *[0-9]+ fail$' "${evidence}/tier.log" | tail -1 | tr -dc '0-9')"
# A shard the plan left empty ran nothing, and says so rather than "?".
grep -q 'holds no journeys$' "${evidence}/tier.log" && passed="${passed:-0}" && failed="${failed:-0}"
summary="E2E ${tier} ${shard}: ${passed:-?} pass / ${failed:-?} fail (exit ${status}, ${elapsed}s)"
echo "${summary}"
# What `scripts/ci/e2e-summary.sh` adds up into the one `E2E Journeys` status.
{ grep -E '^\(fail\)' "${evidence}/tier.log" || true; } | sort -u | jq -R -s \
  --arg tier "${tier}" --arg shard "${shard}" --arg passed "${passed:-}" --arg failed "${failed:-}" \
  --argjson status "${status}" --argjson seconds "${elapsed}" \
  '{tier: $tier, shard: $shard, passed: ($passed | tonumber? // null), failed: ($failed | tonumber? // null),
    status: $status, seconds: $seconds, failures: (split("\n") | map(select(length > 0)))}' \
  >"${evidence}/result.json"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### ${summary}"
    grep -E '^\(fail\)' "${evidence}/tier.log" | sort -u | sed 's/^/- /' || true
  } >>"${GITHUB_STEP_SUMMARY}"
fi
[ "${status}" -ne 0 ] && [ -n "${GITHUB_ACTIONS:-}" ] && echo "::warning title=E2E (advisory)::${summary}"
exit "${status}"
