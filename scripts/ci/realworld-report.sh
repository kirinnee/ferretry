#!/usr/bin/env bash
set -euo pipefail

# Turns a red REALWORLD run (.github/workflows/realworld.yaml) into something a person notices: one open
# GitHub issue per failing test, titled `realworld: <file> > <test>`, with a later run's failure of the
# same test posted as a comment on it rather than as a new issue. The tier gates nothing, so this is
# the only way a machine-dependent regression is ever seen.
#
# Usage: realworld-report.sh <junit.xml> [console.log]
#   <junit.xml>   what `scripts/ci/test.sh realworld` wrote (coverage/realworld/junit.xml).
#   [console.log] its console output; the first lines of each failure are quoted from it, because
#                 Bun's JUnit carries the failing test's name and file but not its message.
#   env FY_REALWORLD_JOB_RESULT: the realworld job's result (success|failure|cancelled|skipped). A red job
#                 that left no failing test (it timed out or died before writing a result) is reported too.
#   env FY_REALWORLD_FAILED_JOBS: newline-separated names of the OTHER jobs of the workflow that failed
#                 (the macOS proofs); each files an issue titled `realworld: <job name>`.
#   env GH_TOKEN, GITHUB_REPOSITORY, GITHUB_SERVER_URL, GITHUB_RUN_ID: the usual Actions values.
#   env FY_REALWORLD_REPORT_DRY_RUN=1: print what would be filed and call no `gh` at all.

junit="${1:?usage: realworld-report.sh <junit.xml> [console.log]}"
console="${2:-}"
label="realworld"
max_issues=25
run_url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-unknown/unknown}/actions/runs/${GITHUB_RUN_ID:-0}"

# Bun escapes `&`, `<`, `>` and quotes in attribute values (and a `>` it already escaped, twice).
unescape() { sed -e 's/&amp;gt;/>/g' -e 's/&amp;lt;/</g' -e 's/&lt;/</g' -e 's/&gt;/>/g' -e 's/&quot;/"/g' -e "s/&apos;/'/g" -e 's/&#39;/'"'"'/g' -e 's/&amp;/\&/g'; }

# One `<file><TAB><test>` line per testcase that failed or errored.
failing_tests() {
  [[ -f ${junit} ]] || return 0
  awk '
    function attr(line, name,    rest, start) {
      start = index(line, " " name "=\"")
      if (start == 0) return ""
      rest = substr(line, start + length(name) + 3)
      return substr(rest, 1, index(rest, "\"") - 1)
    }
    /<testcase / {
      name = attr($0, "name"); file = attr($0, "file"); open = ($0 !~ /\/>[ \t]*$/); failed = 0; next
    }
    open && /<(failure|error)[ \/>]/ { failed = 1 }
    open && /<\/testcase>/ { if (failed) print file "\t" name; open = 0 }
  ' "${junit}" | unescape
}

# The lines Bun printed just before the `(fail)` line that names the test, which hold its error.
excerpt() {
  local test_name="$1"
  [[ -n ${console} && -f ${console} ]] || return 0
  awk -v needle="${test_name}" '
    { lines[NR] = $0 }
    index($0, "(fail) ") == 1 && index($0, needle) > 0 && !found { found = NR }
    END {
      if (!found) exit
      from = found - 24; if (from < 1) from = 1
      for (i = from; i <= found; i++) print lines[i]
    }
  ' "${console}" | head -n 25
}

titles=()
bodies=()

mapfile -t failures < <(failing_tests)
for entry in "${failures[@]}"; do
  [[ -z ${entry} ]] && continue
  file="${entry%%$'\t'*}"
  test_name="${entry#*$'\t'}"
  titles+=("realworld: ${file} > ${test_name}")
  bodies+=("The realworld test \`${test_name}\` in \`${file}\` failed.

- run: ${run_url}

This tier asserts what depends on the machine — wall-clock speed, memory, rate, a real upstream tool —
so a red test is either a regression in the product or a machine that got slower; decide which before
touching a threshold. It gates nothing and never blocks a pull request or a release.

\`\`\`
$(excerpt "${test_name}")
\`\`\`")
done

if [[ ${FY_REALWORLD_JOB_RESULT:-} == "failure" || ${FY_REALWORLD_JOB_RESULT:-} == "cancelled" ]] && [[ ${#titles[@]} -eq 0 ]]; then
  titles+=("realworld: the realworld job left no failing test")
  bodies+=("The \`realworld\` job ended \`${FY_REALWORLD_JOB_RESULT}\` without a failing test in its JUnit — it timed out or died before reporting.

- run: ${run_url}")
fi

while IFS= read -r job; do
  [[ -z ${job} ]] && continue
  titles+=("realworld: ${job}")
  bodies+=("The realworld workflow's job **${job}** failed.

- run: ${run_url}

It proves a claim only the real platform can check (macOS containment, Safari, the pinned harnesses); the job's log says which. It gates nothing and never blocks a pull request or a release.")
done <<<"${FY_REALWORLD_FAILED_JOBS:-}"

if [[ ${#titles[@]} -eq 0 ]]; then
  echo "✅ nothing failed; nothing to report"
  exit 0
fi

if [[ ${#titles[@]} -gt ${max_issues} ]]; then
  overflow=$((${#titles[@]} - max_issues))
  list="$(printf '%s\n' "${titles[@]:max_issues}" | sed 's/^/- /')"
  titles=("${titles[@]:0:max_issues}" "realworld: ${overflow} further failing tests")
  bodies=("${bodies[@]:0:max_issues}" "More than ${max_issues} realworld tests failed; the rest:

${list}

- run: ${run_url}")
fi

if [[ ${FY_REALWORLD_REPORT_DRY_RUN:-} == "1" ]]; then
  for index in "${!titles[@]}"; do
    printf 'title: %s\n\n%s\n\n' "${titles[index]}" "${bodies[index]}"
  done
  exit 0
fi

gh label create "${label}" --color D93F0B --description "A machine-dependent (realworld) test failed" 2>/dev/null || true
open_issues="$(gh issue list --label "${label}" --state open --limit 200 --json number,title)"

for index in "${!titles[@]}"; do
  existing="$(jq -r --arg title "${titles[index]}" '[.[] | select(.title == $title)][0].number // empty' <<<"${open_issues}")"
  if [[ -n ${existing} ]]; then
    gh issue comment "${existing}" --body "Still failing: ${run_url}"
    echo "📝 commented on issue #${existing}: ${titles[index]}"
  else
    gh issue create --label "${label}" --title "${titles[index]}" --body "${bodies[index]}"
  fi
done
