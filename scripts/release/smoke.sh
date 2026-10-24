#!/usr/bin/env bash
set -euo pipefail

# Smoke-test one target's standalone binaries: run --version/--help and assert the help banner
# names the CLI, then drive the real first-session journey with the COMPILED CLI and daemon —
# `daemon start` through the supervisor (so the daemon gets the same minimal environment a user's
# does) and importing nothing by itself, then `daemon import claude` importing this host's Claude Code
# into an agent runtime whose wrapper runs a fake harness, a session that must reach running, and a
# stop that must clean its pane up. No model is ever called: the harness is a shell script.
#
# Usage: smoke.sh <cli-binary> [daemon-binary]
# The daemon binary defaults to the CLI binary's sibling with the daemon's name swapped in.
bin="${1:?Usage: smoke.sh <cli-binary> [daemon-binary]}"

# Both names come from the packages' .bin keys — never assert on a hardcoded name.
bin_name() {
  local value
  value="$(jq -r '.bin | to_entries[0].key' "$1")"
  if [ -z "${value}" ] || [ "${value}" = "null" ]; then
    echo "❌ no .bin entry in $1" >&2
    exit 1
  fi
  printf '%s\n' "${value}"
}
name="$(bin_name packages/cli/package.json)"
daemon_name="$(bin_name packages/daemon/package.json)"

cli_base="$(basename "${bin}")"
daemon_bin="${2:-$(dirname "${bin}")/${daemon_name}${cli_base#"${name}"}}"
[ ! -f "${daemon_bin}" ] && echo "❌ no daemon binary at ${daemon_bin}" >&2 && exit 1
# The browser worker is the daemon package's second bin entry, compiled beside the daemon with the same
# target suffix. A release without it ships a daemon whose browser can never start.
worker_name="$(jq -r '.bin | keys_unsorted[1] // empty' packages/daemon/package.json)"
[ -z "${worker_name}" ] && echo "❌ packages/daemon/package.json declares no browser worker bin entry" >&2 && exit 1
worker_bin="$(dirname "${daemon_bin}")/${worker_name}${cli_base#"${name}"}"
[ ! -f "${worker_bin}" ] && echo "❌ no browser worker binary at ${worker_bin}" >&2 && exit 1

for executable in "${bin}" "${daemon_bin}" "${worker_bin}"; do
  chmod +x "${executable}"
  xattr -d com.apple.quarantine "${executable}" 2>/dev/null || true # mac-only; harmless elsewhere
done

"${bin}" --version
help="$("${bin}" --help)"
printf '%s\n' "${help}"

! grep -q 'Usage:' <<<"${help}" && echo "❌ --help is missing its usage banner" >&2 && exit 1
! grep -q "${name}" <<<"${help}" && echo "❌ --help does not name '${name}'" >&2 && exit 1

echo "✅ help ok: ${bin}"

# ── The session journey ───────────────────────────────────────────────────────────────────────
tmux_bin="$(command -v tmux || true)"
[ -z "${tmux_bin}" ] && echo "❌ tmux is required for the session smoke" >&2 && exit 1

# A short root: the daemon's tmux socket lives under it, and a Unix socket path has a ~104-byte cap.
root="$(mktemp -d /tmp/fy-smoke.XXXXXX)"
tools="${root}/bin"
mkdir -p "${tools}" "${root}/work"
cp "${bin}" "${tools}/${name}"
cp "${daemon_bin}" "${tools}/${daemon_name}"
# Installed beside the daemon under its bin name, exactly as the archive, cask and packages lay it out.
cp "${worker_bin}" "${tools}/${worker_name}"

# The fake harness: named like the real one so the daemon finds it the way it finds a real install.
cat >"${tools}/claude" <<'HARNESS'
#!/bin/sh
# Asked for its usage (the wrapper asks what flags it takes), it answers and exits, like the real one.
[ "${1:-}" = --help ] && { echo "Usage: claude [options]"; exit 0; }
# A ready harness shows a prompt line with the cursor left on it; that is what the daemon waits for.
# Each line it reads is a turn: it answers and draws a fresh, empty prompt, as a real harness would.
printf 'smoke harness started\n> '
while IFS= read -r _turn; do
  printf 'working on it\n> '
done
exec sleep 600
HARNESS
chmod +x "${tools}/claude"

