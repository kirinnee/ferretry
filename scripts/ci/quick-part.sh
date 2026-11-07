#!/usr/bin/env bash
set -euo pipefail

part=${1:?quick part required}
case "${part}" in
format)
  # treefmt --fail-on-change still rewrites files before reporting red. Give it a copy, so it
  # cannot change what gates/build/tests read or make pre-commit blame another part's writes.
  snapshot="$(mktemp -d)"
  trap 'rm -rf "${snapshot}"' EXIT
  git ls-files --cached --others --exclude-standard -z |
    while IFS= read -r -d '' file; do
      [[ -e ${file} || -L ${file} ]] || continue
      printf '%s\0' "${file}"
    done | tar --null -T - -cf - | tar -xf - -C "${snapshot}"
  cp -P .pre-commit-config.yaml "${snapshot}/.pre-commit-config.yaml"
  # The snapshot holds tracked and untracked files, not the ignored `node_modules`, and treefmt runs Biome
  # as `./node_modules/.bin/biome` from the tree root (nix/fmt.nix). Link the real binary in, so the copy
  # formats with the workspace's own Biome (the version `a-biome` lints with) and the workspace stays untouched.
  [[ -x node_modules/.bin/biome ]] || { echo "❌ node_modules/.bin/biome is missing: run setup.sh first" >&2 && exit 1; }
  mkdir -p "${snapshot}/node_modules/.bin"
  ln -s "$(realpath node_modules/.bin/biome)" "${snapshot}/node_modules/.bin/biome"
  git init --quiet "${snapshot}"
  git -C "${snapshot}" -c core.hooksPath=/dev/null add --all
  cd "${snapshot}"
  PRE_COMMIT_HOME="${snapshot}/pre-commit-cache"
  export PRE_COMMIT_HOME
  ./scripts/ci/pre-commit.sh format
  ;;
gates)
  # Pre-commit's two invocations do not install environments into a shared writable cache.
  PRE_COMMIT_HOME="$(mktemp -d)"
  export PRE_COMMIT_HOME
  trap 'rm -rf "${PRE_COMMIT_HOME}"' EXIT
  [[ ${CI:-} != true ]] && export FY_CI_GATE_PARALLEL=1
  ./scripts/ci/pre-commit.sh "${part}"
  ;;
build) ./scripts/ci/build-checks.sh ;;
# The repository tooling's own tests: the registry generator and the 5.0 checks' planted-violation tests
# (scripts/gen/tests, scripts/gen/today). They live outside packages/, so no unit group collects them.
scripts) ./scripts/test/swept.sh bun test ./scripts/ ;;
unit-*) ./scripts/ci/test.sh unit "${part#unit-}" ;;
*) echo "❌ Unknown quick part: ${part}" >&2 && exit 2 ;;
esac
