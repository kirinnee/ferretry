#!/usr/bin/env bash
# The 100% coverage ledger gate for one tier, over the LCOV of ONE serial run or of the tier's test
# groups (config/test-groups.json), each of which is a serial run of its own share of the files.
#
#   coverage-ledger.sh <unit|int> <lcov>...
#   coverage-ledger.sh <unit|int> --groups <dir>   # <dir>/<group>/lcov.info, every group
#
# It judges the files inside the tier's scope (`lib/` directories for unit, `adapters/` for int, at any depth
# of a workspace package): the ledger is non-empty, every line is hit, and no source file is missing from it.
#
# GROUPS ARE MERGED PER FILE, NEVER PER LINE. A source file passes when ONE group's ledger shows it
# at 100%. That is exactly what one serial run would conclude, because Bun reports a function it
# never ran coarsely — the whole range, blank and comment lines included — so a group's 100% means
# it ran every function in the file and its line set is the serial one. Adding lines up across
# groups is NOT sound: groups disagree about which lines exist, a union of lines is red for ever, and
# an intersection hid real misses when measured. A file only covered across groups therefore fails
# here, naming the groups, and the remedy is a test for its missed lines in the group that owns it.
#
# Only POSIX tools (bash, awk, grep, find, sort, comm), so the CI ledger job runs without a nix shell.
set -euo pipefail

