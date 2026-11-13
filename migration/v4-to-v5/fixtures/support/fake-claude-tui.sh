#!/bin/sh
# A stand-in for the `claude` TUI, for the full-product E2E journeys. Never a real account.
#
# What a session needs from a harness, and nothing more:
#   - a prompt the daemon recognises as ready (`> ` at column 0, redrawn after every line, or the
#     turn "lands but stays in the composer" — see scripts/release/smoke.sh);
#   - a Claude JSONL transcript at the path the daemon recorded for this launch:
#     <CLAUDE_CONFIG_DIR>/projects/<cwd with every non-alphanumeric as '-'>/<--session-id>.jsonl
#     so the app has a real transcript to render, with a reply this run can recognise.
#
# `--version` answers like the real CLI so the setup scan can call it installed.
set -u

case "${1:-}" in
--version | -v)
  echo "2.1.0 (Claude Code)"
  exit 0
  ;;
esac

# `claude auth login --claudeai`, as claude-code 2.1.281 prints it on Linux: the link wrapped in an
# OSC 8 hyperlink, then a prompt with no newline. A code shaped `<code>#<state>` writes a fake login
# where the real CLI writes it — `.credentials.json` in the config directory — and anything else gets
# the real CLI's refusal and keeps waiting.
if [ "${1:-}" = "auth" ] && [ "${2:-}" = "login" ]; then
  [ -n "${FY_E2E_FAKE_CLAUDE_LOG:-}" ] && printf '%s\t-\t%s\n' "$(pwd)" "$*" >>"${FY_E2E_FAKE_CLAUDE_LOG}"
  link='https://claude.com/cai/oauth/authorize?code=true&client_id=fake-e2e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=fake&code_challenge_method=S256&state=fake-e2e-state'
  printf 'Opening browser to sign in\342\200\246\n'
  printf 'If the browser didn'"'"'t open, visit: \033]8;;%s\007%s\033]8;;\007\n' "${link}" "${link}"
  printf 'Paste code here if prompted > '
  while IFS= read -r pasted; do
    case "${pasted}" in
    ?*'#'?*)
      config="${CLAUDE_CONFIG_DIR:-${HOME}/.claude}"
      mkdir -p "${config}"
      expires=$((($(date +%s) + 3600) * 1000))
      printf '{"claudeAiOauth":{"accessToken":"fake-e2e-access","refreshToken":"fake-e2e-refresh","expiresAt":%s,"scopes":["user:inference"]}}' \
        "${expires}" >"${config}/.credentials.json"
      # v4 signs a login in inside `<credential>/sign-in` and then looks for the file one folder up: the real CLI's own
      # tidy-up. Only a run in a folder called sign-in (a daemon-driven sign-in of a `store: ferretry` login) copies it.
      case "${config}" in
      */sign-in) cp "${config}/.credentials.json" "${config%/sign-in}/.credentials.json" && chmod 600 "${config%/sign-in}/.credentials.json" ;;
      esac
      printf 'Login successful.\n'
      exit 0
      ;;
    *) printf 'Invalid code. Please make sure the full code was copied.\n' >&2 ;;
    esac
  done
  exit 1
fi

sid=""
prev=""
for arg in "$@"; do
  [ "${prev}" = "--session-id" ] && sid="${arg}"
  # `claude --resume <id>` carries on the same conversation, as the real CLI does.
  [ "${prev}" = "--resume" ] && sid="${arg}"
  prev="${arg}"
done
[ -n "${sid}" ] || sid="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || date +%s)"

config="${CLAUDE_CONFIG_DIR:-${HOME}/.claude}"
project="$(pwd | sed 's/[^A-Za-z0-9]/-/g')"
dir="${config}/projects/${project}"
mkdir -p "${dir}"
transcript="${dir}/${sid}.jsonl"
[ -n "${FY_E2E_FAKE_CLAUDE_LOG:-}" ] && printf '%s\t%s\t%s\n' "$(pwd)" "${transcript}" "$*" >>"${FY_E2E_FAKE_CLAUDE_LOG}"

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

record() {
  # $1 role, $2 uuid, $3 parent, $4 text
  at="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  parent='null'
  [ -n "$3" ] && parent="\"$3\""
  printf '{"type":"%s","uuid":"%s","parentUuid":%s,"sessionId":"%s","timestamp":"%s","message":{"role":"%s","content":[{"type":"text","text":"%s"}]}}\n' \
    "$1" "$2" "${parent}" "${sid}" "${at}" "$1" "$(json_escape "$4")" >>"${transcript}"
}

