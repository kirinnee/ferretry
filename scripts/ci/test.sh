#!/usr/bin/env bash
set -euo pipefail

# Tests run offline (packages/daemon/tests/support/offline-environment.ts preloads the same): no booted
# daemon follows the published model catalog, asks the hosted relay directory or checks for updates.
export FY_MODEL_CATALOG="${FY_MODEL_CATALOG:-off}"
export FY_LOCAL_MODELS="${FY_LOCAL_MODELS:-off}"
export FY_RELAY_DIRECTORY_ORIGIN="${FY_RELAY_DIRECTORY_ORIGIN:-off}"
export FY_UPDATE_CHECK="${FY_UPDATE_CHECK:-off}"

mode="${1:-}"
group="${2:-}"
[[ ${mode} != "unit" && ${mode} != "int" && ${mode} != "sit" ]] && echo "❌ usage: $0 <unit|int|sit> [group]" >&2 && exit 2

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

./scripts/ci/setup.sh
./scripts/validate/pinned-toolchain.sh
./scripts/validate/pages-config.sh
# The hosted relay's Worker config, deploy workflow and control-plane projections have no test that
# can fail for them — `bun test` never reads a wrangler config or a workflow's shell. This is the
# only place CI looks at them.
./scripts/validate/relay-config.sh

# The per-test budget, ON THE COMMAND LINE. `[test] timeout` in a bunfig is ignored by
# Bun, so a tier that needs longer than the 5-second default has to say so here. The
# unit tier deliberately keeps the default: a unit test that needs two minutes is a unit
# test that is doing something else.
timeout_flag=()
if [[ ${mode} != "unit" ]]; then
  timeout_flag=(--timeout 120000)
fi

if [[ ${mode} == "sit" ]]; then
  [[ -d dist/bin ]] && chmod -R +x dist/bin
  [[ -n ${CLI_BIN:-} ]] && chmod +x "${CLI_BIN}"
  echo "🧪 Running sit tests..."
  SIT_DRIVER=binary ./scripts/test/swept.sh bun test --config=bunfig.sit.toml "${timeout_flag[@]}"
  echo "✅ sit tests passed"
  exit 0
fi

config="bunfig.${mode}.toml"
coverage_file="coverage/${mode}/lcov.info"
files=()

# A TEST GROUP (config/test-groups.json) runs one share of the tier's files, so CI can run the
# shares on parallel runners. Each test file belongs to the first group with a prefix of its path.
# A group writes its own ledger and does not judge it: only all the groups together can, which is
# the CI ledger job's `scripts/ci/coverage-ledger.sh`. Without a group the whole tier runs here
# serially and is judged here, exactly as before.
if [[ -n ${group} ]]; then
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
  mapfile -t files < <(
    find packages -path '*/node_modules' -prune -o -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) \
      -not -path "*/tests/${other_tier}/*" -not -path '*/tests/sit/*' -print | sort |
      jq -R -r --slurpfile groups "${groups}" --arg mode "${mode}" --arg group "${group}" '
        . as $file
        | [$groups[0][$mode][] | select(any(.prefixes[]; . as $prefix | $file | startswith($prefix)))][0].name
        | select(. == $group) | "./" + $file
      '
  )
  [[ ${#files[@]} -eq 0 ]] && echo "❌ ${mode} test group ${group} holds no test files" >&2 && exit 1
  coverage_file="coverage/${mode}/groups/${group}/lcov.info"
  # `--coverage-dir` loses to the bunfig's `coverageDir`, so the group gets a copy that names its own.
  config="coverage/${mode}/groups/${group}/bunfig.toml"
  mkdir -p "${config%/*}"
  sed "s|^coverageDir = .*|coverageDir = \"${coverage_file%/*}\"|" "bunfig.${mode}.toml" >"${config}"
  echo "🧪 ${mode} test group ${group}: ${#files[@]} files"
fi

# The integration tier starts real Chromes, and the first one on a fresh runner is slow — paid once
# here rather than inside whichever test happens to start it (see the script).
[[ ${mode} == "int" ]] && ./scripts/ci/warm-chrome.sh

echo "🧪 Running ${mode} tests with coverage..."
rm -f "${coverage_file}"

coverage_dir="${coverage_file%/*}"
mkdir -p "${coverage_dir}"
set +e
# `swept.sh` gives each run its own TMPDIR and FERRETRY_TEST=1, and fails it if a tmux server outlives
# it — see the script. The quarantine rerun below is a second run, so it is swept on its own.
./scripts/test/swept.sh bun test --config="${config}" "${timeout_flag[@]}" --coverage --reporter=junit --reporter-outfile="${coverage_dir}/junit.xml" "${files[@]}" 2>&1 | tee "${coverage_dir}/console.log"
# A red run whose every failure is a quarantined flake reruns those files once, and its exit is the
# run's from here on: 0 when green or rescued, the original status otherwise — see the script.
./scripts/test/swept.sh bun scripts/ci/quarantine.ts "${mode}" "${PIPESTATUS[0]}" "${config}" "${coverage_dir}" "${coverage_dir}/console.log" "${timeout_flag[@]}"
test_status=$?
set -e

if [[ -n ${group} ]]; then
  # Present but possibly EMPTY: a group whose suites load no in-scope source has nothing to report.
  [[ ! -f ${coverage_file} ]] && echo "❌ No coverage artifact found at ${coverage_file}" >&2 && exit 1
  echo "✅ ${mode} test group ${group} wrote its ledger: ${coverage_file} (judged with the other groups' by scripts/ci/coverage-ledger.sh)"
else
  ./scripts/ci/coverage-ledger.sh "${mode}" "${coverage_file}"
fi
[[ ${test_status} -ne 0 ]] && echo "❌ ${mode} tests failed (exit ${test_status})" >&2 && exit "${test_status}"
echo "✅ ${mode} tests passed"
