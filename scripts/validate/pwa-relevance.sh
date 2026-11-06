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
#      list, a rename that moves an input out, a pull request past the files API's 3000-file cut-off) run it;
#   5. ci.yaml gates `pwa-screenshot` on the decision, from a job that is a few seconds of bash on GitHub
#      (no nix, no Namespace, sparse checkout), and nothing but relevance saying `false` can skip the gate
#      on a failed, cancelled or skipped relevance job: the decision is one conjunct of the gate's `if:`
#      (other conjuncts, like a label, may sit beside it), and a job that needs the gate must run
#      `always()` or `!cancelled()` (the `Full CI` verdict) so the skip does not cascade;
#   6. no relative import in a workspace package of the closure leaves that package, because the trace
#      follows packages by their manifests and would not see a file reached around them.

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
  NORMALIZED=""
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
  NORMALIZED="${base}"
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

# ─── 6. no relative import of a workspace package leaves it ─────────────────────────────────────

# The closure above is read from manifests, and the trace never opens a workspace package's files, so a
# relative import that climbs out of one (`../../other/src/x`) would reach a file nothing selects.
escapes=()
for pkg in "${!workspace[@]}"; do
  [ "${pkg}" = pwa ] && continue
  while IFS=' ' read -r file spec; do
    case "${spec}" in
    .*)
      resolve_module "${file%/*}" "${spec}"
      case "${NORMALIZED}/" in
      "packages/${pkg}/"*) ;;
      *) escapes+=("${file} imports '${spec}' (→ ${NORMALIZED})") ;;
      esac
      ;;
    esac
  done < <(
    { rg --with-filename --no-heading --only-matching --no-line-number -g '*.ts' -g '*.tsx' \
      "(from|import)[[:space:]]*[(]?[[:space:]]*'[^']+'" "packages/${pkg}" || true; } |
      sed -E "s/^([^:]+):.*'([^']+)'.*\$/\\1 \\2/"
  )
done
[ "${#escapes[@]}" -eq 0 ] || fail "a relative import leaves its workspace package, where the gate's trace cannot follow it: ${escapes[0]} (${#escapes[@]} in all)"

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
  run_with -u PWA_RELEVANCE_FILES FAKE_DIR="${tmp_dir}" PATH="${tmp_dir}/bin:${PATH}" GITHUB_EVENT_NAME=pull_request PR_NUMBER=12 GITHUB_REPOSITORY=o/r "$@"
}
fake_gh 'exit 1'
[ "$(api_run)" = true ] || fail 'a pull request whose files cannot be listed must run the PWA browser gate'
# A `gh` that applies the caller's own `--jq` to a JSON fixture, so the expression the script sends is the
# expression under test: `<repo>/pulls/N/files` answers from files.json, `<repo>/pulls/N` from pull.json.
# `FAKE_PULL_FAIL` makes the pull request read (the file count) fail.
fake_pr() {
  printf '%s' "$1" >"${tmp_dir}/files.json"
  printf '{"changed_files": %s}' "$2" >"${tmp_dir}/pull.json"
  cat >"${tmp_dir}/bin/gh" <<'FAKE'
#!/usr/bin/env bash
expr="" endpoint=""
while [ $# -gt 0 ]; do
  case "$1" in
  --jq) expr="$2"; shift ;;
  repos/*) endpoint="$1" ;;
  esac
  shift
done
case "${endpoint}" in
*/files) jq -r "${expr}" "${FAKE_DIR}/files.json" ;;
*) [ -z "${FAKE_PULL_FAIL:-}" ] || exit 1; jq -r "${expr}" "${FAKE_DIR}/pull.json" ;;
esac
FAKE
  chmod +x "${tmp_dir}/bin/gh"
}
fake_pr '[]' 0
[ "$(api_run)" = true ] || fail 'a pull request that lists no files must run the PWA browser gate'
fake_pr '[{"filename":"docs/a.md"},{"filename":"README.md"}]' 2
[ "$(api_run)" = false ] || fail 'a docs-only pull request, read through the API, must skip the PWA browser gate'
fake_pr '[{"filename":"docs/a.md"},{"filename":"packages/pwa/src/x.tsx"}]' 2
[ "$(api_run)" = true ] || fail 'a pull request that changes the PWA, read through the API, must run the PWA browser gate'
# A rename that moves an input OUT lists only the new path as `filename`; the old one is `previous_filename`.
fake_pr '[{"filename":"docs/_headers","previous_filename":"packages/pwa/public/_headers","status":"renamed"}]' 1
[ "$(api_run)" = true ] || fail 'a rename that moves packages/pwa/public/_headers out to docs/ must run the PWA browser gate'
fake_pr '[{"filename":"docs/b.md","previous_filename":"docs/a.md","status":"renamed"}]' 1
[ "$(api_run)" = false ] || fail 'a docs-to-docs rename must skip the PWA browser gate'
# The files API stops at 3000 files without saying so: the paths past that were never listed.
fake_pr '[{"filename":"docs/a.md"},{"filename":"README.md"}]' 3200
[ "$(api_run)" = true ] || fail 'a pull request of 3200 files, of which the API lists docs, must run the PWA browser gate'
fake_pr '[{"filename":"docs/a.md"},{"filename":"README.md"}]' 5
[ "$(api_run)" = true ] || fail 'a pull request that lists fewer files than it changes must run the PWA browser gate'
fake_pr '[{"filename":"docs/a.md"}]' 1
[ "$(api_run FAKE_PULL_FAIL=1)" = true ] || fail 'a pull request whose file count cannot be read must run the PWA browser gate'
fake_pr '[{"filename":"docs/a.md"}]' '"many"'
[ "$(api_run)" = true ] || fail 'a pull request whose file count is not a number must run the PWA browser gate'

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

