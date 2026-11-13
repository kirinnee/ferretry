#!/usr/bin/env bash
set -euo pipefail

# One tested script for the v4 -> v5 switch of ONE machine: every mechanical step of
# docs/migration/v4-to-v5-prompt.md lives here, so the prompt only carries the owner's decisions, "run phase X, read its
# output, stop on a non-zero exit and tell the owner", and what to check by eye.
#
# It sits beside the converter (migration/v4-to-v5/), is deleted with it once every machine is on v5, and is never
# product code (scripts/validate/migration-isolated.sh keeps the folder isolated). Its tests are
# tests/unit/migrate-sh*.test.ts and run it in temp dirs with FAKE fy, fyd, tmux, brew, nix, xattr, sleep, ps, bun.
#
# USAGE   migrate.sh <phase> [--notes FILE] [phase options]
#   preflight [--kind homebrew|nix-profile|standalone|manual]   tools, versions, release, disk; creates the notes file
#   baseline  --asks-open N [--answered-ask TEXT]               what v4 holds now (names, ids, lanes, panes; no secrets)
#   quiet     --owner-confirmed                                 prove no pane writes, stop the v4 daemon, prove it again
#   backup    --owner-yes                                       mv H B
#   convert                                                     converter dry run, then the real run
#   install   [--rehearsal-build DIR]                           put v5 programs in place (never starts the daemon)
#   start                                                       fyd --check, config check, one deliberate daemon start
#   verify                                                      compare v5 with the baseline, print a table, fy doctor
#   rollback  --owner-yes [--restart]                           back to v4 exactly as recorded
#
# NOTES FILE. `preflight` creates it (a path beside HOME, or --notes) and prints `NOTES=<path>`; every later phase
# takes it with --notes FILE or MIGRATE_NOTES. It holds KEY=value lines (paths, versions, the original PATH, whether
# FY_URL / FY_PORT were set; NEVER a secret value) and `# milestone` lines. A phase writes its milestone BEFORE it acts
# (`# backing-up`) and the done line AFTER (`# backed-up`), so a rollback sees an interrupted step.
#
# EXIT CODES. 0 done. 1 refused or failed. 2 could not be inspected (a tool returned an error, a home is unreadable).
# 3 and 2 from the converter are passed through by `convert`. 64 usage.
#
# NEVER: read a secret or credential file, print a value, `tmux kill-server`, pkill, killall, `fy daemon reset`.
# The script reads only names and metadata (layout-version, terminal-pane.json, `config/logins/` file NAMES).
# Functions below exist only where a step repeats; a phase is otherwise one linear block under its `case` arm.

say() { echo "$@"; }
fail() {
  echo "❌ $*" >&2
  exit 1
}
unreadable() {
  echo "❌ $*" >&2
  exit 2
}
usage() {
  echo "usage: migrate.sh <preflight|baseline|quiet|backup|convert|install|start|verify|rollback> [--notes FILE] [options]" >&2
  exit 64
}

PIN_URL="http://127.0.0.1:9"
QUIET_TRIES="${MIGRATE_QUIET_TRIES:-10}"
CONVERTER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------- arguments
[ "$#" -ge 1 ] || usage
phase="$1"
shift
notes_opt="${MIGRATE_NOTES:-}"
kind_opt=""
asks_open=""
answered_ask=""
owner_yes=0
owner_quiet=0
rehearsal_build=""
restart_ferrets=0
while [ "$#" -gt 0 ]; do
  case "$1" in
  --notes) notes_opt="${2:-}" && shift 2 ;;
  --kind) kind_opt="${2:-}" && shift 2 ;;
  --asks-open) asks_open="${2:-}" && shift 2 ;;
  --answered-ask) answered_ask="${2:-}" && shift 2 ;;
  --owner-yes) owner_yes=1 && shift ;;
  --owner-confirmed) owner_quiet=1 && shift ;;
  --rehearsal-build) rehearsal_build="${2:-}" && shift 2 ;;
  --restart) restart_ferrets=1 && shift ;;
  *) usage ;;
  esac
done
case "${phase}" in
preflight | baseline | quiet | backup | convert | install | start | verify | rollback) ;;
*) usage ;;
esac

# ---------------------------------------------------------------- notes
NOTES="${notes_opt}"
note_get() { sed -n "s/^$1=//p" "${NOTES}" | tail -n 1; }
note_set() {
  case "$2" in *$'\n'*) fail "refusing to record a multi-line value for $1" ;; esac
  printf '%s=%s\n' "$1" "$2" >>"${NOTES}"
}
mark() { echo "# $1" >>"${NOTES}"; }
has_mark() { grep -qx "# $1" "${NOTES}"; }

# The recorded programs and environment. v4 and v5 programs are always called by ABSOLUTE path with an environment
# this script chose, so nothing here depends on (or changes) the agent's own PATH, FY_URL, FY_HOME or FY_PORT:
# EVERY call gets the home and the port recorded at preflight, never the ones the caller's shell holds now.
resolve() { bash -c 'PATH="$1"; command -v "$2"' _ "$1" "$2"; }
v5_path() {
  local build
  build="$(note_get REHEARSAL_BUILD)"
  if [ -n "${build}" ]; then echo "${build}:$(note_get ORIG_PATH)"; else note_get ORIG_PATH; fi
}
# fy_pin PATH URL cmd...: URL "-" means FY_URL unset. Home and port come from the notes (port: set to the recorded value, or unset).
fy_pin() {
  local path="$1" url="$2" home
  shift 2
  home="$(note_get H)"
  if [ "${url}" = "-" ]; then
    if [ "$(note_get FY_PORT_STATE)" = set ]; then
      env -u FY_URL FY_HOME="${home}" FY_PORT="$(note_get FY_PORT)" PATH="${path}" "$@"
    else
      env -u FY_URL -u FY_PORT FY_HOME="${home}" PATH="${path}" "$@"
    fi
  elif [ "$(note_get FY_PORT_STATE)" = set ]; then
    env FY_URL="${url}" FY_HOME="${home}" FY_PORT="$(note_get FY_PORT)" PATH="${path}" "$@"
  else
    env -u FY_PORT FY_URL="${url}" FY_HOME="${home}" PATH="${path}" "$@"
  fi
}
# fy of the v4 era: the original PATH and FY_URL (a plain loopback address, no query) exactly as preflight recorded them.
orig_env() {
  if [ "$(note_get FY_URL_STATE)" = set ]; then
    fy_pin "$(note_get ORIG_PATH)" "$(note_get FY_URL)" "$@"
  else
    fy_pin "$(note_get ORIG_PATH)" - "$@"
  fi
}
fy4() { orig_env "$(resolve "$(note_get ORIG_PATH)" fy)" "$@"; }
# fy of v5: its PATH, no FY_URL (it talks to the v5 daemon); `pinned` adds the dummy address so nothing starts a daemon.
v5_fy() { resolve "$(v5_path)" fy; }
v5_fyd() { resolve "$(v5_path)" fyd; }
fy5() { fy_pin "$(v5_path)" - "$(v5_fy)" "$@"; }
fy5_pinned() { fy_pin "$(v5_path)" "${PIN_URL}" "$(v5_fy)" "$@"; }
fyd5_pinned() { fy_pin "$(v5_path)" "${PIN_URL}" "$(v5_fyd)" "$@"; }

