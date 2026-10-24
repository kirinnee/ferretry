#!/usr/bin/env bash
set -euo pipefail

# Run one test command inside its own temporary root, and fail it if it leaves a tmux server behind.
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
    rm -rf -- "${run_tmp}"
  fi
  exit "${status}"
}

run_tmp="$(mktemp -d "${base%/}/fyt.XXXXXX")"
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

export TMPDIR="${run_tmp}"
export FERRETRY_TEST=1
"$@"
