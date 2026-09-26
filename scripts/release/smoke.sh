#!/usr/bin/env bash
set -euo pipefail

# Smoke-test one target's standalone binaries: run --version/--help and assert the help banner
# names the CLI, then drive the real first-session journey with the COMPILED CLI and daemon —
# `daemon start` through the supervisor (so the daemon gets the same minimal environment a user's
# does), one fleet account whose wrapper runs a fake harness, a session that must reach running,
# and a stop that must clean its pane up. No model is ever called: the harness is a shell script.
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

for executable in "${bin}" "${daemon_bin}"; do
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

# The fake harness: named like the real one so the daemon finds it the way it finds a real install.
cat >"${tools}/claude" <<'HARNESS'
#!/bin/sh
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
  rm -rf "${root}"
  exit "${code}"
}
trap cleanup EXIT

fail() {
  echo "❌ $*" >&2
  exit 1
}

# No default accounts (they would look for a login to copy) and no hosted relay dial.
cat >"${fy_home}/config/daemon.json" <<'CONFIG'
{ "fleet": { "prepareDefaults": false }, "relay": { "url": "ws://127.0.0.1:1", "enabled": false } }
CONFIG
"${name}" daemon adopt </dev/null >/dev/null

"${name}" daemon start </dev/null

account="claude-auto-smoke"
"${name}" fleet init >/dev/null
config="${fy_home}/fleet/config.yaml"
grep -q '^agents: \[\]$' "${config}" || fail "the starter fleet configuration has no empty agents list to fill"
awk -v account="${account}" '
  /^agents: \[\]$/ {
    print "agents:"
    print "  - name: smoke"
    print "    kind: claude"
    print "    auth: oauth"
    print "    routes:"
    print "      auto:"
    print "        id: 5b0c7f5e-6d0a-4f53-9d43-1c9a2c7e0b11"
    print "        wrapper: " account
    print "        home: " account
    print "        displayName: Claude (smoke, auto)"
    print "        defaultModel: claude-opus-5"
    print "        models:"
    print "          - claude-opus-5"
    next
  }
  { print }
' "${config}" >"${config}.next"
mv "${config}.next" "${config}"
"${name}" fleet apply

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