# A path's canonical form even when its last part is absent (a moved home): the parent resolved, the name kept.
canon() {
  local parent
  if [ -d "$1" ]; then
    (cd "$1" && pwd -P)
  else
    parent="$(cd "$(dirname "$1")" 2>/dev/null && pwd -P)" || parent="$(dirname "$1")"
    printf '%s/%s\n' "${parent}" "$(basename "$1")"
  fi
}
# A rehearsal is for a fake home only: refuse the default home, by name and by where it really is, BEFORE any change.
rehearsal_refuse() {
  if [ "$1" = "${HOME}/.ferretry" ] || [ "$(canon "$1")" = "$(canon "${HOME}/.ferretry")" ]; then
    fail "rehearsal mode (MIGRATE_REHEARSAL=1) refuses the default home ${HOME}/.ferretry: it is never for a real home. Nothing was changed"
  fi
}
# Every phase that stops, moves or converts re-checks what preflight proved.
rehearsal_phase_guard() {
  if [ "$(note_get REHEARSAL)" = 1 ]; then rehearsal_refuse "$1"; fi
}

# tmux pane list, one "<pane id> <activity>" line per pane; non-zero when tmux cannot be read.
quiet_check() { # $1 socket. 0 quiet for 60 s, 1 still writing after QUIET_TRIES tries, 2 tmux could not be read.
  local n=0 before after
  while [ "${n}" -lt "${QUIET_TRIES}" ]; do
    before="$(tmux -S "$1" list-panes -a -F '#{pane_id} #{window_activity}')" || return 2
    sleep 60
    after="$(tmux -S "$1" list-panes -a -F '#{pane_id} #{window_activity}')" || return 2
    [ "$(sort <<<"${before}")" = "$(sort <<<"${after}")" ] && return 0
    n=$((n + 1))
  done
  return 1
}

# 0 when a process named `fyd` is running (proof by process list, never by a marker); 1 when none; exits 2 when ps fails.
# Only each process's command NAME is read (`comm`), never its arguments, which can carry tokens of unrelated programs.
daemon_live() {
  local listing name
  listing="$(ps -eo comm=)" || unreadable "cannot read the process list (ps failed)"
  while IFS= read -r name; do
    if [ "${name##*/}" = fyd ]; then return 0; fi
  done <<<"${listing}"
  return 1
}

# A version string from `<program> --version`: three numbers.
version_of() {
  local out
  out="$("$@" --version)" || return 1
  [[ ${out} =~ ([0-9]+\.[0-9]+\.[0-9]+) ]] || return 1
  echo "${BASH_REMATCH[1]}"
}
# The same, with the recorded home and port pinned (v5 programs: their PATH; v4 programs: the original PATH and FY_URL).
v5_version() { version_of fy_pin "$(v5_path)" - "$1"; }
v4_version_of() { version_of orig_env "$1"; }

# macOS: drop the quarantine attribute from a file. An absent attribute is expected (exit 1 of the probe), not an error.
unquarantine() {
  local file="$1" status=0
  [ "${MIGRATE_OS:-$(uname -s)}" = Darwin ] || return 0
  xattr -p com.apple.quarantine "${file}" >/dev/null 2>&1 || status=$?
  [ "${status}" -eq 0 ] || return 0
  xattr -d com.apple.quarantine "${file}"
}

[ "${phase}" = preflight ] || {
  [ -n "${NOTES}" ] || fail "pass the notes file: --notes FILE (or MIGRATE_NOTES); preflight printed it"
  [ -f "${NOTES}" ] || fail "no notes file at ${NOTES}"
}

case "${phase}" in

