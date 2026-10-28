#!/usr/bin/env bash
set -euo pipefail

# Turns a red scheduled "Harness Contract (latest)" run into something a person notices: one open
# GitHub issue per (claude, codex) version pair that failed, with later nights' failures of the same
# pair posted as comments on it rather than as new issues.
#
# Usage: harness-contract-report.sh <artifacts-dir> [expected-results]
#   <artifacts-dir>  where the per-OS `harness-contract-latest-*` artifacts were downloaded; each holds
#                    the `result.json` that packages/fleet/tests/contract/run.sh writes.
#   [expected-results]  how many `result.json` a complete run leaves (one per OS); fewer means a job died
#                    before measuring, which is reported too. Default 1.
#   env GH_TOKEN, GITHUB_REPOSITORY, GITHUB_SERVER_URL, GITHUB_RUN_ID: the usual Actions values.
#   env FY_CONTRACT_REPORT_DRY_RUN=1: print what would be filed and call no `gh` at all.
#
# A run whose every result passed files nothing. A job that left no result (it died before writing one)
# counts as a failure on "unknown" versions, because it is still a night nobody measured.

dir="${1:?usage: harness-contract-report.sh <artifacts-dir> [expected-results]}"
expected="${2:-1}"
label="harness-contract"
run_url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-unknown/unknown}/actions/runs/${GITHUB_RUN_ID:-0}"

mapfile -t results < <(find "${dir}" -name result.json -type f 2>/dev/null | sort)

failed="[]"
for file in "${results[@]}"; do
  failed="$(jq -c --slurpfile entry "${file}" '. + [$entry[0] | select(.mode == "latest" and .passed == false)]' <<<"${failed}")"
done

if [[ ${#results[@]} -lt ${expected} ]]; then
  failed="$(jq -c '. + [{os: "an OS that left no result", claude: "unknown", codex: "unknown"}]' <<<"${failed}")"
fi

if [[ "$(jq 'length' <<<"${failed}")" -eq 0 ]]; then
  echo "✅ every measured result passed; nothing to report"
  exit 0
fi

# The versions are read from the first failure that recorded them: both OSes install the same `@latest` in one night, and
# if they raced a publish the title still names a real version pair the failing OS measured.
claude="$(jq -r 'map(select(.claude != "unknown"))[0].claude // "unknown"' <<<"${failed}")"
codex="$(jq -r 'map(select(.codex != "unknown"))[0].codex // "unknown"' <<<"${failed}")"
systems="$(jq -r 'map(.os) | unique | join(", ")' <<<"${failed}")"
title="Harness contract broke on ${claude} · ${codex}"
body="The scheduled \"Harness Contract (latest)\" run failed on **${systems}**.

- claude: \`${claude}\`
- codex: \`${codex}\`
- run: ${run_url}

A new Codex usually means the cross-harness converter needs a look: record the version's transcripts
(\`scripts/local/record-conversion-fixtures.ts\`), diff the rollout format, and widen or fix the converter
(\`docs/migration-cross-harness.md\`, \"Adding a harness version\"). A mechanism the account model relies
on breaking is a different remedy: per-runtime sign-in, never a symlink or a copied credential (design §9.5)."

if [[ ${FY_CONTRACT_REPORT_DRY_RUN:-} == "1" ]]; then
  printf 'title: %s\n\n%s\n' "${title}" "${body}"
  exit 0
fi

gh label create "${label}" --color B60205 --description "A new upstream harness release failed the contract" 2>/dev/null || true

existing="$(gh issue list --label "${label}" --state open --limit 100 --json number,title |
  jq -r --arg title "${title}" '[.[] | select(.title == $title)][0].number // empty')"

if [[ -n ${existing} ]]; then
  gh issue comment "${existing}" --body "Still failing on **${systems}**: ${run_url}"
  echo "📝 commented on issue #${existing}"
else
  gh issue create --label "${label}" --title "${title}" --body "${body}"
fi
