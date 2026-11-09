#!/usr/bin/env bash
set -euo pipefail

# The hosted app's origin has ONE owner, and every build route asks the same script for it.
#
# WHY. Access, Connections and Logins each spelled `https://ferretry.pages.dev` themselves, so a build for another
# hosted app (the 5.0 preview at ferretry-v5.pages.dev) would have paired phones to one app, read the catalog from
# another and allowed a third in CORS, and nothing would have said so. The origin is now a build-time fact, like the
# relay directory origin (scripts/ci/relay-directory-origin.sh): one source module, one script that turns the
# switch (`FY_HOSTED_APP_ORIGIN`) into the app's define, the daemon's defines and the release key file.
#
# WHAT IS CHECKED.
#   1. Exactly one `export const DEFAULT_HOSTED_APP_ORIGIN` and one `export const HOSTED_APP_ORIGIN` exist under
#      packages/, both in the kernel's `contract/hosted-app.ts`.
#   2. No other non-test source, config or script under packages/, scripts/ or .github/ spells the production host
#      (a second literal). Tests and docs may; they describe the default, they do not decide it.
#   3. Every build route asks the script: the app build (`vite.config.ts`), the daemon compile (`compile.sh`), the
#      release (`build-release.ts`) and the signing scripts, and the Logins manifest derives its network host from the
#      constant instead of spelling it.
#   4. The script itself behaves: the production app by default with no define, a named app with its own origin,
#      key file and defines, and a refusal of anything but a plain https origin.
#   5. Only the preview's workflow sets `FY_HOSTED_APP_ORIGIN`; production's must not.
#   6. Every tracked shell script under scripts/ is committed executable (mode 100755). The app build, the daemon
#      compile and the signing scripts RUN them by path: a script committed 100644 fails with EACCES there, and a
#      caller that read the failure as "no output" once compiled a daemon for the production app, silently.
#
# SELF-TEST. Every run first plants each violation of (1) and (2) in a throwaway tree and requires the gate to catch
# it, then requires a clean tree to pass. `--root <dir>` checks another tree and skips the self-test and (3) to (6).

source_rel="packages/core/kernel/contract/hosted-app.ts"
production_host='ferretry\.pages\.dev'

fail() {
  echo "❌ $*" >&2
  return 1
}

# Source files under <root> the literal check covers: not tests, docs, generated output or dependencies.
literal_hits() {
  local root="$1"
  rg -n --no-heading "${production_host}" \
    --glob '!**/tests/**' --glob '!**/*.test.*' --glob '!**/node_modules/**' --glob '!**/dist/**' \
    --glob '!**/generated/**' --glob '!**/*.md' --glob '!**/scripts/validate/hosted-app-origin.sh' \
    --glob '!**/scripts/ci/hosted-app-origin.sh' --glob "!**/${source_rel}" \
    "${root}/packages" "${root}/scripts" "${root}/.github" 2>/dev/null || true
}