# ================================================================ preflight
preflight)
  say "📝 preflight: tools, v4 version, released v5, disk, home"
  for tool in bash jq tmux bun git; do
    command -v "${tool}" >/dev/null || fail "${tool} is not on PATH; install it and run preflight again"
  done

  H="${FY_HOME:-$HOME/.ferretry}"
  # A rehearsal never touches the default home: refused here, before anything is read, stopped, moved or converted.
  if [ "${MIGRATE_REHEARSAL:-}" = 1 ]; then rehearsal_refuse "${H}"; fi
  [ -d "${H}" ] || fail "no Ferretry home at ${H}"
  [ -f "${H}/layout-version" ] || fail "${H} has no layout-version: it is not a v4 home (a v5 home has none)"
  [ "$(cat "${H}/layout-version")" = 2 ] || fail "${H}/layout-version is not 2: the converter reads layout 2 of 4.291.x only"

  v4_fy="$(command -v fy)" || fail "fy is not on PATH"
  v4_fyd="$(command -v fyd)" || fail "fyd is not on PATH"
  v4_worker=""
  if worker="$(command -v fyd-browser-worker)"; then v4_worker="${worker}"; fi # absent on a very old install: expected
  v4_version="$(version_of "${v4_fy}")" || fail "'${v4_fy} --version' printed no version"
  [[ ${v4_version} =~ ^4\.291\.([0-9]+)$ ]] || fail "fy is ${v4_version}; the converter needs 4.291.10 or later of 4.291.x (bring v4 up first, by the install kind)"
  [ "${BASH_REMATCH[1]}" -ge 10 ] || fail "fy is ${v4_version}; 4.291.10 is the first v4 that refuses the jump to 5.x without --major: update to it first (never 'fy daemon update --yes' bare)"

  # The converter and the programs come from ONE released tag, which is the checkout this script lives in.
  src="$(git -C "${CONVERTER_DIR}" rev-parse --show-toplevel)" || fail "this script is not inside a git checkout"
  commit="$(git -C "${src}" rev-parse HEAD)"
  [ -z "$(git -C "${src}" status --porcelain)" ] || fail "the checkout ${src} has local changes; use a fresh clone at the release tag"
  tag=""
  if tag="$(git -C "${src}" describe --tags --exact-match HEAD 2>/dev/null)" && [[ ${tag} =~ ^v5\.[0-9]+\.[0-9]+$ ]]; then
    say "✅ this checkout is the released tag ${tag}"
  else
    tag=""
    [ "${MIGRATE_REHEARSAL:-}" = 1 ] || fail "this checkout is not exactly a released v5 tag (v5.N.N). The real switch runs only from a released 5.0: clone the tag and run this script from there"
    say "⚠️ MIGRATE_REHEARSAL=1: an untagged checkout is allowed for a rehearsal in a sandbox with a fake home only"
  fi

  # Install kind.
  kind="${kind_opt}"
  if [ -z "${kind}" ]; then
    kind=standalone
    if command -v brew >/dev/null && casks="$(brew list --cask 2>/dev/null)"; then # a non-zero here means "no usable cask support": not homebrew
      grep -qxE 'ferretry(@4)?' <<<"${casks}" && kind=homebrew
    fi
    if [ "${kind}" = standalone ] && command -v nix >/dev/null && profile="$(nix profile list 2>/dev/null)"; then # non-zero: nix profile unusable, not a profile install
      grep -q 'github:kirinnee/ferretry' <<<"${profile}" && kind=nix-profile
    fi
  fi
  case "${kind}" in homebrew | nix-profile | standalone | manual) ;; *) fail "unknown install kind '${kind}' (homebrew, nix-profile, standalone, manual)" ;; esac
  say "📝 install kind: ${kind}"

  # A released v5 must exist for that kind.
  if [ -n "${tag}" ]; then
    case "${kind}" in
    homebrew)
      available="$(brew info --cask --json=v2 kirinnee/ferretry/ferretry | jq -r '.casks[0].version')" || fail "cannot read the cask version (brew info)"
      [ "${available}" = "${tag#v}" ] || fail "the Homebrew cask offers ${available}, not ${tag#v}: v5 is not released through Homebrew yet"
      ;;
    nix-profile)
      nix flake metadata --json "github:kirinnee/ferretry/${tag}" >/dev/null || fail "nix cannot see github:kirinnee/ferretry/${tag}"
      ;;
    standalone | manual) say "📝 ${kind}: release files are checked by the install itself (it fails closed, rollback handles it)" ;;
    esac
  fi

  # Disk: the new home needs about as much as the old one, on the same filesystem.
  used_kb="$(du -sk "${H}" | awk '{print $1}')" || unreadable "cannot measure ${H}"
  avail_kb="$(df -Pk "$(dirname "${H}")" | awk 'NR==2 {print $4}')" || unreadable "cannot read free space"
  [ "${avail_kb}" -ge "${used_kb}" ] || fail "not enough free space beside ${H}: need about ${used_kb} KB, ${avail_kb} KB free"

  # FY_URL: only scheme://host:port of THIS machine's loopback is ever recorded. Credentials (user:pass@), a query, a
  # fragment or a path are never copied or printed; a remote address cannot be proven to be the daemon of this home.
  url_state="unset"
  url_base=""
  url_extra=""
  if [ -n "${FY_URL:-}" ]; then
    url_re='^(https?)://([^/?#]*)(.*)$'
    [[ ${FY_URL} =~ ${url_re} ]] || fail "FY_URL is set but is not an http(s) address. Unset it for the switch (nothing was recorded)"
    url_scheme="${BASH_REMATCH[1]}"
    url_auth="${BASH_REMATCH[2]}"
    url_rest="${BASH_REMATCH[3]}"
    case "${url_auth}" in *@*) fail "FY_URL carries credentials before the host. Unset it for the switch: fy reaches the daemon of ${H} without it (nothing was recorded)" ;; esac
    loopback_re='^(localhost|127(\.[0-9]{1,3}){3}|\[::1\])(:[0-9]{1,5})?$'
    [[ ${url_auth} =~ ${loopback_re} ]] || fail "FY_URL names a host that is not this machine's loopback, so it cannot be proven to be the daemon of ${H}. Unset it for the switch (nothing was recorded)"
    url_state="set"
    url_base="${url_scheme}://${url_auth}"
    if [ -n "${url_rest}" ] && [ "${url_rest}" != "/" ]; then url_extra=present; fi
  fi
  port_state="unset"
  port_value=""
  if [ -n "${FY_PORT+x}" ]; then
    [[ ${FY_PORT} =~ ^[0-9]{1,5}$ ]] || fail "FY_PORT is set but is not a plain port number. Unset it or fix it for the switch (nothing was recorded)"
    port_state="set"
    port_value="${FY_PORT}"
  fi

  stamp="${MIGRATE_STAMP:-$(date -u +%Y-%m-%d-%H%M)}"
  if [ -z "${NOTES}" ]; then NOTES="${HOME}/v4-to-v5-${stamp}.notes"; fi
  (
    set -o noclobber
    : >"${NOTES}"
  ) || fail "notes file ${NOTES} already exists; pass a new --notes or remove it yourself"
  chmod 600 "${NOTES}"
  note_set STAMP "${stamp}"
  note_set H "${H}"
  note_set B "${H}-before-${stamp}"
  note_set SRC "${src}"
  note_set COMMIT "${commit}"
  note_set TAG "${tag}"
  note_set KIND "${kind}"
  note_set REHEARSAL "${MIGRATE_REHEARSAL:-0}"
  note_set V4_VERSION "${v4_version}"
  note_set V4_FY "${v4_fy}"
  note_set V4_FYD "${v4_fyd}"
  note_set V4_WORKER "${v4_worker}"
  note_set ORIG_PATH "${PATH}"
  note_set H_CANON "$(canon "${H}")"
  note_set FY_URL_STATE "${url_state}"
  if [ "${url_state}" = set ]; then
    note_set FY_URL "${url_base}"
    note_set FY_URL_EXTRA "${url_extra:-none}"
    if [ -n "${url_extra}" ]; then say "⚠️ FY_URL carries more than scheme://host:port (a path, query or fragment: query present). Only the address is recorded; rollback uses the address alone. The extra part is never copied."; fi
  fi
  note_set FY_PORT_STATE "${port_state}"
  if [ "${port_state}" = set ]; then note_set FY_PORT "${port_value}"; fi
  mark preflighted
  say "✅ preflight passed: v4 ${v4_version} -> ${tag:-rehearsal}, kind ${kind}, home ${H}"
  say "NOTES=${NOTES}"
  ;;

