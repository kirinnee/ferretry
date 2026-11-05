#!/usr/bin/env bash
set -euo pipefail

# Says, out loud, that the darwin-arm64 smoke did not run because the owner switched it off with the
# repository variable `MACOS_SMOKE=skip` (docs/standards/ci-cd, "macOS runner shortage"). Called by a job
# that does run (`compile` in ci.yaml, `goreleaser` in cd.yaml) only when `vars.MACOS_SMOKE == 'skip'`, so a
# skipped smoke is never silent: it is a warning on the run and a line in the job summary.

summary="${GITHUB_STEP_SUMMARY:-/dev/stdout}"
message="macOS smoke skipped by vars.MACOS_SMOKE=skip (owner); darwin binary released unproven"
detail="The Smoke darwin-arm64 job did not run. Turn the switch off with: gh variable delete MACOS_SMOKE"

echo "::warning::${message}"
printf '**%s**\n\n%s\n' "${message}" "${detail}" >>"${summary}"