# The gate's `if:` is a conjunction. Its top-level conjuncts are listed one per line (an `||` at the top
# level is reported as __TOP_LEVEL_OR__), with the `${{ }}` wrapper and the quoting kept intact.
conjuncts() {
  sed -E 's/^[[:space:]]*\$\{\{[[:space:]]*//; s/[[:space:]]*\}\}[[:space:]]*$//' <<<"$1" |
    awk '{
      s = $0; depth = 0; q = ""; cur = ""; has_or = 0
      for (i = 1; i <= length(s); i++) {
        c = substr(s, i, 1); two = substr(s, i, 2)
        if (q != "") { cur = cur c; if (c == q) q = ""; continue }
        if (c == "\047") { q = c; cur = cur c; continue }
        if (c == "(") depth++
        if (c == ")") depth--
        if (depth == 0 && two == "&&") { print cur; cur = ""; i++; continue }
        if (depth == 0 && two == "||") has_or = 1
        cur = cur c
      }
      print cur
      if (has_or) print "__TOP_LEVEL_OR__"
    }' |
    sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//'
}

gate_if="$(job_block pwa-screenshot | sed -n 's/^    if: //p' | head -n 1)"
[ -n "${gate_if}" ] || fail "${workflow}: job 'pwa-screenshot' must have a single-line if: that gates it on the decision"
gate_conjuncts="$(conjuncts "${gate_if}")"
rg -qx '__TOP_LEVEL_OR__' <<<"${gate_conjuncts}" &&
  fail "${workflow}: job 'pwa-screenshot': an || at the top level of its if: lets something other than the decision decide the gate; keep every condition a conjunct (&&)"
rg -qxF "needs.pwa-relevance.outputs.run != 'false'" <<<"${gate_conjuncts}" ||
  fail "${workflow}: job 'pwa-screenshot' if: must carry the conjunct needs.pwa-relevance.outputs.run != 'false' (only a 'false' may skip the gate: an empty output, from a relevance job that failed, timed out or was skipped, runs it)"
rg -qxF '!cancelled()' <<<"${gate_conjuncts}" ||
  fail "${workflow}: job 'pwa-screenshot' if: must carry the conjunct !cancelled(): without a status function a failed or skipped need skips the gate, and the relevance job must fail open at the job level"
if rg -q "pwa-relevance[.]result|run == 'true'" <<<"${gate_if}"; then
  fail "${workflow}: job 'pwa-screenshot' if: must not test the relevance result or run == 'true': that skips the gate when the relevance job fails"
fi

# A job may need the gate only when it runs whatever the gate did: a skipped need skips its dependants.
needs_gate=()
for file in .github/workflows/*.y*ml; do
  while IFS= read -r id; do
    [ "${file}" = "${workflow}" ] && [ "${id}" = pwa-screenshot ] && continue
    block="$(awk -v id="${id}" '
      $0 == "  " id ":" { in_job = 1; next }
      in_job && /^  [A-Za-z0-9_-]+:$/ { exit }
      in_job { print }
    ' "${file}" | { rg -v '^[[:space:]]*#' || true; })"
    needs="$(awk '/^    needs:/ { on = 1; print; next } on && /^      - / { print; next } { on = 0 }' <<<"${block}")"
    rg -q 'pwa-screenshot' <<<"${needs}" || continue
    job_if="$(sed -n 's/^    if: //p' <<<"${block}" | head -n 1)"
    rg -q '^(\$\{\{[[:space:]]*)?(always\(\)|!cancelled\(\))' <<<"${job_if}" ||
      needs_gate+=("${file}: ${id}")
  done < <(rg -o '^  [A-Za-z0-9_-]+:$' "${file}" | tr -d ' :')
done
[ "${#needs_gate[@]}" -eq 0 ] ||
  fail "a job that needs pwa-screenshot must have an if: starting with always() or !cancelled(), or a skipped gate skips it too: ${needs_gate[*]}"

echo "✅ PWA relevance holds: every import of the harness bundle ($(printf '%s\n' "${!seen[@]}" | wc -l | tr -d ' ') files, ${#workspace[@]} workspace packages) selects the gate, docs-only changes do not, main and any doubt run it, and ci.yaml gates pwa-screenshot on the decision, failing open"
