#!/usr/bin/env bash
set -euo pipefail

# The macOS jobs that a pull request runs only when their inputs change.
#
# `scripts/ci/macos-relevance.sh` decides, from a pull request's changed files, whether Containment,
# Sandbox Shell (Safari) and the macos-15 leg of Harness Contract have anything to prove. The cost of a
# path list that misses an input is a macOS break that shows up on `main`, one merge later, so the
# lists are held to the scripts the jobs run instead of to a reviewer's memory:
#
#   1. every test path a job runs, and every file those tests import, selects THAT job;
#   2. a docs-only or unrelated change selects none, and the toolchain, the lockfile and the workflows
#      select all three, so the lists cannot silently become "never" or "always";
#   3. `main`, a manual dispatch and any doubt run all three;
#   4. ci.yaml gates exactly those jobs on the decision, and leaves Smoke darwin-arm64 ungated.

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

decider="scripts/ci/macos-relevance.sh"
workflow=".github/workflows/ci.yaml"
containment_script="scripts/ci/darwin-confinement.sh"
safari_script="scripts/ci/safari-render-proof.sh"
harness_script="packages/fleet/tests/contract/run.sh"

fail() {
  echo "❌ $*" >&2
  exit 1
}

for required in "${decider}" "${workflow}" "${containment_script}" "${safari_script}" "${harness_script}"; do
  [ -f "${required}" ] || fail "macOS relevance input is missing: ${required}"
done

tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT

# decide <path>... → prints "containment safari harness" for a pull request that changes exactly them.
decide() {
  local out="${tmp_dir}/out"
  printf '%s\n' "$@" >"${tmp_dir}/files"
  : >"${out}"
  MACOS_RELEVANCE_FILES="${tmp_dir}/files" GITHUB_OUTPUT="${out}" "${decider}" >/dev/null
  printf '%s %s %s' \
    "$(sed -n 's/^containment=//p' "${out}")" "$(sed -n 's/^safari=//p' "${out}")" "$(sed -n 's/^harness=//p' "${out}")"
}

expect() {
  local want="$1" why="$2" got
  shift 2
  got="$(decide "$@")"
  [ "${got}" = "${want}" ] || fail "${why}: expected containment/safari/harness = ${want}, got ${got} (changed: $*)"
}

# A directory a script names is represented by a file inside it.
as_file() { if [ -d "$1" ]; then echo "$1/x.ts"; else echo "$1"; fi; }

# Relative imports of a TypeScript file, resolved to repo-relative paths.
imports_of() {
  local file="$1" spec
  { rg --no-filename --only-matching "from '[.][^']*'" "${file}" || true; } |
    sed -E "s/^from '(.*)'\$/\\1/" |
    while IFS= read -r spec; do
      realpath -m --relative-to="${root_dir}" "$(dirname "${file}")/${spec}"
    done
}

ts_files_under() { git ls-files "$@" | { rg '[.]ts$' || true; }; }

# ─── 1. every input a job's script reads selects that job ───────────────────────────────────────

# expect_job <label> <column 1..3> <path>... — each path, changed alone, must select the job.
expect_job() {
  local job="$1" column="$2" path got
  shift 2
  for path in "$@"; do
    [ -e "${path}" ] || fail "${job}: ${path} is read by its script but does not exist; update ${decider}"
    got="$(decide "$(as_file "${path}")" | cut -d' ' -f"${column}")"
    [ "${got}" = true ] || fail "${job}: an input of its script does not select it (changed: ${path}); update ${decider}"
  done
}

mapfile -t containment_paths < <(rg --no-filename --only-matching 'packages/[A-Za-z0-9_./-]+' "${containment_script}" | sort -u)
[ "${#containment_paths[@]}" -ge 5 ] || fail "found only ${#containment_paths[@]} test paths in ${containment_script}; the extraction is stale"
mapfile -t containment_files < <(
  for path in "${containment_paths[@]}"; do
    if [ -d "${path}" ]; then ts_files_under "${path}"; else echo "${path}"; fi
  done
)
mapfile -t containment_imports < <(for file in "${containment_files[@]}"; do imports_of "${file}"; done | sort -u)
expect_job 'Containment (macOS)' 1 "${containment_script}" "${containment_paths[@]}" "${containment_files[@]}" "${containment_imports[@]}"

mapfile -t safari_files < <(ts_files_under packages/pwa/harness/fy-render-safari)
[ "${#safari_files[@]}" -ge 3 ] || fail "found only ${#safari_files[@]} files under packages/pwa/harness/fy-render-safari; the extraction is stale"
mapfile -t safari_imports < <(for file in "${safari_files[@]}"; do imports_of "${file}"; done | sort -u)
expect_job 'Sandbox Shell (Safari)' 2 "${safari_script}" "${safari_files[@]}" "${safari_imports[@]}" packages/pwa/public/_headers