# ================================================================ baseline
baseline)
  H="$(note_get H)"
  v4_fy="$(note_get V4_FY)"
  [[ ${asks_open} =~ ^[0-9]+$ ]] || fail "--asks-open N is required: the owner opens the app's Agenda and reads how many asks are open"
  base="$(dirname "${NOTES}")/v4-baseline-$(note_get STAMP)"
  mkdir -m 700 "${base}" || fail "baseline folder ${base} already exists"
  mark baselining
  say "📝 baseline into ${base}"

  # Ferrets: id, callsign (v4 `teammate`) AND title (v4 `name`) kept separately, parent, state.
  orig_env "${v4_fy}" ps -a --json >"${base}/ps.raw.json" || fail "v4 'fy ps -a --json' failed"
  jq -e 'type == "array" and all(.[]; (.config.id | type) == "string")' "${base}/ps.raw.json" >/dev/null || fail "v4 'fy ps -a --json' did not print a list of ferrets"
  jq -S '[.[] | {id: .config.id, callsign: (.config.teammate // null), title: (.config.name // null), parent: (.config.parent // null), status: (.state.status // null)}] | sort_by(.id)' "${base}/ps.raw.json" >"${base}/ferrets.json"
  rm -f "${base}/ps.raw.json"

  # Live panes: the owner map from terminal-pane.json (ids and handles only) and tmux's own list.
  : >"${base}/pane-owners.raw"
  for f in "${H}"/state/sessions/*/terminal-pane.json; do
    [ -e "${f}" ] || continue
    jq -r '[.sessionId, .tmuxSession, .paneId] | @tsv' "${f}" >>"${base}/pane-owners.raw" || fail "cannot parse ${f}"
  done
  sort "${base}/pane-owners.raw" >"${base}/pane-owners.tsv"
  rm -f "${base}/pane-owners.raw"
  if [ -S "${H}/tmux.sock" ]; then
    panes="$(tmux -S "${H}/tmux.sock" list-panes -a -F '#{session_name} #{pane_id}')" || unreadable "tmux could not be read at ${H}/tmux.sock"
    sort <<<"${panes}" >"${base}/panes.txt"
  else
    [ ! -s "${base}/pane-owners.tsv" ] || unreadable "ferrets own panes but ${H}/tmux.sock is not there"
    : >"${base}/panes.txt"
  fi
  if [ -s "${base}/panes.txt" ] || [ -s "${base}/pane-owners.tsv" ]; then note_set PANES "$(wc -l <"${base}/panes.txt" | tr -d ' ')"; else
    note_set PANES none
    say "📝 no live ferret panes: the empty-fleet path (the pane checks are skipped, never failed)"
  fi
  awk -F'\t' '{print $1}' "${base}/pane-owners.tsv" >"${base}/restart-ids.txt"

  # Board: every state, private cards too, ids and lanes; a state at the 500-card page limit is a stop.
  for s in open closed dropped; do
    orig_env "${v4_fy}" board --project all --state "${s}" --all --json >"${base}/board-${s}.raw.json" || fail "v4 'fy board --state ${s}' failed"
    jq -S '{truncated: (.nextCursor != null), cards: ([.cards[] | {id, laneId}] | sort_by(.id))}' "${base}/board-${s}.raw.json" >"${base}/board-${s}.json" || fail "cannot read the v4 board (${s})"
    rm -f "${base}/board-${s}.raw.json"
    [ "$(jq -r '.truncated' "${base}/board-${s}.json")" = false ] || fail "the v4 board has more than 500 ${s} cards; fy board cannot page past that: tell the owner"
  done

  # Login names (file names only) and secret NAMES (never values).
  : >"${base}/logins.raw"
  for f in "${H}"/config/logins/*.yaml; do
    [ -e "${f}" ] || continue
    basename "${f}" .yaml >>"${base}/logins.raw"
  done
  sort "${base}/logins.raw" >"${base}/logins.txt"
  rm -f "${base}/logins.raw"
  secret_listing="$(orig_env "${v4_fy}" secret ls --json)" || fail "v4 'fy secret ls --json' failed"
  jq -e '(.health // "ok") != "damaged" and (.secrets | type) == "array"' <<<"${secret_listing}" >/dev/null || fail "the v4 secret store is damaged or unreadable; do not go on"
  jq -r '[.secrets[].name] | sort | .[]' <<<"${secret_listing}" >"${base}/secrets.txt"
  secret_listing=""

  note_set BASE "${base}"
  note_set ASKS_OPEN "${asks_open}"
  note_set ASKS_ANSWERED "${answered_ask}"
  mark baselined
  say "✅ baseline: $(jq 'length' "${base}/ferrets.json") ferrets, $(wc -l <"${base}/pane-owners.tsv" | tr -d ' ') live panes, $(wc -l <"${base}/logins.txt" | tr -d ' ') logins, $(wc -l <"${base}/secrets.txt" | tr -d ' ') secret names, ${asks_open} open asks"
  ;;

# ================================================================ quiet
quiet)
  H="$(note_get H)"
  v4_fy="$(note_get V4_FY)"
  [ "${owner_quiet}" = 1 ] || fail "ask the owner first, then pass --owner-confirmed. They must say: no ferret is mid-turn, phone approvals and input holds are settled, no loop or timer runs inside a harness, and nobody will message a ferret or type into a pane"
  has_mark baselined || fail "run baseline first"
  rehearsal_phase_guard "${H}"
  mark quieting
  sock="${H}/tmux.sock"
  empty=0
  [ "$(note_get PANES)" = none ] && empty=1

  if [ "${empty}" = 0 ]; then
    say "⚙️ no pane writes for 60 s (before stopping the daemon)"
    status=0
    quiet_check "${sock}" || status=$?
    case "${status}" in 0) ;; 1) fail "a pane kept writing for ${QUIET_TRIES} minutes: wait for the ferret and run quiet again" ;; *) unreadable "tmux could not be read at ${sock}" ;; esac
  else
    say "📝 empty fleet: no pane to watch"
  fi

  say "⚙️ stopping the v4 daemon (tmux and every pane keep running)"
  orig_env "${v4_fy}" daemon stop || fail "'fy daemon stop' failed"
  mark v4-daemon-stopped

  if [ "${empty}" = 0 ]; then
    status=0
    quiet_check "${sock}" || status=$?
    case "${status}" in 0) ;; 1) fail "a pane kept writing after the daemon stopped: tell the owner not to type into panes, then run quiet again" ;; *) unreadable "tmux could not be read at ${sock} after the daemon stopped" ;; esac
    tmux -S "${sock}" ls >/dev/null || unreadable "the tmux server at ${sock} is gone after the daemon stopped"
  fi

  # Nothing half-done: pending agenda files, the fleet apply lock, a share migration journal.
  [ -d "${H}/state/sessions" ] && [ -r "${H}/state/sessions" ] && [ -x "${H}/state/sessions" ] || unreadable "cannot read ${H}/state/sessions"
  for d in "${H}"/state/sessions/*/; do
    [ -d "${d}" ] || continue
    { [ -r "${d}" ] && [ -x "${d}" ]; } || unreadable "cannot read ${d}"
  done
  found=0
  for f in "${H}"/state/sessions/*/agenda-*.pending.json "${H}/fleet/.fy-fleet-apply.lock" "${H}"/fleet/shared/*/.migration-journal; do
    if [ -e "${f}" ]; then
      printf '%s\n' "${f}"
      found=1
    fi
  done
  if [ "${found}" = 1 ]; then
    say "⚠️ FOUND: something is pending (names above). Starting v4 for a minute so it can finish, then stopping it again"
    mark quiet-retry
    orig_env "${v4_fy}" daemon start || fail "'fy daemon start' failed"
    sleep 60
    orig_env "${v4_fy}" daemon stop || fail "'fy daemon stop' failed"
    fail "pending files were found. The quiet window is NOT established: ask the owner again and run quiet from the start"
  fi
  mark quiet
  say "✅ quiet: no pane wrote, the v4 daemon is stopped, nothing is pending"
  ;;

# ================================================================ backup
backup)
  H="$(note_get H)"
  B="$(note_get B)"
  [ "${owner_yes}" = 1 ] || fail "tell the owner: 'I will move ${H} to ${B}; that folder is the backup and stays untouched until you delete it', then pass --owner-yes"
  has_mark quiet || fail "run quiet first"
  rehearsal_phase_guard "${H}"
  if has_mark backed-up && [ -d "${B}" ] && [ ! -e "${H}" ]; then
    say "✅ already backed up at ${B}"
    exit 0
  fi
  [ -d "${H}" ] || fail "no home at ${H}"
  [ ! -e "${B}" ] || fail "${B} already exists: refusing to overwrite a backup"
  mark backing-up
  mv "${H}" "${B}" || fail "mv ${H} ${B} failed"
  chmod 700 "${B}" || fail "chmod 700 ${B} failed"
  mark backed-up
  say "✅ backed up: ${B} (mode 700). Send nothing to any ferret and type into no pane until v5 is started"
  ;;

