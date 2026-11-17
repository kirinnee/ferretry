#!/usr/bin/env bash
set -euo pipefail

# LIVE PROOF that every manifest instruction reaches a real ferret's launch prompt.
#
# It boots a scratch daemon (`fyd`, from source) on a home and a port of its own, signs in two fake-key
# logins (one Claude, one Codex: nothing is ever sent to a provider), starts eight real ferrets
# (Claude and Codex x auto and interactive x lead and helper), and reads the file each harness reads its
# instructions from, as the launch wrote it to disk: Claude's `CLAUDE.md` and Codex's `AGENTS.md`. Each
# section's first line (from its own `instructions/*.md`) must be there for the roles and harness its
# manifest `when` names, and absent for the rest.
#
#   scripts/test/live-instruction-proof.sh
#
# It touches nothing else: its own FY_HOME (a folder under $HOME, short enough for the daemon's socket),
# a random port, this ferret's FY_* identity stripped from every command it runs, and a tmux server on a
# socket inside that home. It never runs a `fy daemon` verb and never reads the person's own homes or
# daemons. The folder, the daemon and the tmux server are removed on exit.
#
# Needs `claude` and `codex` on PATH (a harness is located, never launched with a real account).

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

for harness_bin in claude codex bun tmux; do
  command -v "${harness_bin}" >/dev/null || {
    echo "❌ ${harness_bin} is not on PATH" >&2
    exit 1
  }
done

# 1. A scratch home and port; every FY_* of the calling session is dropped so nothing reaches another daemon.
for name in $(env | grep -o '^FY_[A-Z_0-9]*' || true); do unset "${name}"; done
unset TMUX
proof_home="$(mktemp -d "${HOME}/.fylp.XXXXXX")"
export FY_HOME="${proof_home}"
port=$((20000 + RANDOM % 20000))
log="${proof_home}.out"
daemon_pid=""

cleanup() {
  [ -n "${daemon_pid}" ] && kill "${daemon_pid}" 2>/dev/null || true
  tmux -S "${proof_home}/state/terminals/tmux.sock" kill-server 2>/dev/null || true
  sleep 1
  rm -rf "${proof_home}" "${proof_home}-worktrees" "${log}" || {
    sleep 3
    rm -rf "${proof_home}" "${proof_home}-worktrees" "${log}"
  }
}
trap cleanup EXIT

# 2. The daemon, from source, on that home.
bun packages/core/kernel/host/fyd.ts --port "${port}" >"${log}" 2>&1 &
daemon_pid=$!
for _ in $(seq 1 120); do
  grep -q 'ready' "${log}" && break
  kill -0 "${daemon_pid}" 2>/dev/null || {
    echo "❌ the scratch daemon exited" >&2
    cat "${log}" >&2
    exit 1
  }
  sleep 0.5
done
grep -q 'ready' "${log}" || {
  echo "❌ the scratch daemon never said ready" >&2
  exit 1
}

fy() { bun packages/cli/bin/fy.ts "$@"; }

# 3. Two logins with fake keys held in the scratch secret store, a profile each, a runtime each.
printf '%s' 'sk-ant-scratch-not-a-real-key' | fy secret set SCRATCH_ANTHROPIC >/dev/null
printf '%s' 'sk-scratch-not-a-real-key' | fy secret set SCRATCH_OPENAI >/dev/null
# shellcheck disable=SC2016 # the secret reference is for the daemon to resolve, not the shell
fy login add claude --preset anthropic-api-key --env 'ANTHROPIC_API_KEY=${secret:SCRATCH_ANTHROPIC}' --id claude-live --no-sign-in --yes >/dev/null
# shellcheck disable=SC2016
fy login add codex --preset openai-api-key --env 'OPENAI_API_KEY=${secret:SCRATCH_OPENAI}' --id codex-live --no-sign-in --yes >/dev/null
fy config confirm logins/claude-live.yaml >/dev/null
fy config confirm logins/codex-live.yaml >/dev/null
fy model-set add claude-live --model sonnet --default sonnet --yes >/dev/null
fy model-set add codex-live --model gpt-5.1-codex --default gpt-5.1-codex --yes >/dev/null
fy profile build claude-live --layer modelSets/claude-live --yes >/dev/null
fy profile build codex-live --layer modelSets/codex-live --yes >/dev/null
fy runtime add claude-live --login claude-live --profile claude-live --agent --yes >/dev/null
fy runtime add codex-live --login codex-live --profile codex-live --agent --yes >/dev/null
mkdir -p "${proof_home}/work"

