#!/usr/bin/env bash
set -euo pipefail

# Every job in every workflow states `timeout-minutes` (docs/standards/ci-cd, "Job ceilings").
#
# A job with no ceiling holds its runner for GitHub's six-hour default when it wedges: on 2026-10-29 the
# daemon integration group hung inside a test for two hours, three runs in a row. The ceiling is a red
# job with a log that says it was cancelled — never a retry — so a hang costs minutes, not a runner.
# A reusable-workflow call (`uses:`) runs no steps of its own and is exempt; its jobs carry their own.

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

missing=0
for workflow in .github/workflows/*.yaml .github/workflows/*.yml; do
  [[ -f ${workflow} ]] || continue
  while IFS=$'\t' read -r job ceiling; do
    if [[ ${ceiling} == "none" ]]; then
      echo "❌ ${workflow}: job '${job}' has no timeout-minutes; size it at two to three times its normal run (docs/standards/ci-cd, \"Job ceilings\")" >&2
      missing=$((missing + 1))
    elif ! [[ ${ceiling} =~ ^[0-9]+$ ]] || ((ceiling < 1 || ceiling > 60)); then
      echo "❌ ${workflow}: job '${job}' has timeout-minutes '${ceiling}'; a ceiling is a whole number of minutes from 1 to 60" >&2
      missing=$((missing + 1))
    fi
  done < <(yq -o=json '.jobs // {}' "${workflow}" |
    jq -r 'to_entries[] | select(.value.uses == null) | "\(.key)\t\(.value["timeout-minutes"] // "none")"')
done

((missing == 0)) || { echo "❌ ${missing} job(s) without a valid ceiling" >&2 && exit 1; }
echo "✅ every workflow job states its timeout-minutes"