# ================================================================ convert
convert)
  H="$(note_get H)"
  B="$(note_get B)"
  src="$(note_get SRC)"
  has_mark backed-up || fail "run backup first"
  rehearsal_phase_guard "${H}"
  [ "$(git -C "${src}" rev-parse HEAD)" = "$(note_get COMMIT)" ] || fail "the converter checkout moved off the recorded commit"
  [ -z "$(git -C "${src}" status --porcelain)" ] || fail "the converter checkout has local changes"
  [ ! -e "${H}" ] || fail "${H} exists: the converter writes a new home"
  dry_report="$(dirname "${NOTES}")/v4-v5-dry-run-$(note_get STAMP).json"
  (cd "${CONVERTER_DIR}" && bun install --frozen-lockfile) || fail "bun install failed in ${CONVERTER_DIR}"

  say "🔨 converter dry run (creates and changes no home)"
  mark dry-running
  status=0
  (cd "${CONVERTER_DIR}" && bun src/main.ts --from "${B}" --to "${H}" --dry-run --report "${dry_report}") || status=$?
  case "${status}" in
  0) ;;
  3) echo "❌ the dry run says a step would not convert (exit 3): read the summary to the owner; nothing was changed" >&2 && exit 3 ;;
  2) echo "❌ the converter refused (exit 2): not a stopped 4.291.x home, the v4 daemon holds its lock, or the target is not empty" >&2 && exit 2 ;;
  *) fail "the converter dry run exited ${status}" ;;
  esac
  mark dry-run-ok
  [ ! -e "${H}" ] || fail "the dry run created ${H}: that must never happen"

  say "🔨 converter real run"
  mark converting
  status=0
  (cd "${CONVERTER_DIR}" && bun src/main.ts --from "${B}" --to "${H}") || status=$?
  case "${status}" in
  0) ;;
  3) echo "❌ the conversion did not finish (exit 3): there is no home.json, v5 refuses it by design. Roll back, or wait for a fixed converter" >&2 && exit 3 ;;
  2) echo "❌ the converter refused (exit 2)" >&2 && exit 2 ;;
  *) fail "the converter exited ${status}" ;;
  esac
  [ -f "${H}/home.json" ] || fail "exit 0 but ${H}/home.json is missing"
  mark converted
  say "✅ converted; report at ${H}.conversion-report.json (show the owner the summary above)"
  ;;

# ================================================================ install
install)
  H="$(note_get H)"
  B="$(note_get B)"
  kind="$(note_get KIND)"
  tag="$(note_get TAG)"
  has_mark converted || fail "run convert first"
  rehearsal_phase_guard "${H}"
  mark installing-v5

  if [ -n "${rehearsal_build}" ]; then
    # REHEARSAL ONLY: a pre-release build in a sandbox. Never for a real home.
    [ "${MIGRATE_REHEARSAL:-}" = 1 ] || fail "--rehearsal-build needs MIGRATE_REHEARSAL=1. It is for rehearsing the migration in a sandbox; the owner's real switch runs only from a released 5.0"
    rehearsal_refuse "${H}"
    [ -x "${rehearsal_build}/fy" ] && [ -x "${rehearsal_build}/fyd" ] || fail "${rehearsal_build} must hold executable fy and fyd"
    say "⚠️ REHEARSAL BUILD: the app origin of this build is the PREVIEW (ferretry-v5.pages.dev), not the production app, so paired devices and passkeys from the real app do NOT carry over. This mode is never for a real home."
    note_set REHEARSAL_BUILD "${rehearsal_build}"
    note_set PKG_BEFORE rehearsal
    for p in fy fyd; do unquarantine "${rehearsal_build}/${p}"; done
    mark installed-v5
  else
    [ -n "${tag}" ] || fail "no released tag was recorded (an untagged rehearsal checkout): use --rehearsal-build, or run the real switch from a released v5 tag"
    want="${tag#v}"
    case "${kind}" in
    homebrew)
      casks="$(brew list --cask)" || fail "'brew list --cask' failed"
      has_v4cask=0 && has_main=0
      grep -qx 'ferretry@4' <<<"${casks}" && has_v4cask=1
      grep -qx 'ferretry' <<<"${casks}" && has_main=1
      pkg_before=none
      if [ "${has_v4cask}" = 1 ]; then pkg_before=cask:ferretry@4; elif [ "${has_main}" = 1 ]; then pkg_before=cask:ferretry; fi
      note_set PKG_BEFORE "${pkg_before}"
      if [ "${has_v4cask}" = 1 ]; then
        brew uninstall --cask ferretry@4 || fail "brew uninstall --cask ferretry@4 failed"
        brew install --cask kirinnee/ferretry/ferretry || fail "brew install of the v5 cask failed (v4 is no longer installed: rollback installs ferretry@4)"
      elif [ "${has_main}" = 1 ]; then
        brew upgrade --cask ferretry || fail "brew upgrade --cask ferretry failed"
      else
        brew install --cask kirinnee/ferretry/ferretry || fail "brew install of the v5 cask failed"
      fi
      ;;
    nix-profile)
      profile="$(nix profile list)" || fail "'nix profile list' failed"
      # Entries print "Name:" (newer Nix) or "Index:" (older), then a flake URL line; the element is the one on github:kirinnee/ferretry.
      element="$(awk '/^(Name|Index):/ {el=$2} /[Ff]lake URL:/ && /github:kirinnee\/ferretry/ {print el; exit}' <<<"${profile}")"
      note_set PKG_BEFORE "nix:$([ -n "${element}" ] && echo present || echo absent)"
      if [ -n "${element}" ]; then nix profile remove "${element}" || fail "nix profile remove ${element} failed"; fi
      add=add
      nix profile add --help >/dev/null 2>&1 || add=install # a Nix too old to know `add` calls it `install`
      nix profile "${add}" "github:kirinnee/ferretry/${tag}" || fail "nix profile ${add} github:kirinnee/ferretry/${tag} failed (the element was removed: rollback installs v4)"
      ;;
    standalone)
      note_set PKG_BEFORE standalone
      aside="${B}-bin"
      skip_update=0
      if [ -e "${aside}" ]; then
        # A backup of the v4 programs exists: it is the only exact copy and is NEVER written again. Same bytes as now = nothing
        # was swapped yet; different bytes and fy already is the selected release = the swap happened, go on to the checks.
        swapped=0
        for p in fy fyd fyd-browser-worker; do
          [ -f "${aside}/${p}" ] || continue
          c="$(resolve "$(note_get ORIG_PATH)" "${p}")" || c=""
          if [ -z "${c}" ] || ! cmp -s "${c}" "${aside}/${p}"; then swapped=1; fi
        done
        if [ "${swapped}" = 1 ]; then
          now="$(v5_version "$(v5_fy)")" || now=""
          [ "${now}" = "${want}" ] || fail "the saved v4 programs in ${aside} are kept untouched, and the programs now on the PATH differ from them without being ${want}: install will not overwrite that backup. Run rollback, or restore by hand"
          say "📝 the swap to ${want} already happened; the v4 backup in ${aside} is untouched"
          skip_update=1
        else
          say "📝 the v4 backup in ${aside} already exists and matches the installed programs: kept untouched"
        fi
      else
        partial="${aside}.partial"
        rm -rf "${partial}"
        mkdir -p "${partial}"
        : >"${partial}/paths.txt"
        for p in fy fyd fyd-browser-worker; do
          c=""
          if found="$(resolve "$(note_get ORIG_PATH)" "${p}")"; then c="${found}"; fi # not found: handled below by name
          if [ -n "${c}" ]; then
            cp -p "${c}" "${partial}/${p}" || fail "cannot copy ${c} aside"
            printf '%s\n' "${c}" >>"${partial}/paths.txt"
          elif [ "${p}" = fyd-browser-worker ]; then say "📝 no fyd-browser-worker found (a very old install)"; else fail "${p} is missing: there would be no exact v4 to put back"; fi
        done
        mv "${partial}" "${aside}" || fail "cannot finish the v4 backup ${aside}"
        say "📝 v4 programs kept in ${aside}"
      fi
      if [ "${skip_update}" = 0 ]; then
        orig_env "$(note_get V4_FY)" daemon update --major --yes --to "${want}" || fail "'fy daemon update --major --yes --to ${want}' failed"
      fi
      ;;
    manual)
      note_set PKG_BEFORE manual
      say "📝 manual kind: install v${want} yourself (module repin, deb/rpm), then this phase only verifies it"
      ;;
    *) fail "unknown kind ${kind}" ;;
    esac
    mark installed-v5
  fi

  got="$(v5_version "$(v5_fy)")" || fail "the v5 fy prints no version"
  [[ ${got} =~ ^5\. ]] || fail "fy --version prints ${got}, not 5.x: v5 is not what 'fy' resolves to"
  if [ -z "${rehearsal_build}" ]; then
    [ "${got}" = "${tag#v}" ] || fail "fy is ${got} but the converter is ${tag}: they must match"
  fi
  fyd_got="$(v5_version "$(v5_fyd)")" || fail "the v5 fyd prints no version"
  [[ ${fyd_got} =~ ^5\. ]] || fail "fyd --version prints ${fyd_got}, not 5.x"
  if [ -z "${rehearsal_build}" ]; then
    [ "${fyd_got}" = "${tag#v}" ] || fail "fyd is ${fyd_got} but the converter is ${tag}: fy and fyd must both be the selected release"
  fi
  say "✅ v5 installed: fy ${got}, fyd ${fyd_got} (the daemon is NOT started)"
  ;;