# 4. What each section is, from its own file: its first line is the marker, `when` is read off the manifest.
board_marker="$(head -n1 packages/plugins/board/instructions/board.md)"
notify_marker="$(head -n1 packages/plugins/agenda/instructions/notify.md)"
asks_marker="$(head -n1 packages/core/asks/instructions/asks.md)"
rm_marker="$(head -n1 packages/plugins/claude-code/instructions/rm.md)"
jobs_marker=""
[ -f packages/plugins/terminals/instructions/jobs.md ] && jobs_marker="$(head -n1 packages/plugins/terminals/instructions/jobs.md)"

# 5. Eight real ferrets; each prompt file is read from disk once the launch has written it.
failures=0
excerpt=""
for harness in claude codex; do
  for mode in auto interactive; do
    lead="$(fy start 'say ok' --agent "${harness}-live" --mode "${mode}" --cwd "${proof_home}/work" --detach --json | jq -r .id)"
    helper="$(fy start 'say ok' --agent "${harness}-live" --mode "${mode}" --parent "${lead}" --cwd "${proof_home}/work" --detach --json | jq -r .id)"
    for who in lead helper; do
      id="${lead}"
      [ "${who}" = helper ] && id="${helper}"
      if [ "${harness}" = claude ]; then
        prompt="${proof_home}/state/claude-code/agent-homes/${id}/CLAUDE.md"
      else
        prompt="${proof_home}/state/codex/agent-homes/${id}/AGENTS.md"
      fi
      for _ in $(seq 1 120); do
        [ -s "${prompt}" ] && break
        sleep 0.5
      done
      [ -s "${prompt}" ] || {
        echo "❌ ${harness} ${mode} ${who}: no prompt file at ${prompt}" >&2
        failures=$((failures + 1))
        continue
      }
      # Expected: board, notify and asks for a lead on either harness; the rm rule for any Claude ferret; jobs for all.
      expect_board=no
      expect_rm=no
      [ "${who}" = lead ] && expect_board=yes
      [ "${harness}" = claude ] && expect_rm=yes
      line="${harness} ${mode} ${who}:"
      for section in board notify asks rm jobs; do
        case "${section}" in
        board) marker="${board_marker}" expected="${expect_board}" ;;
        notify) marker="${notify_marker}" expected="${expect_board}" ;;
        asks) marker="${asks_marker}" expected="${expect_board}" ;;
        rm) marker="${rm_marker}" expected="${expect_rm}" ;;
        jobs) marker="${jobs_marker}" expected=yes ;;
        esac
        # `jobs` is declared by another change; until it lands there is nothing to look for.
        if [ "${section}" = jobs ] && [ -z "${marker}" ]; then
          line="${line} jobs=n/a"
          continue
        fi
        found=no
        grep -qF -- "${marker}" "${prompt}" && found=yes
        line="${line} ${section}=${found}"
        if [ "${found}" != "${expected}" ]; then
          echo "❌ ${harness} ${mode} ${who} (${id}): ${section} is ${found}, expected ${expected}" >&2
          failures=$((failures + 1))
        fi
      done
      if [ "${harness}${mode}${who}" = claudeautolead ]; then excerpt="${prompt}"; fi
      echo "${line}  <- ${prompt#"${proof_home}"/}"
    done
  done
done

# 6. One excerpt, as the launch wrote it.
if [ -n "${excerpt}" ]; then
  echo "--- excerpt: one Claude lead's CLAUDE.md (each paragraph cut to 110 characters) ---"
  grep -v "^$" "${excerpt}" | cut -c1-110
fi

[ "${failures}" -eq 0 ] || {
  echo "❌ ${failures} section(s) not as expected" >&2
  exit 1
}
echo "✅ every manifest instruction reached the right ferrets' launch prompts"
