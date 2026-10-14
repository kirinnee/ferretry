#!/usr/bin/env bash
set -euo pipefail

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

# Chrome's own stderr, through Playwright, so a browser that dies mid-journey says why in the log.
export DEBUG="${DEBUG:-pw:browser}"

echo "🧪 e2e tier — Chrome: $("${chrome}" --version), tmux: $(tmux -V), evidence: ${evidence}"
set +e
./scripts/test/run-e2e.sh 2>&1 | tee "${evidence}/tier.log"
status=${PIPESTATUS[0]}
set -e

# One line a reader sees without opening the log, and the tally the flake-rate window is measured by.
passed="$(grep -Eo '^ *[0-9]+ pass$' "${evidence}/tier.log" | tail -1 | tr -dc '0-9')"
failed="$(grep -Eo '^ *[0-9]+ fail$' "${evidence}/tier.log" | tail -1 | tr -dc '0-9')"
summary="E2E: ${passed:-?} pass / ${failed:-?} fail (exit ${status})"
echo "${summary}"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### ${summary}"
    grep -E '^\(fail\)' "${evidence}/tier.log" | sort -u | sed 's/^/- /' || true
  } >>"${GITHUB_STEP_SUMMARY}"
fi
[ "${status}" -ne 0 ] && [ -n "${GITHUB_ACTIONS:-}" ] && echo "::warning title=E2E (advisory)::${summary}"
exit "${status}"