# ================================================================ start
start)
  H="$(note_get H)"
  has_mark installed-v5 || fail "run install first"
  say "📝 checks that start nothing (FY_URL pinned to ${PIN_URL} for these calls only)"
  status=0
  fyd5_pinned --check >"${NOTES}.fyd-check.out" 2>&1 || status=$?
  grep_status=0
  grep '^!' "${NOTES}.fyd-check.out" || grep_status=$? # lines the owner must see; exit 1 (no such line) is normal
  [ "${grep_status}" -le 1 ] || fail "cannot read ${NOTES}.fyd-check.out"
  case "${status}" in
  0) ;;
  78) fail "fyd --check exit 78: refused home, or another fyd is serving (see ${NOTES}.fyd-check.out)" ;;
  69) fail "fyd --check exit 69: something else holds the daemon address" ;;
  *) fail "fyd --check exited ${status}" ;;
  esac
  [ -f "${H}/home.json" ] || fail "${H}/home.json is missing"

  status=0
  fy5_pinned config check >"${NOTES}.config-check.out" 2>&1 || status=$?
  if [ "${status}" -ne 0 ]; then
    # Expected only for a literal credential in a login file (it names the file and key, never a value). EVERY line of the
    # report must be that diagnostic: one other problem next to it (schema, access, a held change) is a stop.
    credential_lines="$(awk '/secret set/ {n++} END {print n + 0}' "${NOTES}.config-check.out")"
    other_lines="$(awk 'NF && !/secret set/ {n++} END {print n + 0}' "${NOTES}.config-check.out")"
    { [ "${credential_lines}" -gt 0 ] && [ "${other_lines}" -eq 0 ]; } || fail "fy config check failed for a reason other than only a literal credential (see ${NOTES}.config-check.out)"
    say "⚠️ fy config check names a literal credential in a login file (expected, repaired by the OWNER after the start; names below)"
    cat "${NOTES}.config-check.out"
    mark credential-repair-pending
  fi
  entries="$(ls -A "${H}")" || unreadable "cannot list ${H}"
  while read -r entry; do
    case "${entry}" in home.json | config | state | run | logs | "") ;; *) fail "unexpected entry '${entry}' in the new home ${H}" ;; esac
  done <<<"${entries}"

  mark starting-v5
  status=0
  fy5 daemon start || status=$?
  if [ "${status}" -eq 0 ]; then
    ps_status=0
    fy5 ps -a --json >"${NOTES}.ps-after-start.json" || ps_status=$?
    if [ "${ps_status}" -eq 0 ] && jq -e 'type == "array"' "${NOTES}.ps-after-start.json" >/dev/null; then
      rm -f "${NOTES}.ps-after-start.json"
      mark started-v5
      say "✅ v5 daemon started and answering"
      exit 0
    fi
    rm -f "${NOTES}.ps-after-start.json"
    echo "❌ the daemon was started but does not answer" >&2
  else
    echo "❌ 'fy daemon start' exited ${status}" >&2
  fi
  if daemon_live; then
    echo "❌ a fyd process is still running (it may be a half-started v5 daemon holding ${H}): rollback stops it" >&2
  else
    say "📝 proven: no fyd process is running, so no v5 daemon owns ${H}"
  fi
  exit 1
  ;;

