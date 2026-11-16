#!/usr/bin/env bash
set -euo pipefail

# Fails when the one-time v4 -> v5 converter leaks into the product.
#
# WHY. The owner wants every v4 home carried into v5 with all data and sessions kept, and ALSO wants no backward
# compatibility in the product (A452, addendum 2 of 2026-11-07). Both hold only while the converter at
# `migration/v4-to-v5/` stays outside: not a workspace member, never imported by a package, never bundled, compiled
# or released. It is deleted from the repo once every machine is on v5 (docs/migration/v4-to-v5-prompt.md); until
# then this gate keeps it a tool beside the product rather than a part of it.
#
# WHAT IS CHECKED.
#   1. No root `package.json` `workspaces` glob, and no root `tsconfig.json` `include`, reaches `migration/`.
#   2. No tracked or untracked file outside the allowlist names the tool (`migration/v4-to-v5` or its package name
#      `ferretry-v4-to-v5`). The allowlist is the tool itself, docs, this gate, the pre-commit wiring and the one CI
#      workflow that may run the tool's own tests. A package import, a release or compile script, a Taskfile entry or
#      a cask naming it is therefore a violation.
#   3. The tool's own `package.json` is `private: true` and declares no `bin`.
#
# SELF-TEST. Every run first plants each violation in a throwaway repository and requires the gate to catch it, then
# requires a clean throwaway repository to pass, then checks this repository. `--root <dir>` checks another
# checkout and skips the self-test (the self-test uses it).
#
# Exit codes follow the repo convention: 0 clean, 1 a violation, 2 a broken gate.

tool_dir="migration/v4-to-v5"
tool_name="ferretry-v4-to-v5"
# The tool's folder, not a sibling name: `docs/migration/v4-to-v5-prompt.md` (the kernel's CARRY_OVER_PROMPT) is
# allowed anywhere.
mention_pattern="migration/v4-to-v5([^-]|$)|${tool_name}"
# Paths allowed to name the tool (git pathspecs, excluded from the search).
allowed=(
  ":(exclude)${tool_dir}/**"
  ":(exclude)docs/**"
  ":(exclude)scripts/validate/migration-isolated.sh"
  ":(exclude)nix/pre-commit.nix"
  ":(exclude).github/workflows/migration-v4-to-v5.yaml"
)

check() {
  local root="$1" status=0
  cd "${root}"

  if [ -f package.json ]; then
    local globs
    if ! globs="$(jq -r '(.workspaces // []) | if type == "object" then .packages // [] else . end | .[]' package.json 2>/dev/null)"; then
      echo "❌ cannot read the root package.json workspaces" >&2
      return 2
    fi
    while IFS= read -r glob; do
      [ -z "${glob}" ] && continue
      # A bash pattern match is wider than a workspace glob (`*` crosses `/`), so it errs towards a violation.
      # shellcheck disable=SC2053
      if [[ ${tool_dir} == ${glob} || ${glob} == migration* || ${glob} == ./migration* ]]; then
        echo "❌ root package.json workspace glob '${glob}' reaches ${tool_dir}" >&2
        status=1
      fi
    done <<<"${globs}"
  fi
  if [ -f tsconfig.json ]; then
    local includes
    # tsconfig allows comments; strip whole-line ones before jq.
    if includes="$(sed -E 's#^[[:space:]]*//.*$##' tsconfig.json | jq -r '(.include // [])[]' 2>/dev/null)"; then
      while IFS= read -r include; do
        [ -z "${include}" ] && continue
        # shellcheck disable=SC2053
        if [[ ${include} == migration* || ${include} == ./migration* || ${tool_dir} == ${include} ]]; then
          echo "❌ root tsconfig.json include '${include}' reaches ${tool_dir}" >&2
          status=1
        fi
      done <<<"${includes}"
    fi
  fi

  local hits git_status=0
  hits="$(git grep --untracked -n -I -E "${mention_pattern}" -- . "${allowed[@]}" 2>/dev/null)" || git_status=$?
  case "${git_status}" in
  0)
    echo "❌ the v4 -> v5 converter is named outside its own folder and docs:" >&2
    printf '%s\n' "${hits}" | sed 's/^/  /' >&2
    status=1
    ;;
  1) ;;
  *)
    echo "❌ git grep failed (exit ${git_status}) while searching for the converter" >&2
    return 2
    ;;
  esac

  if [ -f "${tool_dir}/package.json" ]; then
    if [ "$(jq -r '.private' "${tool_dir}/package.json")" != "true" ]; then
      echo "❌ ${tool_dir}/package.json must be private: true" >&2
      status=1
    fi
    if [ "$(jq -r 'has("bin")' "${tool_dir}/package.json")" != "false" ]; then
      echo "❌ ${tool_dir}/package.json must not declare a bin" >&2
      status=1
    fi
  fi
  return "${status}"
}

