#!/usr/bin/env bash
set -euo pipefail

# The PWA browser gate of CI (`pwa-screenshot`), which a pull request runs only when something it reads
# changes.
#
# `scripts/ci/pwa-relevance.sh` decides, from a pull request's changed files, whether the three legs of
# the gate (Settings geometry, full gallery at two viewports) have anything to prove. A path list that
# misses an input lets a browser regression reach `main`, so the list is held to the code instead of to a
# reviewer's memory:
#
#   1. every file the harness's bundle imports — traced from `harness/screenshot.ts` and
#      `harness/main.tsx`, transitively — that lives outside `packages/pwa/` selects the gate, and so
#      does every workspace package the bundle (or those packages) imports;
#   2. every script `pwa-screenshot-proof.sh` runs, the toolchain and the workflow select it;
#   3. a docs-only or unrelated change (daemon, CLI) selects nothing, so the list cannot silently become
#      "always" — and a change that mixes docs with one input still selects it;
#   4. `main`, a manual dispatch, the nightly and any doubt (no PR number, an unreadable or empty file
#      list) run it;
#   5. ci.yaml gates `pwa-screenshot` exactly on the decision, from a job that is a few seconds of bash on
#      GitHub (no nix, no Namespace, sparse checkout), and nothing waits on the gated job.

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

decider="scripts/ci/pwa-relevance.sh"
workflow=".github/workflows/ci.yaml"
proof_script="scripts/ci/pwa-screenshot-proof.sh"
roots=(packages/pwa/harness/screenshot.ts packages/pwa/harness/main.tsx)

fail() {
  echo "❌ $*" >&2
  exit 1
}

for required in "${decider}" "${workflow}" "${proof_script}" "${roots[@]}"; do
  [ -f "${required}" ] || fail "PWA relevance input is missing: ${required}"
done

tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT

# decide <path>... → prints run=true|false for a pull request that changes exactly them.
decide() {
  local out="${tmp_dir}/out"
  printf '%s\n' "$@" >"${tmp_dir}/files"
  : >"${out}"
  PWA_RELEVANCE_FILES="${tmp_dir}/files" GITHUB_OUTPUT="${out}" "${decider}" >/dev/null
  sed -n 's/^run=//p' "${out}"
}

selects() {
  local path
  for path in "$@"; do
    [ "$(decide "${path}")" = true ] || fail "a pull request that changes only ${path} would not run the PWA browser gate; update ${decider}"
  done
}

ignores() {
  local path
  for path in "$@"; do
    [ "$(decide "${path}")" = false ] || fail "a pull request that changes only ${path} must not run the PWA browser gate; update ${decider}"
  done
}

# ─── 1. every import of the harness's bundle selects the gate ───────────────────────────────────

# A relative specifier, resolved from the importing file's directory to an existing repo file, left in
# RESOLVED (empty when none exists). Pure bash with no subshell: a fork per import made the trace ~20s.
resolve_module() {
  local -a parts=() out=()
  local part base candidate
  RESOLVED=""
  IFS=/ read -r -a parts <<<"$1/$2"
  for part in "${parts[@]}"; do
    case "${part}" in
    '' | .) ;;
    ..) unset 'out[-1]' ;;
    *) out+=("${part}") ;;
    esac
  done
  local IFS=/
  base="${out[*]}"
  for candidate in "${base}" "${base}.ts" "${base}.tsx" "${base}/index.ts" "${base}/index.tsx"; do
    if [ -f "${candidate}" ]; then
      RESOLVED="${candidate}"
      return
    fi
  done
}