# An isolated user: nothing here reads or writes the runner's real home. PATH is minimal on
# purpose, and no locale is set — the daemon must work in the environment a service manager gives it.
fy_home="${root}/h/.fy"
mkdir -p "${fy_home}/config"
export HOME="${root}/h"
export FY_HOME="${fy_home}"
tmux_dir="$(dirname "${tmux_bin}")"
export PATH="${tools}:${tmux_dir}:/usr/bin:/bin:/usr/sbin:/sbin"
unset LANG LC_ALL LC_CTYPE FY_DAEMON_BIN FY_CLAUDE_BIN FY_CODEX_BIN FY_HARNESS_PATH || true

cleanup() {
  local code=$?
  if [ "${code}" -ne 0 ]; then
    echo "── ${daemon_name} log ──" >&2
    "${name}" daemon logs >&2 2>&1 || true
    [ -n "${session:-}" ] && "${name}" status "${session}" >&2 2>&1 || true
  fi
  "${name}" daemon stop >/dev/null 2>&1 || true
  "${tmux_bin}" -S "${fy_home}/tmux.sock" kill-server >/dev/null 2>&1 || true
  # `browser stop` answers once the daemon has released the browser, not once Chrome has exited: a macOS
  # Chrome and its helpers go on writing into the profile under this root for a few seconds, and an
  # `rm -rf` racing them fails with "Permission denied" after the smoke already passed. Wait for every
  # process still rooted here to go, then remove the tree.
  pkill -TERM -f "${root}" >/dev/null 2>&1 || true
  for _ in $(seq 1 20); do
    pgrep -f "${root}" >/dev/null 2>&1 || break
    sleep 0.5
  done
  pkill -KILL -f "${root}" >/dev/null 2>&1 || true
  chmod -R u+rwx "${root}" >/dev/null 2>&1 || true
  rm -rf "${root}" || echo "⚠️  could not remove ${root}; the smoke result stands" >&2
  exit "${code}"
}
trap cleanup EXIT

fail() {
  echo "❌ $*" >&2
  exit 1
}

# No hosted relay dial. Starting the daemon imports nothing — a fresh machine is "not set up" until
# somebody chooses — so the smoke chooses explicitly, the way a script does: `daemon import claude`
# imports the fake `claude` on PATH from this isolated HOME. There is no Codex, so only Claude is asked.
cat >"${fy_home}/config/daemon.json" <<'CONFIG'
{ "relay": { "url": "ws://127.0.0.1:1", "enabled": false } }
CONFIG
# ── The WebRTC engine ─────────────────────────────────────────────────────────────────────────
# The daemon embeds a native WebRTC library per target (scripts/release/compile-executable.ts). A
# compiled daemon that cannot load the right one still starts — devices fall back to the relay — so
# nothing else in this smoke would notice. `--check` runs the engine's self-test: two loopback peers
# in the compiled binary open a data channel and echo one message. Its exit code is about other
# things, so only the line is judged.
check_out="$("${tools}/${daemon_name}" --check </dev/null 2>&1 || true)"
webrtc_line="$(grep '^webrtc ' <<<"${check_out}" || true)"
grep -q 'engine ready' <<<"${webrtc_line}" || fail "the compiled WebRTC engine did not pass its self-test: ${webrtc_line:-no webrtc line}"
echo "✅ ${webrtc_line}"
# ── The worker threads ────────────────────────────────────────────────────────────────────────
# Every `bin/*.worker.ts` is embedded beside the daemon's entry (compile-executable.ts) and started by
# its URL inside the binary. A binary that did not embed one still starts, so nothing else here would
# notice until somebody unlocked a PDF; `--check` starts each worker for real on this target.
workers_line="$(grep '^workers ' <<<"${check_out}" || true)"
grep -q ' ready$' <<<"${workers_line}" || fail "a worker thread did not start in the compiled daemon: ${workers_line:-no workers line}"
# The housekeeping worker reads every login's store: a release that dropped it would quietly run those
# reads on the main thread, so it is named here rather than only counted among the ready.
grep -q 'housekeeping' <<<"${workers_line}" || fail "the compiled daemon did not start its housekeeping worker: ${workers_line:-no workers line}"
echo "✅ ${workers_line}"

"${name}" daemon adopt </dev/null >/dev/null

"${name}" daemon start </dev/null

