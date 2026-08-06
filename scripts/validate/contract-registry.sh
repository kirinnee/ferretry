#!/usr/bin/env bash
set -euo pipefail

# Fails when the repository's contract inventories disagree.
#
# There used to be eighteen CLI contracts in the `all` loop and thirteen in the README, while four
# validator entry points had no README row at all. All checks were green because each registry was
# internally valid; none compared itself with its peers. This gate compares executable and documented
# contract names, validator entry points and their wiring, and the human-facing pre-commit inventory.
#
# Every comparison is a set comparison, so each probe must first prove its own population IS a set.
# Collapsing each extraction with `sort -u` before comparing did the opposite: a second `arch` case
# arm or a copy-pasted README row became the one name its peer registry held, and the gate reported
# agreement. Repeats are rejected below before any set is formed.

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

readme="docs/standards/contracts/README.md"
linting="docs/standards/linting/index.md"
dispatcher="scripts/validate/cli-contracts.sh"
precommit="nix/pre-commit.nix"
ci_gate="scripts/ci/test.sh"

for required in "${readme}" "${linting}" "${dispatcher}" "${precommit}" "${ci_gate}"; do
  [ ! -f "${required}" ] && echo "❌ contract registry input is missing: ${required}" >&2 && exit 2
done

tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT

