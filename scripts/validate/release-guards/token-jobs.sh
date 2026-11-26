#!/usr/bin/env bash
set -euo pipefail

# Pattern checks cannot prove arbitrary shell safe. Pin the reviewed job and its inherited execution
# context, rather than trying to enumerate every spelling of exec/time/sudo, package runner or download-and-run.
# Updating a token job requires reviewing its whole execution surface and updating token-jobs.json in the same PR.
# The job's `if` remains under release-guards.sh's ref checks. These are public expressions, NEVER secret values.
# SHA-256 is over jq -cS plus its terminating newline.
policy="${BASH_SOURCE[0]%/*}/token-jobs.json"
status=0
for workflow in .github/workflows/{pwa-pages,pwa-pages-v5,relay-hosted,link-store-hosted}.yaml; do
  [[ -f ${workflow} ]] || continue
  document="$(yq -o=json '.' "${workflow}")"
  # Any secret, regardless of its name, whitespace or case. GITHUB_TOKEN alone is not a deployment credential.
  holders="$(jq -r '
    def secret: tostring | gsub("secrets\\s*\\.\\s*github_token\\b|secrets\\s*\\[\\s*[\u0027\"]github_token[\u0027\"]\\s*\\]"; ""; "i") | test("\\bsecrets\\b"; "i");
    . as $workflow | .jobs | to_entries[]
    | select((.value | secret) or (($workflow.env // {}) | secret)) | .key' <<<"${document}")"
  while IFS= read -r job; do
    [[ -n ${job} ]] || continue
    ref="github.ref == 'refs/heads/main'"
    [[ ${workflow} != .github/workflows/pwa-pages-v5.yaml ]] || ref="github.ref == 'refs/heads/rebuild/preview'"
    # The opening ref is mandatory; a top-level OR after it would let another branch run a token job.
    if ! jq -e --arg job "${job}" --arg ref "${ref}" '
      .jobs[$job].if // "" | . as $condition
      | startswith($ref) and ($condition[($ref | length):] | gsub("\u0027[^\u0027]*\u0027"; "\u0027\u0027")
        | reduce (explode[]) as $c ({depth: 0, previous: 0, bad: false};
            if $c == 40 then .depth += 1 | .previous = $c
            elif $c == 41 then .depth -= 1 | .previous = $c
            elif $c == 124 and .previous == 124 and .depth == 0 then .bad = true | .previous = 0
            else .previous = $c end) | .bad | not)' <<<"${document}" >/dev/null; then
      echo "❌ ${workflow}: token job ${job} must require ${ref}, with no top-level OR" >&2
      status=1
    fi
    if ! jq -e --arg job "${job}" '
      . as $workflow | .jobs[$job]
      | (has("container") or has("services") | not)
        and ([($workflow.defaults.run.shell // "bash"), (.defaults.run.shell // "bash"), (.steps[]?.shell // "bash")]
             | all(. == "bash"))' <<<"${document}" >/dev/null; then
      echo "❌ ${workflow}: token job ${job} must use bash only and no container or services" >&2
      status=1
    fi
    actual="$(jq -cS --arg job "${job}" '{job: (.jobs[$job] | del(.if)), env: (.env // {}), defaults: (.defaults // {})}' <<<"${document}" | sha256sum | cut -d ' ' -f 1)"
    expected="$(jq -r --arg workflow "${workflow}" --arg job "${job}" '.[$workflow][$job] // empty' "${policy}")"
    if [[ -z ${expected} || ${actual} != "${expected}" ]]; then
      echo "❌ ${workflow}: token job ${job} has an unreviewed execution surface; review the complete job and inherited env/defaults before updating scripts/validate/release-guards/token-jobs.json" >&2
      status=1
    fi
  done <<<"${holders}"
done
exit "${status}"
