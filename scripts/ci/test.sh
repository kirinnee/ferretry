#!/usr/bin/env bash
set -euo pipefail

mode="${1:-}"
[[ ${mode} != "unit" && ${mode} != "int" && ${mode} != "sit" ]] && echo "❌ usage: $0 <unit|int|sit>" >&2 && exit 2

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

./scripts/ci/setup.sh

if [[ ${mode} == "sit" ]]; then
  [[ -d dist/bin ]] && chmod -R +x dist/bin
  [[ -n ${CLI_BIN:-} ]] && chmod +x "${CLI_BIN}"
  echo "🧪 Running sit tests..."
  SIT_DRIVER=binary bun test --config=bunfig.sit.toml
  echo "✅ sit tests passed"
  exit 0
fi

config="bunfig.${mode}.toml"
coverage_dir="coverage/${mode}"
coverage_file="${coverage_dir}/lcov.info"
scope="src/lib/"
[[ ${mode} == "int" ]] && scope="src/adapters/"
mapfile -t scope_dirs < <(find packages -mindepth 3 -maxdepth 3 -type d -path "packages/*/${scope%/}" | sort)
if [[ ${mode} == "unit" ]]; then
  # The PWA is browser glue, so its hooks and AudioWorklets deliberately live
  # outside the domain-tier src/lib directory. They are production code just as
  # much as lib modules are, and must remain in the 100% unit ledger.
  mapfile -t pwa_dirs < <(find packages/pwa/src -mindepth 1 -maxdepth 1 -type d \( -name hooks -o -name worklets \) | sort)
  scope_dirs+=("${pwa_dirs[@]}")
fi
[[ ${#scope_dirs[@]} -eq 0 ]] && echo "❌ no workspace source directories found for ${scope}" >&2 && exit 1
source_list="$(mktemp)"
coverage_list="$(mktemp)"
trap 'rm -f "${source_list}" "${coverage_list}"' EXIT

echo "🧪 Running ${mode} tests with coverage..."
rm -rf "${coverage_dir}"

set +e
bun test --config="${config}" --coverage
test_status=$?
set -e

[[ ! -f ${coverage_file} ]] && echo "❌ No coverage artifact found at ${coverage_file}" >&2 && exit 1

awk -v scope="${scope}" -v mode="${mode}" '
  BEGIN { files = 0; lines_found = 0; lines_hit = 0; bad = 0 }
  /^SF:/ {
    path = substr($0, 4)
    gsub(/\\\\/, "/", path)
    files++
    allowed = path ~ "(^|/)" scope
    if (mode == "unit" && path ~ "(^|/)packages/pwa/src/(hooks|worklets)/") allowed = 1
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

rg -l --glob '*.{ts,tsx,mts,cts}' '^(export )?(async )?(function|class|const|let|var|enum)\b|^[[:space:]]*(const|let|var)\b' "${scope_dirs[@]}" | sort -u >"${source_list}"
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
[[ ${test_status} -ne 0 ]] && echo "❌ ${mode} tests failed (exit ${test_status})" >&2 && exit "${test_status}"
echo "✅ ${mode} tests passed"
