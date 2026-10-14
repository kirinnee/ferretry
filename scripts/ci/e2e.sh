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

echo "🧪 e2e tier — Chrome: $("${chrome}" --version), tmux: $(tmux -V), evidence: ${evidence}"
./scripts/test/run-e2e.sh