# A journey that needs a richer reply than the marker — a hypermedia message, say — drops it in the
# session's workspace as `.fy-e2e-fake-reply.md`, and the next reply is that file, JSON-escaped with its
# line breaks kept. Files under `.fy-e2e-fake-media/` are copied into `$FY_MEDIA_DIR` first, the
# session's media folder, exactly where a real agent puts media it made to show the person.
reply_file="$(pwd)/.fy-e2e-fake-reply.md"
media_source="$(pwd)/.fy-e2e-fake-media"

printf 'Fake Claude ready\n> '
n=0
last=""
while IFS= read -r line; do
  n=$((n + 1))
  # A `--rich` v4 home (FY_FIXTURE_RICH set by the builder; never set for the default fixture): two marked lines are the
  # builder's own stage directions, not something a person said, so they are played and NOT recorded as a user turn.
  #   FIXTURE-REC <script.json>   one scripted exchange (see fake-claude-rich.ts)
  #   FIXTURE-RUN <out> <command> run a command in this pane's environment, as the ferret itself
  if [ -n "${FY_FIXTURE_RICH:-}" ]; then
    # An autonomous ferret is not typed to: the daemon types "Read the file <turn or queued message>.md now" and the words
    # sit in that file. A stage direction in the file is played exactly as a typed one is.
    case "${line}" in
    "Read the "*.md*)
      turn_file="$(printf '%s' "${line}" | grep -o '/[^ ]*\.md' | head -1)"
      if [ -n "${turn_file}" ] && [ -f "${turn_file}" ]; then
        direction="$(grep -m1 -E '^FIXTURE-(REC|RUN) ' "${turn_file}" || true)"
        [ -n "${direction}" ] && line="${direction}"
      fi
      ;;
    esac
    case "${line}" in
    FIXTURE-REC\ *)
      "${FY_FIXTURE_BUN}" "${FY_FIXTURE_HELPER}" "${transcript}" "${sid}" "${line#FIXTURE-REC }"
      printf '> '
      continue
      ;;
    FIXTURE-RUN\ *)
      run="${line#*FIXTURE-RUN }"
      run_out="${run%% *}"
      run_cmd="${run#* }"
      sh -c "${run_cmd}" >"${run_out}" 2>&1 </dev/null
      echo $? >"${run_out}.code"
      printf '> '
      continue
      ;;
    esac
  fi
  record user "u${n}-${sid}" "${last}" "${line}"
  # FIXTURE-RUN <out> <command>: added for the v4 fixture builder (not in the 4.291.5 original). A real ferret runs
  # shell commands in its own environment; this stand-in does the same for exactly one marked line, so the builder can
  # make the daemon see a call that carries the ferret's own session credential without ever reading it. Fixture-only.
  case "${line}" in
  *FIXTURE-RUN\ *)
    run="${line#*FIXTURE-RUN }"
    run_out="${run%% *}"
    run_cmd="${run#* }"
    sh -c "${run_cmd}" >"${run_out}" 2>&1 </dev/null
    echo $? >"${run_out}.code"
    ;;
  esac
  if [ -f "${reply_file}" ]; then
    if [ -d "${media_source}" ] && [ -n "${FY_MEDIA_DIR:-}" ]; then
      mkdir -p "${FY_MEDIA_DIR}" && cp "${media_source}"/* "${FY_MEDIA_DIR}/"
    fi
    at="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
    text="$(sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g' "${reply_file}" | awk '{ printf "%s\\n", $0 }')"
    printf '{"type":"assistant","uuid":"a%s-%s","parentUuid":"u%s-%s","sessionId":"%s","timestamp":"%s","message":{"role":"assistant","content":[{"type":"text","text":"%s"}]}}\n' \
      "${n}" "${sid}" "${n}" "${sid}" "${sid}" "${at}" "${text}" >>"${transcript}"
  else
    record assistant "a${n}-${sid}" "u${n}-${sid}" "FAKE-REPLY ${n}: I read \"${line}\""
  fi
  last="a${n}-${sid}"
  printf 'working\n> '
done
exec sleep 600
