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
unit-*) ./scripts/ci/test.sh unit "${part#unit-}" ;;
*) echo "❌ Unknown quick part: ${part}" >&2 && exit 2 ;;
esac
