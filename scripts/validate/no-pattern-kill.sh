#!/usr/bin/env bash
set -euo pipefail

# Fails when test code kills processes by PATTERN: `pkill` or `killall`, in any test tree.
#
# WHY. A suite is very often started by an agent from inside its own tmux pane, on the same machine
# as every other live agent. `pkill -f <x>` matches a REGULAR EXPRESSION against the command line of
# every process the user owns, and the live tmux server's command line is long — it keeps the argv of
# the client that started it, `-e` values and all. On 2026-10-29 every live agent on the dev box lost
# its pane within the same two seconds while agents were running the integration tier from inside
# their panes. A teardown kills what it started BY PID, or a tmux process whose argv names `-S` and
# its own temporary socket VERBATIM (`scripts/test/tmux-sweep.ts`,
# `packages/daemon/tests/integration/support/fleet-panes.ts`), and nothing else.
#
# WHAT IS MATCHED. In TypeScript and JavaScript, either name as a quoted argv element (`'pkill'`), the
# only way a test spawns it. In shell scripts, either name as a command word on a line that is not a
# comment. Prose that explains the rule names it in backticks and is not matched.
#
# FILE SET. `git grep` over tracked files in every test tree: `packages/*/tests`, `tests` and
# `scripts/test`. Release smoke and local benchmarks are not test fixtures and are out of scope.
#
# Exit codes follow the repo convention: 0 clean, 1 a violation, 2 a broken gate.

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

scopes=('packages/*/tests/**' 'tests/**' 'scripts/test/**')
quote="['\"\`]"
argv_pattern="${quote}(pkill|killall)${quote}"
shell_pattern='(^|[;&|(!{[:space:]])(pkill|killall)([[:space:]]|$)'

tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT

# One `git grep` per shape; exit 1 is "nothing found", anything above it is a broken gate.
search() {
  local out="$1" pattern="$2"
  shift 2
  local status=0
  git grep -n -E "${pattern}" -- "$@" >"${out}" 2>"${tmp_dir}/err" || status=$?
  case "${status}" in
  0 | 1) ;;
  *)
    echo "❌ git grep failed (exit ${status}) while searching test trees for pattern kills:" >&2
    cat "${tmp_dir}/err" >&2
    exit 2
    ;;
  esac
}

script_scopes=()
code_scopes=()
for scope in "${scopes[@]}"; do
  script_scopes+=("${scope}.sh" "${scope}.bash")
  code_scopes+=("${scope}.ts" "${scope}.tsx" "${scope}.js" "${scope}.mjs" "${scope}.cjs")
done

search "${tmp_dir}/argv" "${argv_pattern}" "${code_scopes[@]}"
search "${tmp_dir}/shell.raw" "${shell_pattern}" "${script_scopes[@]}"
# `path:line:text` — drop a hit whose text is a comment. A path holding a colon cannot hide a hit:
# it only ever turns a real command into a reported one, never the reverse.
awk -F ':' '{ text = $0; sub(/^[^:]*:[0-9]+:/, "", text); if (text !~ /^[[:space:]]*#/) print }' \
  "${tmp_dir}/shell.raw" >"${tmp_dir}/shell"

if [ -s "${tmp_dir}/argv" ] || [ -s "${tmp_dir}/shell" ]; then
  echo "❌ test code kills processes by pattern:" >&2
  cat "${tmp_dir}/argv" "${tmp_dir}/shell" | sed 's/^/  /' >&2
  cat >&2 <<'GUIDANCE'

`pkill` and `killall` match against EVERY process on the machine, and tests are run from inside live
agents whose tmux server one stray match ends. Kill what the test started by its pid, or a tmux
process whose argv holds `-S <its own temporary socket>` verbatim — see scripts/test/tmux-sweep.ts and
packages/daemon/tests/integration/support/fleet-panes.ts — after `assertDisposable` has confirmed the
path is inside a temporary directory (packages/daemon/tests/support/ambient-session.ts).
GUIDANCE
  exit 1
fi

echo "✅ no test tree kills processes by pattern (pkill/killall)"