# Nothing was imported by the start itself.
[ "$("${name}" runtimes --json | jq '.runtimes | length')" = "0" ] ||
  fail "starting the daemon set the machine up by itself: $("${name}" runtimes 2>&1)"
echo "✅ the start imported nothing"

"${name}" daemon import claude --name claude-auto-smoke </dev/null || fail "daemon import claude refused"

# The agent runtime the import made (imported runtimes are agents), by the wrapper name `start` takes.
account="$("${name}" runtimes --json | jq -r '[.runtimes[] | select(.agent and .harness == "claude")][0].wrapper // empty')"
[ -n "${account}" ] || fail "the import made no Claude agent runtime: $("${name}" runtimes 2>&1)"
echo "✅ the import made ${account}"

cd "${root}/work"
started="$("${name}" start --agent "${account}" --name "Smoke Session" --json "say hello")" || fail "start refused: ${started:-no output}"
session="$(jq -r '.config.id' <<<"${started}")"
[ -z "${session}" ] || [ "${session}" = "null" ] && fail "start printed no session id: ${started}"

session_status() {
  "${name}" status "${session}" --json | jq -r '.state.status'
}

status=""
for _ in $(seq 1 60); do
  status="$(session_status)"
  [ "${status}" = "running" ] && break
  case "${status}" in failed | stopped | completed | stalled) break ;; esac
  sleep 1
done
[ "${status}" = "running" ] || fail "session ${session} never reached running (last status: ${status:-none})"
echo "✅ session ${session} is running"

# ── The browser worker ────────────────────────────────────────────────────────────────────────
# The compiled worker must START: with no endpoint it reports its one fatal line and exits 2. That much
# holds on every runner, including one with no browser installed.
worker_out="$("${tools}/${worker_name}" </dev/null 2>/dev/null || true)"
grep -q '"type":"fatal"' <<<"${worker_out}" || fail "the browser worker did not start: ${worker_out:-no output}"
echo "✅ ${worker_name} starts"

# Where the runner has a Chrome, the DAEMON must find the worker beside itself and drive a real browser
# through it — a screenshot is only produced once the worker has attached over CDP. A Linux runner has
# no display, so this also proves the headless fallback.
chrome_found=""
for candidate in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" /usr/bin/google-chrome \
  /usr/bin/google-chrome-stable /usr/bin/chromium /usr/bin/chromium-browser /snap/bin/chromium; do
  [ -x "${candidate}" ] && chrome_found="${candidate}" && break
done
if [ -n "${chrome_found}" ]; then
  # A hosted runner's first Chrome start is occasionally slow or wedged. A failed open reaps that Chrome and
  # releases the profile, so a bounded retry is safe; every attempt and its error is printed, and the last
  # error is what fails the smoke.
  opened=""
  open_error=""
  for attempt in 1 2 3; do
    if open_error="$("${name}" browser --session "${session}" open about:blank </dev/null 2>&1)"; then
      opened="yes"
      break
    fi
    echo "⚠️  browser open attempt ${attempt}/3 failed: ${open_error}"
    [ "${attempt}" = "3" ] || sleep 2
  done
  [ -n "${opened}" ] ||
    fail "the daemon could not open a browser through ${worker_name} (Chrome: ${chrome_found}) after 3 attempts: ${open_error}"
  "${name}" browser --session "${session}" screenshot "${root}/browser.png" </dev/null ||
    fail "the browser opened but produced no screenshot"
  [ -s "${root}/browser.png" ] || fail "the browser screenshot is empty"
  "${name}" browser --session "${session}" stop </dev/null || fail "the browser did not stop"
  echo "✅ the daemon drove ${chrome_found} through ${worker_name}"
else
  echo "⚠️  no Chrome on this runner: proved ${worker_name} starts, not that it drives a browser"
fi

"${name}" stop orphan "${session}" --yes --reason "smoke test"
for _ in $(seq 1 30); do
  status="$(session_status)"
  [ "${status}" = "stopped" ] && break
  sleep 1
done
[ "${status}" = "stopped" ] || fail "session ${session} did not stop (last status: ${status:-none})"
if "${tmux_bin}" -S "${fy_home}/tmux.sock" list-panes -a -F '#{session_name}' 2>/dev/null | grep -q .; then
  fail "a tmux pane outlived the stopped session"
fi
echo "✅ session ${session} stopped and left no pane"

"${name}" daemon stop
echo "✅ smoke ok: ${bin}"
