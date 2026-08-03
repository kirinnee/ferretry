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
  # The PWA is browser glue, so its hooks, shell chrome and AudioWorklets
  # deliberately live outside the domain-tier src/lib directory. They are
  # production code just as much as lib modules are, and must remain in the
  # 100% unit ledger.
  #
  # Feature screens use mounted React tests, so they belong in the same 100%
  # ledger as browser glue rather than being a source-text-tested exception.
  #
  # src/features (the surfaces ported from kteam) is in it for the same reason:
  # every module under it is proved by an executed render or projection test, so
  # new feature code cannot ship untested behind a green build.
  mapfile -t pwa_dirs < <(find packages/pwa/src -mindepth 1 -maxdepth 1 -type d \( -name components -o -name features -o -name hooks -o -name worklets -o -name shell \) | sort)
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
    if (mode == "unit" && path ~ "(^|/)packages/pwa/src/(components|features|hooks|worklets|shell)/") allowed = 1
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
