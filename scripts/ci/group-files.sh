#!/usr/bin/env bash
set -euo pipefail
#
# The test files one test GROUP (config/test-groups.json) runs, one `./path` per line on stdout; every message goes to
# stderr. `test.sh` runs them, and `quick.sh`'s dry run prints them without installing or testing.
#
#   group-files.sh <unit|int> <group>
#
# THE CHANGED-PLUGIN SCOPE (scripts/ci/scope.ts): quick.sh exports FY_CI_SCOPE_FILE only for a SCOPED decision, and the
# unit tier is the only tier it ever narrows. Test files of the plugins the decision SKIPPED are dropped; every other
# file (the selected plugins' and every platform package's) is kept. The count is printed so the run says what it was.

mode="${1:?usage: $0 <unit|int> <group>}"
group="${2:?usage: $0 <unit|int> <group>}"

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

groups="config/test-groups.json"
jq -e --arg mode "${mode}" --arg group "${group}" '.[$mode] // [] | any(.name == $group)' "${groups}" >/dev/null ||
  { echo "❌ ${mode} has no test group ${group} in ${groups}" >&2 && exit 2; }
# The same files the bunfig's `pathIgnorePatterns` leave the tier, which is why the other tier's
# directory and SIT are the only exclusions. Bun would also run `*.spec.*`, `*_test.*` and
# `*_spec.*` files; nothing here is named like that, and a group must not silently skip one.
other_tier="unit"
[[ ${mode} == "unit" ]] && other_tier="integration"
stray="$(find packages -path '*/node_modules' -prune -o -type f \( -name '*.spec.*' -o -name '*_test.*' -o -name '*_spec.*' -o -name '*.test.js' -o -name '*.test.jsx' \) -print | head -n 1)"
[[ -n ${stray} ]] && echo "❌ test groups only collect *.test.ts(x) files, and Bun would also run ${stray}" >&2 && exit 1
# Every pipeline below runs into a temp file with its status CHECKED: `mapfile < <(...)` drops the pipeline's exit
# status, so a filter killed by the OOM killer (137) would read as "no file left" and a group would pass unrun.
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
if ! {
  find packages -path '*/node_modules' -prune -o -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) \
    -not -path "*/tests/${other_tier}/*" -not -path '*/tests/sit/*' -not -path '*/tests/realworld/*' -not -path '*/tests/perf/*' -print | sort |
    jq -R -r --slurpfile groups "${groups}" --arg mode "${mode}" --arg group "${group}" '
      . as $file
      | [$groups[0][$mode][] | select(any(.prefixes[]; . as $prefix | $file | startswith($prefix)))][0].name
      | select(. == $group) | "./" + $file
    '
} >"${work}/files"; then
  echo "❌ could not enumerate the ${mode} test files of group ${group}" >&2 && exit 1
fi
mapfile -t files <"${work}/files"

if [[ ${mode} == "unit" && -n ${FY_CI_SCOPE_FILE:-} ]]; then
  [[ -f ${FY_CI_SCOPE_FILE} && "$(jq -r '.mode' "${FY_CI_SCOPE_FILE}")" == "scoped" ]] ||
    { echo "❌ FY_CI_SCOPE_FILE (${FY_CI_SCOPE_FILE}) is not a SCOPED decision" >&2 && exit 1; }
  all_files=${#files[@]}
  # Only a filter that EXITED 0 may leave a group empty; any other status fails the group.
  if ! printf '%s\n' "${files[@]}" | bun scripts/ci/scope.ts filter "${FY_CI_SCOPE_FILE}" >"${work}/filtered"; then
    echo "❌ the scope filter failed for ${mode} test group ${group}; refusing to treat that as 'scoped out'" >&2 && exit 1
  fi
  mapfile -t files <"${work}/filtered"
  echo "📝 SCOPED unit run, group ${group}: ${#files[@]} of ${all_files} unit test files ($((all_files - ${#files[@]})) belong to plugins the scope skipped)" |
    tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}" >&2
  # A group whose EVERY file belongs to a skipped plugin has nothing left to run: that is the scope's decision, said
  # out loud, and the only empty group that is not a failure. It prints no file; test.sh records the group as
  # scoped out. A group that held no file BEFORE the scope (all_files 0) still fails below.
  if [[ ${#files[@]} -eq 0 && ${all_files} -gt 0 ]]; then
    echo "📝 SCOPED: unit group ${group} has no test file left (all ${all_files} belong to plugins the scope skipped)" |
      tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}" >&2
    exit 0
  fi
fi
[[ ${#files[@]} -eq 0 ]] && echo "❌ ${mode} test group ${group} holds no test files" >&2 && exit 1
printf '%s\n' "${files[@]}"