mode="${1:-}"
[[ ${mode} != "unit" && ${mode} != "int" ]] && echo "❌ usage: $0 <unit|int> <lcov>... | --groups <dir>" >&2 && exit 2
shift
[[ $# -eq 0 ]] && echo "❌ usage: $0 <unit|int> <lcov>... | --groups <dir>" >&2 && exit 2

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

# The CI ledger job: one ledger per group named in config/test-groups.json, and no judgement at all
# while one is missing — a group that never reported would otherwise just be files "missing".
if [[ $1 == "--groups" ]]; then
  [[ $# -ne 2 ]] && echo "❌ usage: $0 <unit|int> --groups <dir>" >&2 && exit 2
  mapfile -t names < <(jq -r --arg mode "${mode}" '.[$mode] // [] | .[].name' config/test-groups.json)
  [[ ${#names[@]} -eq 0 ]] && echo "❌ config/test-groups.json names no ${mode} test groups" >&2 && exit 1
  ledgers=()
  for name in "${names[@]}"; do
    ledger="$2/${name}/lcov.info"
    # Also accept the former download-artifact layout for saved CI evidence/local diagnosis.
    [[ ! -f ${ledger} && -f $2/coverage-${mode}-${name}/lcov.info ]] && ledger="$2/coverage-${mode}-${name}/lcov.info"
    ledgers+=("${ledger}")
  done
  set -- "${ledgers[@]}"
fi

# Every ledger named must exist. A test group's may be empty: its suites loaded no in-scope source.
for lcov in "$@"; do
  [[ ! -f ${lcov} ]] && echo "❌ No coverage artifact found at ${lcov}" >&2 && exit 1
done

coverage_file="coverage/${mode}/lcov.info"
if [[ $# -gt 1 || $1 != "${coverage_file}" ]]; then
  mkdir -p "coverage/${mode}"
  merged="$(mktemp)"
  ledger_scope="lib/"
  [[ ${mode} == "int" ]] && ledger_scope="adapters/"
  awk -v scope="${ledger_scope}" '
    FNR == 1 { group = FILENAME; sub(/\/lcov\.info$/, "", group); sub(/^.*\//, "", group); sub(/^coverage-(unit|int)-/, "", group) }
    /^SF:/ { sf = substr($0, 4); record = $0 "\n"; lf = 0; lh = 0; next }
    /^end_of_record/ {
      record = record $0 "\n"
      if (!(sf in order)) { order[sf] = ++files; paths[files] = sf }
      seen[sf] = seen[sf] sprintf(" %s %d/%d", group, lh, lf)
      if (lf > 0 && lh == lf && !(sf in whole)) whole[sf] = record
      if (lf > most_lf[sf]) most_lf[sf] = lf
      if (!(sf in best) || lh > best_lh[sf]) { best[sf] = record; best_lh[sf] = lh }
      next
    }
    /^LF:/ { lf = substr($0, 4) + 0 }
    /^LH:/ { lh = substr($0, 4) + 0 }
    { record = record $0 "\n" }
    END {
      for (i = 1; i <= files; i++) {
        sf = paths[i]
        if (sf in whole) { printf "%s", whole[sf]; continue }
        # Nothing executable in ANY group (a types-only module): the serial ledger records it as 0/0
        # too. A 0/0 from one group never excuses unhit lines in another.
        if (most_lf[sf] == 0) { printf "%s", best[sf]; continue }
        # Only a file the tier judges (below) is reported; any other is carried for the record.
        if (sf ~ ("(^|/)packages/.*/" scope)) printf "❌ %s reaches 100%% in no single test group (lines hit/found:%s); test its missed lines in the group that owns it\n", sf, seen[sf] > "/dev/stderr"
        printf "%s", best[sf]
      }
    }
  ' "$@" >"${merged}"
  mv "${merged}" "${coverage_file}"
fi

# THE TIERS' SCOPE (Ferretry 5.0 layout, docs/rebuild/spine.md §3): every directory named `lib/` (pure,
# the unit ledger) or `adapters/` (IO, the integration ledger) inside a workspace package, at any depth —
# `packages/plugins/<id>/daemon/lib/`, `packages/core/kernel/host/lib/` and so on. A new package or half is
# in the ledger the moment it has such a directory; nobody lists it here. Files outside those directories
# (contracts, manifests, host entries, skeleton halves) are not judged by either ledger.
scope="lib/"
[[ ${mode} == "int" ]] && scope="adapters/"
mapfile -t scope_dirs < <(find packages -path '*/node_modules' -prune -o -path '*/tests' -prune -o -type d -name "${scope%/}" -print | sort)
source_list="$(mktemp)"
coverage_list="$(mktemp)"
judged="$(mktemp)"
trap 'rm -f "${source_list}" "${coverage_list}" "${judged}"' EXIT

# Only the records inside the tier's scope are judged.
awk -v scope="${scope}" '
  /^SF:/ { path = substr($0, 4); gsub(/\\\\/, "/", path); keep = (path ~ "(^|/)packages/.*/" scope); }
  keep { print }
' "${coverage_file}" >"${judged}"

if [[ ${#scope_dirs[@]} -eq 0 ]]; then
  if [[ -s ${judged} ]]; then
    echo "❌ the ${mode} ledger covers ${scope} files, but no ${scope} directory was found under packages/" >&2
    exit 1
  fi
  echo "✅ No ${scope} directory exists in any workspace package yet: the ${mode} ledger has nothing to judge (${coverage_file})" |
    tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
  exit 0
fi

awk '
  BEGIN { files = 0; lines_found = 0; lines_hit = 0 }
  /^SF:/ { files++ }
  /^LF:/ { lines_found += substr($0, 4) + 0 }
  /^LH:/ { lines_hit += substr($0, 4) + 0 }
  END {
    if (files == 0) {
      print "❌ coverage ledger contains no source files" > "/dev/stderr"
      exit 1
    }
    if (lines_found == 0) {
      print "❌ coverage ledger contains no executable lines" > "/dev/stderr"
      exit 1
    }
    if (lines_hit != lines_found) {
      printf "❌ coverage is not 100%%: %d/%d lines hit\n", lines_hit, lines_found > "/dev/stderr"
      exit 1
    }
  }
' "${judged}"

# GNU grep rather than rg, for the POSIX-only promise above; on these directories the two list the
# same files.
grep -rlE --include='*.ts' --include='*.tsx' --include='*.mts' --include='*.cts' \
  '^(export )?(async )?(function|class|const|let|var|enum)\b|^[[:space:]]*(const|let|var)\b' "${scope_dirs[@]}" |
  sort -u >"${source_list}"
awk '
  /^SF:/ {
    path = substr($0, 4)
    gsub(/\\\\/, "/", path)
    if (path ~ /\/packages\//) sub(/^.*\/packages\//, "packages/", path)
    print path
  }
' "${judged}" | sort -u >"${coverage_list}"
missing="$(comm -23 "${source_list}" "${coverage_list}" | head -n 1)"
[[ -n ${missing} ]] && echo "❌ source file missing from coverage ledger: ${missing}" >&2 && exit 1

echo "✅ Coverage artifact matches the complete ${mode} production ledger: ${coverage_file}"
