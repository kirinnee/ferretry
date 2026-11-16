#!/usr/bin/env bash
set -euo pipefail

part=${1:?quick part required}

# The scripts tests Static runs instead of Quick (config/static-tests.txt), and every scripts test Bun would collect.
# FY_QUICK_PART_LIST=1 prints a part's files instead of running them (scripts/ci/static-tests.test.ts).
static_tests() {
  local listed=()
  mapfile -t listed < <(grep -v -e '^#' -e '^[[:space:]]*$' config/static-tests.txt)
  [[ ${#listed[@]} -gt 0 ]] || { echo "❌ config/static-tests.txt lists no test" >&2 && return 1; }
  for file in "${listed[@]}"; do
    [[ -f ${file} ]] || { echo "❌ config/static-tests.txt names ${file}, which does not exist" >&2 && return 1; }
  done
  printf '%s\n' "${listed[@]}"
}
scripts_tests() {
  find scripts -path '*/node_modules' -prune -o -type f \( -name '*.test.*' -o -name '*_test.*' -o -name '*.spec.*' -o -name '*_spec.*' \) -print | sort
}

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
scripts)
  # The JUnit report is where `bun scripts/gen/check.ts guarantees` reads whether a guarantee test in scripts/ passed.
  # Every scripts test except the whole-tree checkers Static runs (`guards`). Both lists are read status-checked:
  # a failed find or a bad static list fails the part, never shrinks it.
  static_list="$(mktemp)" && all_list="$(mktemp)"
  trap 'rm -f "${static_list}" "${all_list}"' EXIT
  static_tests >"${static_list}"
  scripts_tests >"${all_list}"
  mapfile -t files < <(grep -vxF -f "${static_list}" "${all_list}" | sed 's|^|./|')
  [[ ${#files[@]} -gt 0 ]] || { echo "❌ no scripts test left to run" >&2 && exit 1; }
  [[ ${FY_QUICK_PART_LIST:-} == 1 ]] && printf '%s\n' "${files[@]#./}" && exit 0
  mkdir -p coverage/scripts
  ./scripts/test/swept.sh bun test "${files[@]}" --reporter=junit --reporter-outfile=coverage/scripts/junit.xml
  ;;
# The whole-tree checkers among the scripts tests (config/static-tests.txt), run by Static Checks: they open the real
# repository's TypeScript program, which starved beside the six unit groups in Quick.
guards)
  static_list="$(mktemp)"
  trap 'rm -f "${static_list}"' EXIT
  static_tests >"${static_list}"
  mapfile -t files < <(sed 's|^|./|' "${static_list}")
  [[ ${FY_QUICK_PART_LIST:-} == 1 ]] && printf '%s\n' "${files[@]#./}" && exit 0
  mkdir -p coverage/static-guards
  ./scripts/test/swept.sh bun test "${files[@]}" --reporter=junit --reporter-outfile=coverage/static-guards/junit.xml
  ;;
unit-*) ./scripts/ci/test.sh unit "${part#unit-}" ;;
*) echo "❌ Unknown quick part: ${part}" >&2 && exit 2 ;;
esac