# Print the first backticked cell from one Markdown table below an exact level-two heading. The
# heading bounds the file set; `^| `` is the row pattern; one first-column identifier is the unit.
markdown_table_names() {
  local file="$1" heading="$2"
  awk -F '|' -v heading="${heading}" '
    $0 == heading { in_section = 1; next }
    in_section && /^## / { exit }
    in_section && /^\| `[A-Za-z0-9]/ {
      value = $2
      gsub(/^[[:space:]]*`|`[[:space:]]*$/, "", value)
      print value
    }
  ' "${file}"
}

compare_sets() {
  local left_name="$1" left_file="$2" right_name="$3" right_file="$4"
  local left_only right_only
  left_only="$(comm -23 "${left_file}" "${right_file}")"
  right_only="$(comm -13 "${left_file}" "${right_file}")"
  if [ -z "${left_only}" ] && [ -z "${right_only}" ]; then
    return 0
  fi

  echo "❌ contract registries disagree: ${left_name} ↔ ${right_name}" >&2
  if [ -n "${left_only}" ]; then
    echo "   only in ${left_name}:" >&2
    printf '%s\n' "${left_only}" | sed 's/^/     /' >&2
  fi
  if [ -n "${right_only}" ]; then
    echo "   only in ${right_name}:" >&2
    printf '%s\n' "${right_only}" | sed 's/^/     /' >&2
  fi
  return 1
}

# Each probe writes its population verbatim to `<name>.raw`; the set every comparison reads is
# derived from it below, once the population has been checked for repeats.

# Surface one: names executed by `cli-contracts.sh all`.
"${dispatcher}" list >"${tmp_dir}/cli-executable.raw"
{ rg --no-filename --only-matching '^[a-z][a-z0-9-]*[)]' "${dispatcher}" || true; } |
  tr -d ')' >"${tmp_dir}/cli-implemented.raw"
markdown_table_names "${readme}" '## Workspace, CLI, and release contracts' >"${tmp_dir}/cli-documented.raw"
{ rg --no-filename --only-matching 'the [0-9]+ workspace/CLI/release contracts' "${readme}" || true; } |
  awk '{ print $2 }' >"${tmp_dir}/cli-prose-count"

# Surface two: every top-level shell entry point in scripts/validate/. Include tracked and untracked
# non-ignored files so a newly written gate cannot evade the registry until after it is committed.
{ git ls-files -co --exclude-standard -- scripts/validate |
  rg '^scripts/validate/[^/]+[.]sh$' || true; } |
  sed 's#^scripts/validate/##' >"${tmp_dir}/validators-present.raw"
markdown_table_names "${readme}" '## Validators' >"${tmp_dir}/validators-documented.raw"

# Surface three: validator scripts actually invoked by a Nix hook entry or a top-level CI command.
# `pages-config.sh` is intentionally CI-only; every other contract runs pre-commit. Anchor the source
# lines before extracting paths so a prose comment cannot make an unwired validator appear live.
{
  rg --no-filename '^[[:space:]]+entry = (validator|bun-script) "scripts/validate/[a-z0-9-]+[.]sh' \
    "${precommit}" || true
  rg --no-filename '^[.]/scripts/validate/[a-z0-9-]+[.]sh' "${ci_gate}" || true
} |
  { rg --no-filename --only-matching 'scripts/validate/[a-z0-9-]+[.]sh' || true; } |
  sed 's#^scripts/validate/##' >"${tmp_dir}/validators-wired.raw"

# The human-facing hook inventory is another exact registry of what pre-commit runs. Attribute ids
# at four-space indentation are hook units in the Nix file; first-column backticked ids are units in
# the Linting table.
{ rg --no-filename --only-matching '^    [a-z][a-z0-9-]+ = [{]' "${precommit}" || true; } |
  sed -E 's/^[[:space:]]*([a-z0-9-]+).*/\1/' >"${tmp_dir}/hooks-wired.raw"
markdown_table_names "${linting}" '## Hook inventory' >"${tmp_dir}/hooks-documented.raw"

# Populations that are sets by construction — one contract name, one entry — and where a repeat is
# always an authoring mistake: a half-finished rename, or a row pasted twice.
unique_populations=(cli-executable cli-implemented cli-documented validators-documented hooks-wired hooks-documented)

# Execution wiring is the deliberate exception. One validator may legitimately run from more than
# one place — `relay-config.sh` is wired in both pre-commit and CI, and `action-pins.sh` backs two
# pre-commit hooks, the trusted and the non-trusted one — and the file listing repeats a path
# whenever git reports unmerged stages. These collapse to a set without complaint.
repeated_populations=(validators-present validators-wired)

for population in "${unique_populations[@]}" "${repeated_populations[@]}"; do
  LC_ALL=C sort -u "${tmp_dir}/${population}.raw" >"${tmp_dir}/${population}"
done

for measured in cli-executable cli-implemented cli-documented cli-prose-count validators-present validators-documented validators-wired hooks-wired hooks-documented; do
  [ ! -s "${tmp_dir}/${measured}" ] &&
    echo "❌ contract registry probe produced a vacuous ${measured} set" >&2 && exit 2
done
[ "$(wc -l <"${tmp_dir}/cli-prose-count" | tr -d ' ')" -ne 1 ] &&
  echo '❌ contract registry expected exactly one numeric workspace/CLI/release contract count in the README prose' >&2 &&
  exit 2

# A repeated name is not a disagreement between two registries — it is one registry that stopped
# being a registry — so it fails closed here rather than reaching the comparisons, which cannot see
# it. Every offending population is reported before exiting so one pass names all of them.
duplicate_status=0
for population in "${unique_populations[@]}"; do
  duplicates="$(LC_ALL=C sort "${tmp_dir}/${population}.raw" | uniq -d)"
  [ -z "${duplicates}" ] && continue
  echo "❌ contract registry population repeats a name: ${population}" >&2
  printf '%s\n' "${duplicates}" | sed 's/^/     /' >&2
  duplicate_status=1
done
[ "${duplicate_status}" -ne 0 ] && exit 2

status=0
compare_sets "${dispatcher} case branches" "${tmp_dir}/cli-implemented" \
  "${dispatcher} list" "${tmp_dir}/cli-executable" || status=1
compare_sets "${dispatcher} list" "${tmp_dir}/cli-executable" \
  "${readme} workspace table" "${tmp_dir}/cli-documented" || status=1
compare_sets 'scripts/validate/*.sh entry points' "${tmp_dir}/validators-present" \
  "${readme} validator table" "${tmp_dir}/validators-documented" || status=1
compare_sets 'scripts/validate/*.sh entry points' "${tmp_dir}/validators-present" \
  "${precommit} + ${ci_gate} wiring" "${tmp_dir}/validators-wired" || status=1
compare_sets "${precommit} hook attributes" "${tmp_dir}/hooks-wired" \
  "${linting} hook inventory" "${tmp_dir}/hooks-documented" || status=1

cli_count="$(wc -l <"${tmp_dir}/cli-executable" | tr -d ' ')"
cli_prose_count="$(<"${tmp_dir}/cli-prose-count")"
if [ "${cli_count}" != "${cli_prose_count}" ]; then
  echo "❌ contract count disagrees: ${cli_count} executable names but README prose says ${cli_prose_count}" >&2
  status=1
fi

[ "${status}" -ne 0 ] && exit 1

validator_count="$(wc -l <"${tmp_dir}/validators-present" | tr -d ' ')"
hook_count="$(wc -l <"${tmp_dir}/hooks-wired" | tr -d ' ')"
echo "✅ contract registry agrees: ${cli_count} executable CLI-contract names (one name per list row), ${validator_count} validator entry-point scripts (one basename per top-level scripts/validate/*.sh), ${hook_count} pre-commit hook ids (one Nix attribute/table-row unit)"
