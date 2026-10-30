#!/usr/bin/env bash
set -euo pipefail

# Run one test command inside its own temporary root and a sealed environment, and fail it if it leaves
# a tmux server, or any other process, behind.
#
# WHY A ROOT OF ITS OWN. Every suite builds its tmux sockets under the temporary directory, and many
# runs share one machine, so "a tmux server under /tmp" says nothing about whose it is. Pointing
# TMPDIR at a directory this run alone owns makes every socket the run creates name that directory,
# and `scripts/test/tmux-sweep.ts` can then kill exactly this run's leftovers — by process, because a
# leaked server has usually outlived its socket file — without touching a sibling run's live journey.
#
# WHY IT FAILS THE RUN. A server that survives its test keeps whatever its panes run alive for days;
# on 2026-10-19 the dev box held 92 of them and three ran the owner's real Claude Code. A sweep that
# only cleaned up would hide the fixture that leaked, so a leak is a red run that names the socket.
#
# SEALED. Nothing about the machine or the session that started the run reaches it. An agent's pane
# carries the live daemon's FY_HOME, a TMUX naming the server every agent runs under, and the rest of
# its session's FY_* switches; a developer's shell carries their own FY_URL or FY_CLAUDE_BIN; and HOME
# holds the owner's real ~/.claude, ~/.codex and state home. Every FY_* this repository's own scripts
# do not set for a test run is removed, TMUX with it, and HOME becomes a directory of the run's own.
# What the inherited ones named is recorded first in FY_TEST_PROTECTED_PATHS, so a teardown still
# refuses to touch it (packages/daemon/tests/support/ambient-session.ts).
#
# A PROCESS LEFT RUNNING FAILS THE RUN TOO. Every child a test starts inherits this run's TMPDIR, so
# `scripts/test/leak-sweep.ts` finds — by that, not by parentage — any process still running when the
# command ends, names it, kills it, and fails the run: a fixture that forgot a daemon or a Chrome is a
# red run, not a runner that waits on it.
#
# FERRETRY_TEST=1 turns on the daemon's launch guard (packages/daemon/src/lib/tmux/harness-guard.ts)
# for every daemon the command boots: a session whose harness resolves to a real install fails.
#
# Usage: scripts/test/swept.sh <command> [args...]

root_dir="$(git rev-parse --show-toplevel)"

# /tmp, not $TMPDIR, whenever it is writable. Suites were written against the paths they got, and some
# are length-sensitive: a socket path has a 104-108 byte sun_path limit, and a turn instruction that
# names a deeper file crosses the send-vs-paste threshold. `nix develop` on CI and macOS both set a
# TMPDIR far longer than /tmp, so a run root under it broke a lifecycle test that passed before.
base="/tmp"
[ ! -w "${base}" ] && base="${TMPDIR:-/tmp}"
run_tmp=""

cleanup() {
  status=$?
  trap - EXIT INT TERM
  set +e
  if [ -n "${run_tmp}" ] && [ -d "${run_tmp}" ]; then
    # The command's own status goes along: a test process that died on a signal (a Bun crash) never ran
    # its fixtures' teardown, so its leftovers are swept and named as the crash's, not as a leak.
    bun "${root_dir}/scripts/test/tmux-sweep.ts" --fail-on-leak --exit-status "${status}" "${run_tmp}" ||
      { [ "${status}" -eq 0 ] && status=1; }
    bun "${root_dir}/scripts/test/leak-sweep.ts" --fail-on-leak --exit-status "${status}" "${run_tmp}" ||
      { [ "${status}" -eq 0 ] && status=1; }
    rm -rf -- "${run_tmp}"
  fi
  exit "${status}"
}

run_tmp="$(mktemp -d "${base%/}/fyt.XXXXXX")"
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# The homes and sockets the inherited environment names, recorded before it is removed.
product="$(jq -r '.name' "${root_dir}/package.json")"
protected="${FY_TEST_PROTECTED_PATHS:-}"
tmux_socket="${TMUX:-}"
for path in "${FY_HOME:-}" "${tmux_socket%%,*}" "${HOME:-}/.${product}"; do
  if [[ ${path} == /* ]]; then protected="${protected:+${protected}:}${path}"; fi
done
export FY_TEST_PROTECTED_PATHS="${protected}"

# The FY_* a test run may inherit: the offline switches scripts/ci/test.sh sets, and the knobs this
# repository's own CI and test scripts pass down. Anything else is somebody's session or machine.
for name in $(compgen -e); do
  case "${name}" in
  FY_MODEL_CATALOG | FY_LOCAL_MODELS | FY_RELAY_DIRECTORY_ORIGIN | FY_UPDATE_CHECK) ;;
  FY_TEST_* | FY_UNIT_GUARD* | FY_CONTRACT_* | FY_REALWORLD_* | FY_HARNESS_CONTRACT | FY_RENDER_SAFARI_*) ;;
  FY_* | TMUX | TMUX_PANE) unset "${name}" ;;
  esac
done
# The real home stays known to the guards, which protect its state home whatever HOME now says.
export FY_TEST_REAL_HOME="${FY_TEST_REAL_HOME:-${HOME}}"
export HOME="${run_tmp}/home"
mkdir -p "${HOME}"

export TMPDIR="${run_tmp}"
export FERRETRY_TEST=1
"$@"