self_test() {
  local script tmp_dir
  script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
  tmp_dir="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '${tmp_dir}'" RETURN

  plant() {
    local name="$1" dir="${tmp_dir}/$1"
    mkdir -p "${dir}/${tool_dir}" "${dir}/packages/a/src" "${dir}/scripts/release" "${dir}/docs"
    git -C "${dir}" init -q
    # A throwaway repository must be its OWN: pre-commit exports GIT_DIR and friends, and a `git init` under them
    # re-initialises the real repository instead (it once wrote `core.bare = true` into the shared config).
    if [ "$(git -C "${dir}" rev-parse --absolute-git-dir)" != "${dir}/.git" ]; then
      echo "❌ self-test: the throwaway repository is not its own (${dir}); refusing to go on" >&2
      exit 2
    fi
    printf '{ "name": "r", "workspaces": ["packages/*", "packages/core/*"] }\n' >"${dir}/package.json"
    printf '{ "include": ["packages/a"] }\n' >"${dir}/tsconfig.json"
    printf '{ "name": "%s", "private": true }\n' "${tool_name}" >"${dir}/${tool_dir}/package.json"
    printf 'export const PROMPT = "docs/migration/v4-to-v5-prompt.md";\n' >"${dir}/packages/a/src/a.ts"
    printf 'Run bun %s/src/main.ts\n' "${tool_dir}" >"${dir}/docs/how.md"
    printf '#!/usr/bin/env bash\necho compile\n' >"${dir}/scripts/release/compile.sh"
    case "${name}" in
    clean) ;;
    workspace) printf '{ "name": "r", "workspaces": ["packages/*", "migration/*"] }\n' >"${dir}/package.json" ;;
    tsconfig) printf '{ "include": ["packages/a", "migration/v4-to-v5/src"] }\n' >"${dir}/tsconfig.json" ;;
    import) printf "import { convert } from '../../../%s/src/convert.ts';\n" "${tool_dir}" >"${dir}/packages/a/src/a.ts" ;;
    dependency) printf '{ "name": "a", "dependencies": { "%s": "file:../../%s" } }\n' "${tool_name}" "${tool_dir}" >"${dir}/packages/a/package.json" ;;
    release) printf '#!/usr/bin/env bash\ncp -r %s dist/\n' "${tool_dir}" >"${dir}/scripts/release/compile.sh" ;;
    public) printf '{ "name": "%s", "private": false }\n' "${tool_name}" >"${dir}/${tool_dir}/package.json" ;;
    bin) printf '{ "name": "%s", "private": true, "bin": { "x": "src/main.ts" } }\n' "${tool_name}" >"${dir}/${tool_dir}/package.json" ;;
    esac
    printf '%s\n' "${dir}"
  }

  local planted status
  for planted in clean workspace tsconfig import dependency release public bin; do
    status=0
    bash "${script}" --root "$(plant "${planted}")" >/dev/null 2>&1 || status=$?
    if [ "${planted}" = clean ] && [ "${status}" -ne 0 ]; then
      echo "❌ self-test: a clean repository failed the gate (exit ${status})" >&2
      return 2
    fi
    if [ "${planted}" != clean ] && [ "${status}" -ne 1 ]; then
      echo "❌ self-test: a planted '${planted}' violation was not caught (exit ${status})" >&2
      return 2
    fi
  done
}

# Never inherit the caller's repository: a hook runs with GIT_DIR, GIT_INDEX_FILE, GIT_WORK_TREE … set for the
# repository being committed to, and every git call below must address only the tree it names.
local_git_vars="$(git rev-parse --local-env-vars)"
# shellcheck disable=SC2086
unset ${local_git_vars}

if [ "${1:-}" = "--root" ]; then
  [ -z "${2:-}" ] && echo "usage: $0 [--root <dir>]" >&2 && exit 2
  check "$2"
  exit $?
fi

self_test
root_dir="$(git rev-parse --show-toplevel)"
status=0
check "${root_dir}" || status=$?
[ "${status}" -ne 0 ] && exit "${status}"
echo "✅ the v4 -> v5 converter stays outside the product (7 planted violations caught, a clean tree passes, this repository is clean)"