# Breadth-first, one `rg` per level over the whole frontier: ~1,200 files, a dozen calls.
declare -A seen=()
declare -A workspace=()
frontier=("${roots[@]}")
while [ "${#frontier[@]}" -gt 0 ]; do
  for file in "${frontier[@]}"; do seen["${file}"]=1; done
  declare -A queued=()
  while IFS=' ' read -r file spec; do
    case "${spec}" in
    .*)
      resolve_module "${file%/*}" "${spec}"
      if [ -n "${RESOLVED}" ] && [ -z "${seen[${RESOLVED}]:-}" ]; then queued["${RESOLVED}"]=1; fi
      ;;
    @ferretry/*) workspace["$(sed -E 's#^@ferretry/([^/]+).*#\1#' <<<"${spec}")"]=1 ;;
    esac
  done < <(
    { rg --with-filename --no-heading --only-matching --no-line-number "(from|import)[[:space:]]*[(]?[[:space:]]*'[^']+'" "${frontier[@]}" || true; } |
      sed -E "s/^([^:]+):.*'([^']+)'.*\$/\\1 \\2/"
  )
  frontier=("${!queued[@]}")
  unset queued
done
[ "${#seen[@]}" -ge 200 ] || fail "traced only ${#seen[@]} files from the harness roots; the extraction is stale"

# What the PWA's bundle imports is the closure over the packages' own manifests: `fleet` and `relay`
# import `protocol`, and the PWA imports all three.
workspace_name_of() { jq -r '.name' "packages/$1/package.json"; }
changed=1
while [ "${changed}" -eq 1 ]; do
  changed=0
  for pkg in "${!workspace[@]}"; do
    [ -f "packages/${pkg}/package.json" ] || fail "the bundle imports @ferretry/${pkg}, which has no packages/${pkg}/package.json"
    while IFS= read -r dep; do
      dep="${dep#@ferretry/}"
      if [ -z "${workspace[${dep}]:-}" ]; then
        workspace["${dep}"]=1
        changed=1
      fi
    done < <(jq -r '((.dependencies // {}) + (.devDependencies // {})) | keys[] | select(startswith("@ferretry/"))' "packages/${pkg}/package.json")
  done
done
for expected in protocol relay fleet; do
  [ -n "${workspace[${expected}]:-}" ] || fail "the bundle no longer imports @ferretry/${expected}; the extraction is stale (or the list can shrink)"
done
for pkg in "${!workspace[@]}"; do
  [ "$(workspace_name_of "${pkg}")" = "@ferretry/${pkg}" ] || fail "packages/${pkg} is not named @ferretry/${pkg}"
  [ "${pkg}" = pwa ] && continue
  selects "packages/${pkg}/package.json" "packages/${pkg}/src/x.ts" "packages/${pkg}/tests/x.test.ts"
done

# Files the bundle reaches by a relative import out of packages/pwa.
for file in "${!seen[@]}"; do
  case "${file}" in
  packages/pwa/*) ;;
  *) selects "${file}" ;;
  esac
done

# What the harness and the PWA build read inside the package by path rather than by import: they select
# the gate because everything under packages/pwa does. Naming them keeps the claim honest.
selects packages/pwa/tailwind.config.ts packages/pwa/public/_headers packages/pwa/public/pre-paint.js \
  packages/pwa/harness/index.html packages/pwa/src/assets/fonts/x.woff2

# ─── 2. the scripts the job runs, the toolchain and the workflow ────────────────────────────────

selects "${proof_script}"
while IFS= read -r script; do
  [ -e "${script}" ] || fail "${proof_script} runs ${script}, which does not exist"
  selects "${script}"
done < <(rg --only-matching --no-filename '[.]/scripts/[A-Za-z0-9_./-]+[.]sh' "${proof_script}" | sed 's#^[.]/##' | sort -u)
selects scripts/ci/in-devshell.sh scripts/ci/pwa-relevance.sh scripts/ci/setup.sh scripts/local/setup.sh
selects flake.nix flake.lock nix/env.nix nix/packages.nix bun.lock package.json packages/cli/package.json \
  packages/daemon/package.json bunfig.toml bunfig.test.toml tsconfig.json tsconfig.base.json packages/pwa/tsconfig.json \
  .github/workflows/ci.yaml .github/workflows/e2e.yaml .github/actions/install-nix/action.yml

# ─── 3. nothing relevant, nothing selected ──────────────────────────────────────────────────────

ignores README.md Changelog.md INSTALLATION.md docs/standards/ci-cd/index.md docs/relay-protocol.md \
  Casks/ferretry.rb VERSION packages/daemon/src/lib/grants/policy.ts packages/daemon/tests/unit/x.test.ts \
  packages/cli/src/lib/x.ts packages/cli/tests/unit/x.test.ts config/daemon.json tests/e2e/x.ts \
  scripts/validate/pwa-relevance.sh scripts/release/compile.sh
[ "$(decide docs/a.md README.md docs/standards/ci-cd/index.md packages/daemon/src/x.ts)" = false ] ||
  fail 'a docs-plus-daemon change must not run the PWA browser gate'
[ "$(decide docs/a.md README.md packages/pwa/src/x.ts)" = true ] ||
  fail 'a docs change that also touches the PWA must run the PWA browser gate'
[ "$(decide packages/daemon/src/x.ts packages/protocol/src/x.ts)" = true ] ||
  fail 'a change that also touches the protocol must run the PWA browser gate'

# ─── 4. main, dispatch and any doubt run it ─────────────────────────────────────────────────────

run_with() {
  : >"${tmp_dir}/run-out"
  env "$@" GITHUB_OUTPUT="${tmp_dir}/run-out" "${decider}" >/dev/null
  sed -n 's/^run=//p' "${tmp_dir}/run-out"
}

for event in push workflow_dispatch schedule; do
  [ "$(run_with -u PWA_RELEVANCE_FILES GITHUB_EVENT_NAME="${event}" PR_NUMBER=12)" = true ] ||
    fail "event ${event} must run the PWA browser gate"
done
[ "$(run_with -u PWA_RELEVANCE_FILES GITHUB_EVENT_NAME=pull_request PR_NUMBER=)" = true ] ||
  fail 'a pull request with no number must run the PWA browser gate'
: >"${tmp_dir}/empty-files"
[ "$(run_with PWA_RELEVANCE_FILES="${tmp_dir}/empty-files")" = true ] || fail 'an empty file list must run the PWA browser gate'

# The API path, with `gh` replaced: failing, empty and docs-only answers.
mkdir -p "${tmp_dir}/bin"
fake_gh() { printf '#!/usr/bin/env bash\n%s\n' "$1" >"${tmp_dir}/bin/gh" && chmod +x "${tmp_dir}/bin/gh"; }
api_run() {
  run_with -u PWA_RELEVANCE_FILES PATH="${tmp_dir}/bin:${PATH}" GITHUB_EVENT_NAME=pull_request PR_NUMBER=12 GITHUB_REPOSITORY=o/r
}
fake_gh 'exit 1'
[ "$(api_run)" = true ] || fail 'a pull request whose files cannot be listed must run the PWA browser gate'
fake_gh 'exit 0'
[ "$(api_run)" = true ] || fail 'a pull request that lists no files must run the PWA browser gate'
fake_gh 'printf "docs/a.md\nREADME.md\n"'
[ "$(api_run)" = false ] || fail 'a docs-only pull request, read through the API, must skip the PWA browser gate'
fake_gh 'printf "docs/a.md\npackages/pwa/src/x.tsx\n"'
[ "$(api_run)" = true ] || fail 'a pull request that changes the PWA, read through the API, must run the PWA browser gate'

# ─── 5. ci.yaml gates exactly this job, on the decision ─────────────────────────────────────────

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

block_has pwa-relevance 'scripts/ci/pwa-relevance[.]sh' 'must run scripts/ci/pwa-relevance.sh'
block_has pwa-relevance '^    runs-on: ubuntu-latest$' 'must run on GitHub, not Namespace: it is a few seconds of bash'
block_has pwa-relevance '^          sparse-checkout: scripts/ci$' 'must check out scripts/ci only'
block_has pwa-relevance '^      pull-requests: read$' 'must be able to list the pull request files'
block_has pwa-relevance '^    name: PWA Relevance$' 'must be named PWA Relevance'
block_has pwa-relevance '^      run: [$][{][{] steps[.]decide[.]outputs[.]run [}][}]$' 'must publish the decision as outputs.run'
if job_block pwa-relevance | rg -v '^[[:space:]]*#' | rg -q 'nscloud|nix|install-nix|in-devshell|needs:'; then
  fail "${workflow}: job 'pwa-relevance' must stay a bare bash job with no nix shell, no Namespace runner and no needs: it sits in front of the gate"
fi
block_has pwa-screenshot '^    needs: pwa-relevance$' 'must need pwa-relevance, and only it'
block_has pwa-screenshot "^    if: needs[.]pwa-relevance[.]outputs[.]run == 'true'\$" "must run only when the decision is 'true', with no other condition"
if rg -q 'needs:.*pwa-screenshot' .github/workflows; then
  fail 'no job may need pwa-screenshot: a skipped need would skip it too'
fi

echo "✅ PWA relevance holds: every import of the harness bundle ($(printf '%s\n' "${!seen[@]}" | wc -l | tr -d ' ') files, ${#workspace[@]} workspace packages) selects the gate, docs-only changes do not, main and any doubt run it, and ci.yaml gates exactly pwa-screenshot on the decision"