# ================================================================ verify
verify)
  H="$(note_get H)"
  base="$(note_get BASE)"
  has_mark started-v5 || fail "run start first"
  work="$(mktemp -d)"
  trap 'rm -rf "${work}"' EXIT
  rows="${work}/rows"
  : >"${rows}"
  bad=0
  row() {
    printf '%s\t%s\t%s\n' "$1" "$2" "$3" >>"${rows}"
    [ "$2" != FAIL ] || bad=1
  }

  # Ferrets: ids and parents exactly; callsign against v5 name; title against v5 title.
  if fy5 ps -a --json >"${work}/ps.json" && jq -e 'type == "array"' "${work}/ps.json" >/dev/null; then
    jq -r --slurpfile v4 "${base}/ferrets.json" '
      ($v4[0] | map({key: .id, value: .}) | from_entries) as $old
      | (map({key: .id, value: .}) | from_entries) as $new
      | [($old | keys[]) | select($new[.] == null)] as $missing
      | [($new | keys[]) | select($old[.] == null)] as $extra
      | [($old | keys[]) | select($new[.] != null and (($new[.].parent // null) != $old[.].parent))] as $parent
      | [($old | keys[]) | select($new[.] != null and $old[.].callsign != null and $new[.].name != $old[.].callsign)] as $name
      | [($old | keys[]) | select($new[.] != null and $old[.].callsign != null and $new[.].name != $old[.].callsign
          and $new[.].name != $old[.].title and $new[.].name != .)] as $namebad
      | [($old | keys[]) | select($new[.] != null and $old[.].callsign == null and $new[.].name != $old[.].title and $new[.].name != .)] as $legacybad
      | [($old | keys[]) | select($new[.] != null and $old[.].title != null and ($new[.].title // null) != $old[.].title)] as $title
      | ["ferret ids", (if ($missing | length) + ($extra | length) == 0 then "OK" else "FAIL" end), "\($old | length) in v4, \($new | length) in v5, missing \($missing | length), extra \($extra | length)"],
        ["parents", (if ($parent | length) == 0 then "OK" else "FAIL" end), "\($parent | length) differ"],
        ["callsigns (v4 callsign = v5 name)", (if ($namebad | length) + ($legacybad | length) == 0 then (if ($name | length) == 0 then "OK" else "REVIEW" end) else "FAIL" end), "\($name | length) use the converter fallback (title or id), \($namebad | length) + \($legacybad | length) unexplained"],
        ["titles (v4 title = v5 title)", (if ($title | length) == 0 then "OK" else "REVIEW" end), "\($title | length) differ (an invalid or placeholder title is dropped by the converter)"]
      | @tsv' "${work}/ps.json" >>"${rows}"
    grep -q $'\tFAIL\t' "${rows}" && bad=1
  else
    row "ferrets" FAIL "v5 'fy ps -a --json' failed or is not a list"
  fi

  # Live panes: every baseline pane is still there (skipped, said so, on an empty fleet).
  if [ "$(note_get PANES)" = none ]; then
    row "panes" "SKIP" "no live ferret at baseline"
  else
    psock="${H}/state/terminals/tmux.sock"
    if panes="$(tmux -S "${psock}" list-panes -a -F '#{session_name} #{pane_id}')"; then
      sort <<<"${panes}" >"${work}/panes.now"
      lost="$(comm -23 "${base}/panes.txt" "${work}/panes.now")"
      if [ -z "${lost}" ]; then row "panes" OK "$(wc -l <"${base}/panes.txt" | tr -d ' ') baseline panes still present"; else row "panes" FAIL "$(wc -l <<<"${lost}" | tr -d ' ') baseline panes missing"; fi
    else
      row "panes" FAIL "tmux could not be read at ${psock}"
    fi
  fi

  # Board: ids exactly (FAIL), lanes shown to the owner (REVIEW).
  for s in open closed dropped; do
    if fy5 board --project all --state "${s}" --all --json >"${work}/board-${s}.raw" && jq -S '{truncated: (.nextCursor != null), cards: ([.cards[] | {id, laneId}] | sort_by(.id))}' "${work}/board-${s}.raw" >"${work}/board-${s}.json"; then
      if [ "$(jq -c '[.cards[].id]' "${base}/board-${s}.json")" != "$(jq -c '[.cards[].id]' "${work}/board-${s}.json")" ] || [ "$(jq -r '.truncated' "${work}/board-${s}.json")" != false ]; then
        row "board ${s}: card ids" FAIL "differ from the baseline (or the board is truncated)"
      elif [ "$(jq -c '.cards' "${base}/board-${s}.json")" != "$(jq -c '.cards' "${work}/board-${s}.json")" ]; then
        row "board ${s}: card ids" OK "$(jq '.cards | length' "${base}/board-${s}.json") cards"
        row "board ${s}: lanes" REVIEW "some cards sit in another lane: show the owner, who decides"
      else
        row "board ${s}" OK "$(jq '.cards | length' "${base}/board-${s}.json") cards, same lanes"
      fi
    else
      row "board ${s}" FAIL "v5 'fy board --state ${s}' failed"
    fi
  done

  # Logins by name and secrets by NAME (never a value).
  : >"${work}/logins.raw"
  for f in "${H}"/config/logins/*.yaml; do
    [ -e "${f}" ] || continue
    basename "${f}" .yaml >>"${work}/logins.raw"
  done
  sort "${work}/logins.raw" >"${work}/logins.txt"
  if cmp -s "${base}/logins.txt" "${work}/logins.txt"; then row "logins" OK "$(wc -l <"${base}/logins.txt" | tr -d ' ') login files, same names"; else row "logins" FAIL "login names differ from the baseline"; fi
  # The listing stays in memory. v5 answers a damaged store with health "damaged" and no names, so an empty list proves nothing:
  # only a well-formed listing with health "ready" is compared (a zero-name baseline included).
  if secret_listing="$(fy5 secret ls --json)" && jq -e '.health == "ready" and (.secrets | type) == "array"' <<<"${secret_listing}" >/dev/null && jq -r '[.secrets[].name] | sort | .[]' <<<"${secret_listing}" >"${work}/secrets.txt"; then
    # Names the converter added (LOGIN_<ID>_<VAR>) are expected on top of the baseline; none may be missing.
    missing="$(comm -23 "${base}/secrets.txt" "${work}/secrets.txt")"
    if [ -z "${missing}" ]; then row "secret names" OK "$(wc -l <"${base}/secrets.txt" | tr -d ' ') baseline names present"; else row "secret names" FAIL "$(wc -l <<<"${missing}" | tr -d ' ') baseline names missing"; fi
  else
    row "secret names" FAIL "v5 'fy secret ls --json' failed, was unreadable, or says the store is not healthy"
  fi

  # Asks: the owner's count against v5's list.
  if fy5 ask >"${work}/ask.out"; then
    # Exactly the empty form (one line, "no asks are waiting"), else one header line and one line per ask.
    if [ "$(wc -l <"${work}/ask.out" | tr -d ' ')" = 1 ] && grep -qxE 'no asks are waiting.*' "${work}/ask.out"; then listed=0; else listed=$(($(wc -l <"${work}/ask.out") - 1)); fi
    if [ "${listed}" = "$(note_get ASKS_OPEN)" ]; then row "asks" OK "${listed} open, as the owner counted"; else row "asks" REVIEW "v5 lists ${listed}, the owner counted $(note_get ASKS_OPEN): show the owner"; fi
  else
    row "asks" FAIL "v5 'fy ask' failed"
  fi

  if fy5 doctor >"${work}/doctor.out" 2>&1; then row "fy doctor" OK "clean"; else
    row "fy doctor" FAIL "see the output below"
    cat "${work}/doctor.out"
  fi

  say "📝 verify (compare with the baseline in ${base})"
  {
    printf 'CHECK\tRESULT\tDETAIL\n'
    cat "${rows}"
  } | awk -F'\t' '{printf "%-34s %-8s %s\n", $1, $2, $3}'
  grep -q $'\tREVIEW\t' "${rows}" && say "⚠️ REVIEW rows are not failures: show them to the owner, who decides."
  [ "${bad}" = 0 ] || fail "verify found a difference (FAIL rows above): stop, tell the owner, offer the rollback"
  mark verified
  say "✅ verify: no FAIL row. By eye, with the owner: message one running ferret, resume one stopped ferret, open one card with history, reload the app on a phone"
  ;;

# ================================================================ rollback
rollback)
  H="$(note_get H)"
  B="$(note_get B)"
  kind="$(note_get KIND)"
  stamp="$(note_get STAMP)"
  base="$(note_get BASE)"
  v4_version="$(note_get V4_VERSION)"
  [ "${owner_yes}" = 1 ] || fail "tell the owner what a rollback costs: v4 returns exactly as it was at the backup; anything done in v5 since the start (messages, cards, asks, new ferrets, new secrets) stays whole in ${H}-v5-failed-${stamp} and is not in v4. With their yes pass --owner-yes"
  mark rolling-back

  # 1. Quiet first, then the daemon. The panes of the harnesses run in tmux whether or not any daemon does, so a quiet
  # window is established for every expected live pane EVERY time (a crashed or absent daemon is not an idle harness), and
  # nothing is moved until it is. Which daemon a live fyd is comes from the RECORDED state, never from the fy now on PATH.
  want_quiet=1
  if [ "$(note_get PANES)" = none ]; then want_quiet=0; fi
  rb_sock=""
  for cand in "${H}/state/terminals/tmux.sock" "${B}/tmux.sock" "${H}/tmux.sock"; do
    if [ -S "${cand}" ] && [ -z "${rb_sock}" ]; then rb_sock="${cand}"; fi
  done
  rb_quiet() { # $1 when: "before" or "after" the daemon stop
    [ "${want_quiet}" = 1 ] || return 0
    if [ -z "${rb_sock}" ]; then
      say "📝 no tmux socket found at ${H} or ${B}: there is no live pane to watch"
      return 0
    fi
    local qs=0
    quiet_check "${rb_sock}" || qs=$?
    case "${qs}" in
    0) say "📝 quiet ${1}: no pane wrote for 60 s" ;;
    1) fail "no quiet point ${1} (a pane kept writing): the owner messages no ferret and types into no pane; nothing was moved; run rollback again" ;;
    *) unreadable "tmux could not be read at ${rb_sock} (${1}): nothing was moved, because pane activity cannot be proven quiet" ;;
    esac
  }
  last_daemon="$(grep -E '^# (starting-v5|started-v5|v4-daemon-started)$' "${NOTES}" | tail -n 1)" || last_daemon=""
  if daemon_live; then
    case "${last_daemon}" in
    "# starting-v5" | "# started-v5")
      # The recorded state says the last daemon this script launched is v5. Only a v5 fy can stop it; without one, nothing is moved.
      ver=""
      if fy_try="$(v5_fy)" && out="$(v5_version "${fy_try}")"; then ver="${out}"; fi # fy absent or silent: not v5, refused below
      [[ ${ver} =~ ^5\. ]] || fail "a fyd process is running and the notes say it is the v5 daemon, but fy (${ver:-not found}) is not v5, so it cannot be stopped safely here. Nothing was moved: stop that daemon yourself, or bring the v5 programs back, then run rollback again"
      say "⚙️ a fyd process is running; the notes say it is the v5 daemon: reaching a quiet point, then stopping it (panes keep running)"
      rb_quiet before
      fy5 daemon stop || fail "'fy daemon stop' failed for the v5 daemon"
      rb_quiet after
      if daemon_live; then fail "a fyd process is still running after 'fy daemon stop': it cannot be proven that no v5 daemon owns ${H}; tell the owner"; fi
      say "📝 proven: no fyd process is running"
      ;;
    *)
      say "📝 a fyd process is running, and the notes record no v5 daemon launch after the last v4 start: it is the v4 daemon, left alone"
      rb_quiet before
      ;;
    esac
  else
    say "📝 proven: no fyd process is running"
    rb_quiet before
  fi

  # 2. Homes. Only move H aside when the backup exists (otherwise H still IS the v4 home).
  if [ -d "${B}" ]; then
    if [ -e "${H}" ]; then
      failed="${H}-v5-failed-${stamp}"
      [ ! -e "${failed}" ] || failed="${failed}-$$"
      mv "${H}" "${failed}" || fail "cannot move ${H} aside"
      chmod 700 "${failed}" || fail "chmod 700 ${failed} failed"
      say "📝 the v5 home was moved to ${failed} (nothing deleted; it holds copies of sealed files: the owner decides when to delete it)"
    fi
    mv "${B}" "${H}" || fail "cannot restore ${B} to ${H}"
  elif [ -e "${H}" ] && [ -f "${H}/layout-version" ]; then
    say "📝 no backup folder and ${H} is still a v4 home: nothing moved"
  else
    fail "there is no backup at ${B} and ${H} is not a v4 home: tell the owner, nothing was changed"
  fi
  [ -f "${H}/layout-version" ] || fail "${H}/layout-version is missing: the home is not v4"
  say "✅ home restored at ${H}"

  # 3. Programs, by recorded state. Skipped when v5 was never installed (v4 is still installed).
  if has_mark installing-v5; then
    case "$([ "$(note_get PKG_BEFORE)" = rehearsal ] && echo rehearsal || echo "${kind}")" in
    homebrew)
      casks="$(brew list --cask)" || fail "'brew list --cask' failed"
      has_v4cask=0 && has_main=0
      grep -qx 'ferretry@4' <<<"${casks}" && has_v4cask=1
      grep -qx 'ferretry' <<<"${casks}" && has_main=1
      if [ "${has_main}" = 1 ]; then brew uninstall --cask ferretry || fail "brew uninstall --cask ferretry failed"; fi
      if [ "${has_v4cask}" = 0 ]; then brew install --cask kirinnee/ferretry/ferretry@4 || fail "brew install --cask ferretry@4 failed"; fi
      ;;
    nix-profile)
      profile="$(nix profile list)" || fail "'nix profile list' failed"
      element="$(awk '/^(Name|Index):/ {el=$2} /[Ff]lake URL:/ && /github:kirinnee\/ferretry/ {print el; exit}' <<<"${profile}")"
      if [ -n "${element}" ] && ! grep -q "github:kirinnee/ferretry/v${v4_version}" <<<"${profile}"; then
        nix profile remove "${element}" || fail "nix profile remove ${element} failed"
        element=""
      fi
      if [ -z "${element}" ]; then
        add=add
        nix profile add --help >/dev/null 2>&1 || add=install
        nix profile "${add}" "github:kirinnee/ferretry/v${v4_version}" || fail "nix profile ${add} of v${v4_version} failed"
      fi
      ;;
    standalone)
      aside="${B}-bin"
      [ -x "${aside}/fy" ] && [ -x "${aside}/fyd" ] || fail "the v4 programs are not in ${aside}: there is no exact v4 to put back; tell the owner"
      for p in fy fyd fyd-browser-worker; do
        [ -f "${aside}/${p}" ] || continue
        target="$(grep "/${p}\$" "${aside}/paths.txt")" || fail "no recorded path for ${p}"
        cp -p "${aside}/${p}" "${target}" || fail "cannot restore ${target}"
      done
      ;;
    rehearsal) say "📝 a rehearsal build changed no installed package: nothing to restore" ;;
    manual | *)
      # The owner restores the v4 programs by hand; a rerun recognises it (fy AND fyd print 4.291.x) and goes on.
      v4_back=0
      if got_fy="$(v4_version_of "$(resolve "$(note_get ORIG_PATH)" fy)" 2>/dev/null)" && got_fyd="$(v4_version_of "$(resolve "$(note_get ORIG_PATH)" fyd)" 2>/dev/null)" && [[ ${got_fy} =~ ^4\.291\. ]] && [[ ${got_fyd} =~ ^4\.291\. ]]; then v4_back=1; fi
      [ "${v4_back}" = 1 ] || fail "restore the v4 programs (4.291.10 or later) by hand, the way this machine installs Ferretry, then run rollback again (the homes are already restored)"
      say "📝 the v4 programs are back (fy ${got_fy}, fyd ${got_fyd}): going on"
      ;;
    esac
  else
    say "📝 v5 was never installed: v4 is still installed"
  fi

  # 4. v4 again: ORIGINAL PATH and FY_URL exactly as recorded (never the shell's current ones).
  got="$(fy4 --version)" || fail "fy does not run with the recorded PATH"
  [[ ${got} =~ 4\.291\.[0-9]+ ]] || fail "fy --version prints '${got}', not 4.291.x: the v4 programs are not back"
  fy4 daemon start || fail "'fy daemon start' failed: if it says v4 is already running, run 'fy daemon restart'"
  mark v4-daemon-started

  ids=""
  if [ -f "${base}/restart-ids.txt" ] && [ -s "${base}/restart-ids.txt" ]; then ids="$(tr '\n' ' ' <"${base}/restart-ids.txt")"; fi
  if [ -z "${ids}" ]; then
    say "📝 no ferret was live at the baseline: nothing to restart"
  elif has_mark starting-v5 || has_mark started-v5; then
    if [ "${restart_ferrets}" = 1 ]; then
      # shellcheck disable=SC2086 # the ids are separate words, one per ferret
      fy4 restart ${ids} || fail "'fy restart ${ids}' failed"
      say "✅ restarted: ${ids}. Ask the owner to send one of them a message and see it answer"
    else
      say "⚠️ v5 may have restarted these ferrets with its own hooks. With the owner's yes, run: fy restart ${ids}  (or rerun rollback with --restart). Bare 'fy restart' only reports status."
    fi
  fi
  mark rolled-back
  say "✅ rolled back to v4 (${got}). The backup folder is now the live home; the v5 home, if any, is kept beside it"
  ;;
esac
