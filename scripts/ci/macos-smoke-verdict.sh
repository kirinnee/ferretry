#!/usr/bin/env bash
set -euo pipefail

# Judges the attempts of .github/workflows/smoke-darwin.yaml. Reads ADVISORY (true on a pull request)
# and NEEDS (the workflow's `toJSON(needs)`: each `attempt-N` with its `result` and `outputs.started`).
#
# A macOS job GitHub never gave a runner runs no step, so its `started` output is empty: that proves
# nothing about the product, so it is told apart from a smoke that ran and failed. `outputs.started` is
# the source of truth, NOT `result`: GitHub reports such a job as "cancelled" in the UI but hands the
# workflow `result: "abandoned"` (seen in the Verdict log of run 41856821125), and may use other words.
#
#   never started = not success, not skipped, and `started` is not "true"  (any result: cancelled, abandoned, failure)
#   ran and failed = `started` is "true" and the result is "failure"
#   cut short      = `started` is "true" and the result is anything else that is not success or skipped
#
#   an attempt passed                           -> pass
#   an attempt ran and failed                   -> fail (never retried, on a pull request or off one)
#   no attempt ran, ADVISORY                    -> pass with a warning: "macOS runner not available; advisory on PRs"
#   no attempt ran, not advisory                -> fail, saying the runner was unavailable and how often it was tried
#
# It writes the same facts to the job summary so a reader of the check sees why it is green or red.

advisory="${ADVISORY:-false}"
needs="${NEEDS:?NEEDS (toJSON(needs)) is required}"
summary="${GITHUB_STEP_SUMMARY:-/dev/stdout}"

count() {
  jq -r '[to_entries[] | select(.key | startswith("attempt-")) | select(.value | '"$1"')] | length' <<<"${needs}"
}

passed="$(count '.result == "success"')"
failed="$(count '.result == "failure" and ((.outputs.started // "") == "true")')"
never_started="$(count '(.result != "success" and .result != "skipped") and ((.outputs.started // "") != "true")')"
cut_short="$(count '(.result != "success" and .result != "failure" and .result != "skipped") and ((.outputs.started // "") == "true")')"
tried=$((passed + failed + never_started + cut_short))

say() {
  printf '%s\n' "$1" >>"${summary}"
}

if ((passed > 0)); then
  say "Smoke darwin-arm64 passed (${tried} attempt(s))."
  echo "✅ Smoke darwin-arm64 passed"
  exit 0
fi

if ((failed > 0)); then
  say "**Smoke darwin-arm64 failed on a macOS runner.** The binary ran and the smoke did not pass: this is a product failure, not a runner shortage, and it is not retried."
  echo "::error::Smoke darwin-arm64 ran on a macOS runner and failed; see the attempt's log"
  exit 1
fi

if ((never_started + cut_short == 0)); then
  say "**No smoke attempt ran.**"
  echo "::error::no Smoke darwin-arm64 attempt ran"
  exit 1
fi

if [[ ${advisory} == true ]]; then
  say "macOS runner not available; advisory on PRs"
  say ""
  say "GitHub's macOS pool gave this pull request no runner (or cancelled the job), so the darwin-arm64 smoke did not run. Nothing failed. \`main\` and the release tag require it and retry up to 3 times."
  echo "::warning::macOS runner not available; advisory on PRs"
  exit 0
fi

say "**macOS runner not available after ${tried} attempt(s)**: ${never_started} never got a runner and ${cut_short} was cancelled after it started. The darwin-arm64 smoke did not complete, so this is GitHub's macOS pool, not a smoke failure. Re-run this job to try again."
echo "::error::macOS runner not available after ${tried} attempt(s) (${never_started} never started, ${cut_short} cancelled mid-run); not a smoke failure. Re-run the job."
exit 1