mapfile -t harness_files < <(ts_files_under packages/fleet/tests/contract packages/daemon/tests/contract)
[ "${#harness_files[@]}" -ge 5 ] || fail "found only ${#harness_files[@]} contract files; the extraction is stale"
mapfile -t harness_imports < <(for file in "${harness_files[@]}"; do imports_of "${file}"; done | sort -u)
verified_file="$(rg --no-filename --only-matching 'packages/protocol/src/lib/harness-update[.]ts' "${harness_script}" | head -n 1)"
[ -n "${verified_file}" ] || fail "${harness_script} no longer names the file that holds VERIFIED_HARNESS_VERSIONS"
expect_job 'Harness Contract (macos-15)' 3 "${harness_script}" "${harness_files[@]}" "${harness_imports[@]}" "${verified_file}"

# ─── 2. the lists are neither "never" nor "always" ──────────────────────────────────────────────

expect 'false false false' 'documentation only' docs/standards/ci-cd/index.md README.md
expect 'false false false' 'a PWA feature unrelated to the sandbox shell' packages/pwa/src/features/settings/capability-list.tsx
expect 'false false false' 'a daemon route unrelated to the file viewer' packages/daemon/src/lib/grants/policy.ts
for always in flake.lock flake.nix nix/pre-commit.nix .github/workflows/ci.yaml .github/workflows/e2e.yaml .github/actions/install-nix/action.yml bun.lock; do
  expect 'true true true' "the toolchain, the lockfile or a workflow changed (${always})" "${always}"
done
expect 'true false false' 'only the containment script changed' scripts/ci/darwin-confinement.sh
expect 'false true false' 'only the Safari script changed' scripts/ci/safari-render-proof.sh
expect 'true false true' 'a change spanning two jobs selects both' scripts/ci/darwin-confinement.sh packages/fleet/src/index.ts

# ─── 3. main, manual dispatch and any doubt run all three ───────────────────────────────────────

run_with() {
  : >"${tmp_dir}/run-out"
  env "$@" GITHUB_OUTPUT="${tmp_dir}/run-out" "${decider}" >/dev/null
}

all_selected() {
  local what="$1" key
  for key in containment safari harness; do
    grep -qx "${key}=true" "${tmp_dir}/run-out" || fail "${what}: expected ${key}=true"
  done
  grep -qx 'harness_os=\["ubuntu-latest","macos-15"\]' "${tmp_dir}/run-out" || fail "${what}: harness_os must carry macos-15"
}

for event in push workflow_dispatch schedule; do
  run_with -u MACOS_RELEVANCE_FILES GITHUB_EVENT_NAME="${event}"
  all_selected "event ${event}"
done
: >"${tmp_dir}/empty-files"
run_with MACOS_RELEVANCE_FILES="${tmp_dir}/empty-files"
all_selected 'an empty file list'
printf 'README.md\n' >"${tmp_dir}/readme-files"
run_with MACOS_RELEVANCE_FILES="${tmp_dir}/readme-files"
grep -qx 'harness_os=\["ubuntu-latest"\]' "${tmp_dir}/run-out" || fail 'a docs-only change must leave Harness Contract on its Linux leg alone'

# ─── 4. ci.yaml gates exactly these jobs ────────────────────────────────────────────────────────

job_block() {
  awk -v id="$1" '
    $0 == "  " id ":" { in_job = 1; print; next }
    in_job && /^  [A-Za-z0-9_-]+:$/ { exit }
    in_job { print }
  ' "${workflow}"
}

block_has() {
  local id="$1" pattern="$2" what="$3" block
  block="$(job_block "${id}")"
  [ -n "${block}" ] || fail "${workflow} has no job '${id}'"
  rg -q -- "${pattern}" <<<"${block}" || fail "${workflow}: job '${id}' ${what}"
}

block_has changes 'scripts/ci/macos-relevance[.]sh' 'must run scripts/ci/macos-relevance.sh'
block_has changes 'runs-on: ubuntu-latest' 'must run on GitHub, not Namespace'
block_has darwin-confinement '^    needs: changes$' 'must need changes'
block_has darwin-confinement "^    if: needs[.]changes[.]outputs[.]containment == 'true'\$" 'must run only when containment is true'
block_has safari-sandbox-shell '^    needs: changes$' 'must need changes'
block_has safari-sandbox-shell "^    if: needs[.]changes[.]outputs[.]safari == 'true'\$" 'must run only when safari is true'
block_has harness-contract '^    needs: changes$' 'must need changes'
block_has harness-contract 'os: [$][{][{] fromJSON[(]needs[.]changes[.]outputs[.]harness_os[)] [}][}]' 'must take its os matrix from harness_os'
if job_block smoke | rg -q 'changes'; then
  fail "${workflow}: Smoke darwin-arm64 must run on every pull request, not be gated on \`changes\`"
fi
if job_block harness-contract | rg -q '^    if:'; then
  fail "${workflow}: Harness Contract must not carry a job-level if: — its Linux leg always runs; gate the macos-15 leg through \`harness_os\`"
fi

echo "✅ macOS relevance holds: every input of the three optional macOS jobs selects its job, main runs them all"