check_owner() {
  local root="$1" status=0 owners defaults
  mapfile -t defaults < <(rg -l --glob '*.ts' --glob '!**/tests/**' --glob '!**/node_modules/**' \
    '^export const DEFAULT_HOSTED_APP_ORIGIN = ' "${root}/packages" 2>/dev/null || true)
  if [[ ${#defaults[@]} -ne 1 || ${defaults[0]:-} != "${root}/${source_rel}" ]]; then
    fail "exactly one module, ${source_rel}, must export DEFAULT_HOSTED_APP_ORIGIN; found ${#defaults[@]}" || status=1
  fi
  mapfile -t owners < <(rg -l --glob '*.ts' --glob '!**/tests/**' --glob '!**/node_modules/**' \
    '^export const HOSTED_APP_ORIGIN\b' "${root}/packages" 2>/dev/null || true)
  if [[ ${#owners[@]} -ne 1 || ${owners[0]:-} != "${root}/${source_rel}" ]]; then
    fail "exactly one module, ${source_rel}, must declare HOSTED_APP_ORIGIN (others re-export it); found ${#owners[@]}" || status=1
  fi
  local hits
  hits="$(literal_hits "${root}")"
  if [[ -n ${hits} ]]; then
    fail "a second literal of the production hosted app origin; import it from ${source_rel} instead:" || true
    printf '%s\n' "${hits}" | sed 's/^/  /' >&2
    status=1
  fi
  return "${status}"
}

self_test() {
  local tmp
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '${tmp}'" RETURN
  plant() { # name, then optional file=content pairs applied after the clean tree
    local dir="${tmp}/$1"
    mkdir -p "${dir}/$(dirname "${source_rel}")" "${dir}/packages/a/src" "${dir}/packages/a/tests" "${dir}/scripts" "${dir}/.github"
    {
      echo "export const DEFAULT_HOSTED_APP_ORIGIN = 'https://ferretry.pages.dev';"
      echo "export const HOSTED_APP_ORIGIN = DEFAULT_HOSTED_APP_ORIGIN;"
    } >"${dir}/${source_rel}"
    # A test and a doc may name the host: they describe the default, they do not decide it.
    echo "const x = 'https://ferretry.pages.dev';" >"${dir}/packages/a/tests/t.ts"
    # shellcheck disable=SC2016 # the backticks are literal text planted in a fixture
    echo 're-export: `import { HOSTED_APP_ORIGIN }`' >"${dir}/packages/a/src/a.ts"
    printf '%s\n' "${dir}"
  }
  expect_fail() { # name
    check_owner "${tmp}/$1" 2>/dev/null && {
      echo "❌ self-test: the gate did not catch: $1" >&2
      exit 2
    }
    return 0
  }

  local dir
  dir="$(plant clean)"
  check_owner "${dir}" 2>/dev/null || {
    echo "❌ self-test: a clean tree was refused" >&2
    check_owner "${dir}" >&2 || true
    exit 2
  }

  dir="$(plant second-literal)"
  echo "export const SOMEWHERE = 'https://ferretry.pages.dev';" >"${dir}/packages/a/src/b.ts"
  expect_fail second-literal
  dir="$(plant literal-in-script)"
  echo "curl https://ferretry.pages.dev/x" >"${dir}/scripts/x.sh"
  expect_fail literal-in-script
  dir="$(plant literal-in-workflow)"
  echo "url: https://ferretry.pages.dev" >"${dir}/.github/w.yaml"
  expect_fail literal-in-workflow
  dir="$(plant second-export)"
  echo "export const HOSTED_APP_ORIGIN = 'https://other.example';" >"${dir}/packages/a/src/c.ts"
  expect_fail second-export
  dir="$(plant second-default)"
  echo "export const DEFAULT_HOSTED_APP_ORIGIN = 'https://other.example';" >"${dir}/packages/a/src/d.ts"
  expect_fail second-default
  dir="$(plant no-source)"
  rm "${dir}/${source_rel}"
  expect_fail no-source
}

check_routes() {
  local script=scripts/ci/hosted-app-origin.sh status=0
  rg -q 'hosted-app-origin\.sh' packages/app/vite.config.ts || fail "packages/app/vite.config.ts must take the app's origin from ${script}" || status=1
  rg -q 'hosted-app-origin\.sh' packages/app/scripts/build-release.ts || fail "packages/app/scripts/build-release.ts must take its release key from ${script}" || status=1
  rg -q 'hosted-app-origin\.sh --defines' scripts/release/compile.sh || fail "scripts/release/compile.sh must take the daemon's defines from ${script}" || status=1
  # Captured as an assignment, never read through a process substitution: a failure inside `< <(...)` is ignored even
  # under `set -e`, and the daemon then compiled for the production app, silently.
  rg -q '^hosted_app_output="\$\(\./scripts/ci/hosted-app-origin\.sh --defines\)"$' scripts/release/compile.sh ||
    fail "scripts/release/compile.sh must capture ${script} --defines in an assignment, so its failure stops the compile" || status=1
  if rg -q '< <\(\./scripts/ci/hosted-app-origin\.sh' scripts/release/compile.sh; then
    fail "scripts/release/compile.sh reads ${script} through a process substitution, which hides its failure" || status=1
  fi
  local signing
  for signing in sign-pwa-release verify-pwa-release check-pwa-release; do
    rg -q 'hosted-app-origin\.sh' "scripts/ci/${signing}.sh" || fail "scripts/ci/${signing}.sh must take its key file from ${script}" || status=1
  done
  rg -q 'new URL\(HOSTED_APP_ORIGIN\)' packages/plugins/logins/manifest.ts ||
    fail "packages/plugins/logins/manifest.ts must derive its catalog host from HOSTED_APP_ORIGIN" || status=1

  # The script's behaviour, run for real.
  [[ "$(env -u FY_HOSTED_APP_ORIGIN "${script}")" == "$(env -u FY_HOSTED_APP_ORIGIN "${script}" --default)" ]] ||
    fail "${script} must print the production origin when no switch is set" || status=1
  [[ -z "$(env -u FY_HOSTED_APP_ORIGIN "${script}" --defines 2>/dev/null)" ]] ||
    fail "${script} must print no define for the production app" || status=1
  [[ "$(FY_HOSTED_APP_ORIGIN=https://preview.example "${script}")" == 'https://preview.example' ]] ||
    fail "${script} must print the named origin" || status=1
  FY_HOSTED_APP_ORIGIN=https://preview.example "${script}" --key-file | rg -q 'release-signing-key\.preview\.pub$' ||
    fail "${script} must name the preview key file for a named app" || status=1
  FY_HOSTED_APP_ORIGIN=https://preview.example "${script}" --defines 2>/dev/null | rg -q '^__FY_HOSTED_APP_ORIGIN__="https://preview\.example"$' ||
    fail "${script} must define the origin for a named app" || status=1
  if FY_HOSTED_APP_ORIGIN='https://preview.example/path' "${script}" >/dev/null 2>&1; then
    fail "${script} must refuse an origin with a path" || status=1
  fi

  # Only the preview workflow names another app.
  local workflow
  for workflow in .github/workflows/*.yaml; do
    if [[ ${workflow} == .github/workflows/pwa-pages-v5.yaml ]]; then
      rg -q '^  FY_HOSTED_APP_ORIGIN: https://ferretry-v5\.pages\.dev$' "${workflow}" ||
        fail "${workflow} must set FY_HOSTED_APP_ORIGIN to the preview origin at workflow level" || status=1
    elif rg -q 'FY_HOSTED_APP_ORIGIN' "${workflow}"; then
      fail "${workflow} must not set FY_HOSTED_APP_ORIGIN; only the preview workflow builds for another app" || status=1
    fi
  done
  return "${status}"
}

check_executable() {
  local status=0 mode _ _ path
  while read -r mode _ _ path; do
    [[ ${mode} == 100755 ]] || fail "${path} is committed ${mode}; callers run it by path, so it must be 100755 (git update-index --chmod=+x)" || status=1
  done < <(git ls-files -s -- 'scripts/*.sh')
  return "${status}"
}

main() {
  if [[ ${1:-} == --root ]]; then
    check_owner "$(cd "${2:?--root needs a directory}" && pwd)"
    return
  fi
  local root_dir
  root_dir="$(git rev-parse --show-toplevel)"
  cd "${root_dir}"
  self_test
  local status=0
  check_owner "${root_dir}" || status=1
  check_routes || status=1
  check_executable || status=1
  ((status == 0)) || exit 1
  echo "✅ the hosted app origin has one owner and every build route asks one script"
}

main "$@"
