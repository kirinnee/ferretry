#!/usr/bin/env bash
# The 100% coverage ledger gate for one tier, over the LCOV of ONE serial run or of the tier's test
# groups (config/test-groups.json), each of which is a serial run of its own share of the files.
#
#   coverage-ledger.sh <unit|int> <lcov>...
#   coverage-ledger.sh <unit|int> --groups <dir>   # <dir>/coverage-<mode>-<group>/lcov.info, every group
#
# It asserts every path is inside the tier's scope (`src/lib/` for unit, `src/adapters/` for int),
# the ledger is non-empty, every line is hit, and no source file is missing from it.
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
  for name in "${names[@]}"; do ledgers+=("$2/coverage-${mode}-${name}/lcov.info"); done
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
  awk '
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
        printf "❌ %s reaches 100%% in no single test group (lines hit/found:%s); test its missed lines in the group that owns it\n", sf, seen[sf] > "/dev/stderr"
        printf "%s", best[sf]
      }
    }
  ' "$@" >"${merged}"
  mv "${merged}" "${coverage_file}"
fi

scope="src/lib/"
[[ ${mode} == "int" ]] && scope="src/adapters/"
mapfile -t scope_dirs < <(find packages -mindepth 3 -maxdepth 3 -type d -path "packages/*/${scope%/}" | sort)
if [[ ${mode} == "unit" ]]; then
  # The PWA is browser glue, so its hooks and shell chrome deliberately live
  # outside the domain-tier src/lib directory. They are production code just
  # as much as lib modules are, and must remain in the 100% unit ledger.
  #
  # Feature screens use mounted React tests, so they belong in the same 100%
  # ledger as browser glue rather than being a source-text-tested exception.
  #
  # src/features (the surfaces ported from kteam) is in it for the same reason:
  # every module under it is proved by an executed render or projection test, so
  # new feature code cannot ship untested behind a green build.
  mapfile -t pwa_dirs < <(find packages/pwa/src -mindepth 1 -maxdepth 1 -type d \( -name components -o -name features -o -name hooks -o -name shell \) | sort)
  scope_dirs+=("${pwa_dirs[@]}")
  # The composition root is a package-root FILE, so no directory glob reaches
  # it, yet it is the most consequential production module in the package: it
  # is where routes, stores, notification surfaces and browser capabilities are
  # wired together. Named explicitly so it carries the same 100% obligation as
  # everything it composes.
  #
  # `src/main.tsx` is deliberately absent, and the honest reason is that nothing
  # executes it: importing it calls `createRoot` against the live document, and
  # re-importing it to reach its missing-`#root` branch would need module-cache
  # tricks. So its body — the throw, the stylesheet import, the render — is
  # UNPROVED, which is affordable only while the entry point stays this small.
  # What `tests/unit/host-document.test.ts` does prove is narrower and is about
  # the document: `#root` is present, the id the entry module looks up is that
  # same id, and the one module the page boots is this exact file. Any decision
  # worth testing belongs in `App.tsx`, which is in the ledger.
  scope_dirs+=("packages/pwa/src/App.tsx")
fi
[[ ${#scope_dirs[@]} -eq 0 ]] && echo "❌ no workspace source directories found for ${scope}" >&2 && exit 1
source_list="$(mktemp)"
coverage_list="$(mktemp)"
trap 'rm -f "${source_list}" "${coverage_list}"' EXIT

awk -v scope="${scope}" -v mode="${mode}" '
  BEGIN { files = 0; lines_found = 0; lines_hit = 0; bad = 0 }
  /^SF:/ {
    path = substr($0, 4)
    gsub(/\\\\/, "/", path)
    files++
    allowed = path ~ "(^|/)" scope
    if (mode == "unit" && path ~ "(^|/)packages/pwa/src/(components|features|hooks|shell)/") allowed = 1
    if (mode == "unit" && path ~ "(^|/)packages/pwa/src/App\\.tsx$") allowed = 1
    if (!allowed) {
      printf "❌ coverage path outside %s: %s\n", scope, path > "/dev/stderr"
      bad = 1
    }
  }
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
    if (bad != 0) exit 1
  }
' "${coverage_file}"

# GNU grep rather than rg, for the POSIX-only promise above; on these directories the two list the
# same files.
grep -rlE --include='*.ts' --include='*.tsx' --include='*.mts' --include='*.cts' \
  '^(export )?(async )?(function|class|const|let|var|enum)\b|^[[:space:]]*(const|let|var)\b' "${scope_dirs[@]}" |
  sort -u >"${source_list}"
awk -v scope="${scope}" '
  /^SF:/ {
    path = substr($0, 4)
    gsub(/\\\\/, "/", path)
    if (path ~ /\/packages\//) sub(/^.*\/packages\//, "packages/", path)
    else if (path !~ /^packages\// && path ~ /^[^/]+\/src\//) path = "packages/" path
    print path
  }
' "${coverage_file}" | sort -u >"${coverage_list}"
missing="$(comm -23 "${source_list}" "${coverage_list}" | head -n 1)"
[[ -n ${missing} ]] && echo "❌ source file missing from coverage ledger: ${missing}" >&2 && exit 1

echo "✅ Coverage artifact matches the complete ${mode} production ledger: ${coverage_file}"
