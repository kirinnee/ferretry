#!/usr/bin/env bash
# Linux (Namespace) warm-store fast path for AtomiCloud/actions.setup-nix.
#
# On a Namespace Linux runner the cache volume persists /nix (store + db + the
# installer's own receipt). The VM itself is fresh, so everything the Determinate
# installer puts OUTSIDE /nix is gone: /etc/nix, /usr/local/bin/determinate-nixd, the
# nixbld users and the daemon process. Re-running the installer just to recreate those
# costs ~6s (download + "Provision Nix"). This script recreates them directly.
#
#   bootstrap  Verify the persisted store, recreate the out-of-/nix state, spawn the
#              daemon, export PATH. Prints `bootstrapped=true|false` to $GITHUB_OUTPUT.
#              Any failure rolls back everything it wrote and reports false, so the
#              caller falls back to the real installer.
#   flakehub-login  The FlakeHub login step of `bootstrap` on its own (tests).
#   capture    Run once after a real install: snapshot the installer's out-of-/nix
#              files into /nix/durian-bootstrap (on the cache volume) for `bootstrap`.
#   apply      Internal. The state-changing steps, run as a child process so `set -e`
#              really applies to every command (bash ignores errexit inside any
#              function called from an if/&&/|| context).
#
# Environment:
#   NIX_CONF            computed extra nix config (same text the installer receives)
#   MAX_AGE_DAYS        refuse a snapshot older than this and reinstall (default 7), so
#                       the Determinate Nix version still follows the installer's stable
#   FLAKEHUB_LOGIN      'false' skips the FlakeHub login (default 'true')
#   GITHUB_TOKEN_VALUE  optional; becomes `access-tokens = <server host>=...` like the
#                       installer action does
#   DURIAN_NIX_STATE_DIR / DURIAN_NIX_ETC_DIR / DURIAN_NIX_BIN_DIR override locations (tests)
set -euo pipefail

STATE_DIR="${DURIAN_NIX_STATE_DIR:-/nix/durian-bootstrap}"
ETC_DIR="${DURIAN_NIX_ETC_DIR:-/etc}"
BIN_DIR="${DURIAN_NIX_BIN_DIR:-/usr/local/bin}"
PROFILE="/nix/var/nix/profiles/default"
SOCKET="/nix/var/nix/daemon-socket/socket"
DETSYS_DIR="/nix/var/determinate"
DAEMON_LOG="${RUNNER_TEMP:-/tmp}/durian-nix-daemon.log"
MAX_AGE_DAYS="${MAX_AGE_DAYS:-7}"
# a typo, 1.5 or 08 must never make the eligibility predicate fail or be read as octal
case "$MAX_AGE_DAYS" in '' | *[!0-9]* | ??????*) MAX_AGE_DAYS=7 ;; esac
NIXBLD_GID=30000
NIXBLD_UID_BASE=30000
NIXBLD_COUNT=32
SELF="${BASH_SOURCE[0]}"

log() { echo "[warm-nix] $*"; }
emit() { [ -z "${GITHUB_OUTPUT:-}" ] || echo "$1" >>"$GITHUB_OUTPUT"; }

# Why the fast path cannot be used (read-only checks; nothing has been written yet).
unsuitable() {
  local f
  for f in determinate-nixd nix.conf stamp; do
    [ -e "$STATE_DIR/$f" ] || {
      echo "no snapshot ($f missing)"
      return 0
    }
  done
  [ -x "$STATE_DIR/determinate-nixd" ] || {
    echo "snapshot daemon not executable"
    return 0
  }

  local stamp now age
  stamp="$(cat "$STATE_DIR/stamp" 2>/dev/null || true)"
  case "$stamp" in '' | *[!0-9]*)
    echo "snapshot stamp unreadable"
    return 0
    ;;
  esac
  now="$(date +%s)"
  age=$((now - stamp))
  if [ "$age" -lt 0 ] || [ "$age" -gt $((10#$MAX_AGE_DAYS * 86400)) ]; then
    echo "snapshot is $((age / 86400)) days old (max ${MAX_AGE_DAYS})"
    return 0
  fi

  [ -d /nix/store ] || {
    echo "/nix/store missing"
    return 0
  }
  if [ ! -x "$PROFILE/bin/nix" ] || [ ! -x "$PROFILE/bin/nix-daemon" ]; then
    echo "default profile has no nix"
    return 0
  fi
  "$PROFILE/bin/nix" --version >/dev/null 2>&1 || {
    echo "persisted nix does not run on this machine"
    return 0
  }
  [ -f /nix/var/nix/db/db.sqlite ] || {
    echo "store db missing"
    return 0
  }
  if command -v sqlite3 >/dev/null 2>&1; then
    sudo sqlite3 /nix/var/nix/db/db.sqlite 'PRAGMA quick_check;' 2>/dev/null | grep -q '^ok$' ||
      {
        echo "store db failed quick_check"
        return 0
      }
  fi
  # Anything Nix-shaped already present (baked into the image, a half-finished earlier
  # attempt, an existing build-user setup) is the installer's business: it knows how to
  # detect, refuse or repair it. We only act on a pristine machine so that rollback can
  # safely remove exactly what we created.
  # (-L too: a dangling symlink is "absent" to -e but would be removed by rollback)
  if [ -e "$ETC_DIR/nix" ] || [ -L "$ETC_DIR/nix" ]; then
    echo "$ETC_DIR/nix already exists"
    return 0
  fi
  if [ -e "$BIN_DIR/determinate-nixd" ] || [ -L "$BIN_DIR/determinate-nixd" ]; then
    echo "$BIN_DIR/determinate-nixd already exists"
    return 0
  fi
  # Every name and numeric id we are about to create must be free (not just the first
  # build user), otherwise appending would duplicate entries and rollback would remove
  # someone else's.
  local i
  if getent group nixbld >/dev/null 2>&1 || getent group "$NIXBLD_GID" >/dev/null 2>&1; then
    echo "group nixbld / gid $NIXBLD_GID already exists"
    return 0
  fi
  for i in $(seq 1 "$NIXBLD_COUNT"); do
    if getent passwd "nixbld$i" >/dev/null 2>&1 || getent passwd "$((NIXBLD_UID_BASE + i))" >/dev/null 2>&1; then
      echo "user nixbld$i / uid $((NIXBLD_UID_BASE + i)) already exists"
      return 0
    fi
  done
  # Explicit verdict: a failure anywhere above must never read as "eligible".
  echo ELIGIBLE
  return 1
}

write_users() {
  # Same ids/names as nix-installer: group nixbld = 30000, users nixbld1..32 = 30001..
  local i members="" passwd="" shadow=""
  for i in $(seq 1 "$NIXBLD_COUNT"); do
    members="${members:+$members,}nixbld$i"
    passwd+="nixbld$i:x:$((NIXBLD_UID_BASE + i)):$NIXBLD_GID:Nix build user $i:/var/empty:/sbin/nologin"$'\n'
    shadow+="nixbld$i:!:19000:0:99999:7:::"$'\n'
  done
  printf 'nixbld:x:%s:%s\n' "$NIXBLD_GID" "$members" | sudo tee -a "$ETC_DIR/group" >/dev/null
  printf '%s' "$passwd" | sudo tee -a "$ETC_DIR/passwd" >/dev/null
  printf '%s' "$shadow" | sudo tee -a "$ETC_DIR/shadow" >/dev/null
  # gshadow is optional on some images
  if [ -e "$ETC_DIR/gshadow" ]; then
    printf 'nixbld:!::%s\n' "$members" | sudo tee -a "$ETC_DIR/gshadow" >/dev/null
  fi
}

remove_users() {
  # Exactly the entries write_users creates (names AND ids); the preflight guarantees that
  # none of them existed before, so nothing else can match. A preexisting nixbld99 or a
  # user literally named nixbld is never touched.
  local n='([1-9]|[12][0-9]|3[0-2])'
  [ ! -e "$ETC_DIR/passwd" ] || sudo sed -i -E "/^nixbld${n}:x:300(0[1-9]|[12][0-9]|3[0-2]):${NIXBLD_GID}:Nix build user /d" "$ETC_DIR/passwd" 2>/dev/null || true
  [ ! -e "$ETC_DIR/shadow" ] || sudo sed -i -E "/^nixbld${n}:!:19000:0:99999:7:::\$/d" "$ETC_DIR/shadow" 2>/dev/null || true
  [ ! -e "$ETC_DIR/group" ] || sudo sed -i -E "/^nixbld:x:${NIXBLD_GID}:nixbld1,/d" "$ETC_DIR/group" 2>/dev/null || true
  [ ! -e "$ETC_DIR/gshadow" ] || sudo sed -i -E "/^nixbld:!::nixbld1,/d" "$ETC_DIR/gshadow" 2>/dev/null || true
}

write_custom_conf() {
  local user tags
  user="$(id -un)"
  echo "# Written by AtomiCloud/actions.setup-nix (warm /nix bootstrap)."
  echo "# Mirrors what DeterminateSystems/nix-installer-action writes at install time."
  echo
  if [ -n "${GITHUB_TOKEN_VALUE:-}" ]; then
    tok_host="${GITHUB_SERVER_URL:-https://github.com}"
    tok_host="${tok_host#*://}"
    tok_host="${tok_host%%/*}"
    echo "access-tokens = ${tok_host:-github.com}=${GITHUB_TOKEN_VALUE}"
  fi
  echo "trusted-users = root ${user}"
  if command -v jq >/dev/null 2>&1; then
    tags="$(jq -cn --arg a "${GITHUB_WORKFLOW_REF:-}" --arg b "${GITHUB_WORKFLOW_SHA:-}" \
      --arg c "${GITHUB_SHA:-}" --arg d "${GITHUB_RUN_ATTEMPT:-}" --arg e "${GITHUB_RUN_ID:-}" \
      --arg f "${GITHUB_RUN_NUMBER:-}" --arg g "${GITHUB_JOB:-}" --arg h "${GITHUB_REF:-}" \
      --arg i "${GITHUB_REPOSITORY:-}" --arg j "${GITHUB_SERVER_URL:-}" \
      '{github_workflow_ref:$a,github_workflow_sha:$b,github_sha:$c,github_run_attempt:$d,github_run_id:$e,github_run_number:$f,github_job:$g,github_ref:$h,github_repository:$i,github_server_url:$j}
         | with_entries(select(.value != "")) + {builder:"github-actions"}')"
    echo "build-provenance-tags = ${tags}"
  fi
  printf '%s\n' "${NIX_CONF:-}"
}

install_files() {
  sudo mkdir -p "$ETC_DIR/nix" "$BIN_DIR"
  sudo install -m 0555 "$STATE_DIR/determinate-nixd" "$BIN_DIR/determinate-nixd"
  sudo install -m 0644 "$STATE_DIR/nix.conf" "$ETC_DIR/nix/nix.conf"
  if [ -f "$STATE_DIR/sentry-endpoint" ]; then
    sudo install -m 0644 "$STATE_DIR/sentry-endpoint" "$ETC_DIR/nix/sentry-endpoint"
  fi
  write_custom_conf | sudo tee "$ETC_DIR/nix/nix.custom.conf" >/dev/null
  sudo chmod 0644 "$ETC_DIR/nix/nix.custom.conf"
}

spawn_daemon() {
  # The persisted volume can carry sockets from the previous VM: a bare `-S` check would
  # pass instantly. Remove them, then wait for a real answer from the new daemon.
  sudo rm -f "$SOCKET" "$DETSYS_DIR/determinate-nixd.socket" "$DETSYS_DIR/determinate-nixd-logger.socket"
  # No systemd on these runners (same as the installer action's spawnDetached): detach
  # the daemon fully so it outlives this step. The log is opened by the runner user on
  # purpose (the redirect is not meant to be root's).
  : >"$DAEMON_LOG"
  # shellcheck disable=SC2024
  sudo setsid nohup "$BIN_DIR/determinate-nixd" daemon >>"$DAEMON_LOG" 2>&1 </dev/null &
  local i
  for i in $(seq 1 600); do
    if timeout 5 "$PROFILE/bin/nix" store info --store daemon >/dev/null 2>&1; then
      return 0
    fi
    # Gone already? (sudo exec's the daemon, so the pattern matches only the live one)
    if [ "$i" -gt 20 ] && ! pgrep -f "$BIN_DIR/determinate-nixd daemon" >/dev/null 2>&1; then
      echo "determinate-nixd exited" >&2
      return 1
    fi
    sleep 0.1
  done
  echo "timed out waiting for the nix daemon" >&2
  return 1
}

apply() {
  write_users
  install_files
  spawn_daemon
  "$PROFILE/bin/nix" --version >/dev/null
}

rollback() {
  log "rolling back"
  sudo pkill -f "$BIN_DIR/determinate-nixd daemon" 2>/dev/null || true
  sudo pkill -x nix-daemon 2>/dev/null || true
  sleep 0.2
  # Safe because bootstrap only starts on a machine where none of these existed.
  sudo rm -rf "$ETC_DIR/nix" "$BIN_DIR/determinate-nixd" "$SOCKET" \
    "$DETSYS_DIR/determinate-nixd.socket" "$DETSYS_DIR/determinate-nixd-logger.socket" 2>/dev/null || true
  remove_users
}

bootstrap() {
  local why rc=0
  why="$(unsuitable)" || rc=$?
  if [ "$rc" != 1 ] || [ "$why" != ELIGIBLE ]; then
    [ -n "$why" ] || why="eligibility check failed (status $rc)"
    log "fast path unavailable: ${why}; using the installer"
    emit "bootstrapped=false"
    return 0
  fi

  # Child process: errexit stays in force for every command inside `apply`.
  if ! bash "$SELF" apply; then
    log "::warning::warm bootstrap failed; falling back to the installer"
    [ ! -s "$DAEMON_LOG" ] || sed 's/^/[daemon] /' "$DAEMON_LOG" | tail -n 20
    rollback
    emit "bootstrapped=false"
    return 0
  fi

  {
    echo "/usr/local/bin"
    echo "$PROFILE/bin"
    echo "${HOME}/.nix-profile/bin"
  } >>"${GITHUB_PATH:-/dev/null}"

  flakehub_login

  # Determinate's KVM hint (best effort; only matters for kvm-feature builds).
  if [ -e /dev/kvm ]; then
    sudo chmod 0666 /dev/kvm 2>/dev/null || true
  fi
  if [ -r /dev/kvm ] && [ -w /dev/kvm ]; then
    echo "DETERMINATE_NIX_KVM=1" >>"${GITHUB_ENV:-/dev/null}"
  else
    echo "DETERMINATE_NIX_KVM=0" >>"${GITHUB_ENV:-/dev/null}"
  fi
  log "$("$PROFILE/bin/nix" --version) bootstrapped from the persisted store (no installer)"
  emit "bootstrapped=true"
}

# Same per-job FlakeHub login the installer action runs: only when the job has OIDC
# (`id-token: write`), and never when the caller turned it off with FLAKEHUB_LOGIN=false
# (`flakehub-login: 'false'`). A failed login never fails the job (as in the installer
# action); for a repo without FlakeHub access it fails after ~10-30s of retries.
flakehub_login() {
  if [ "${FLAKEHUB_LOGIN:-true}" = "false" ]; then
    log "FlakeHub login skipped (flakehub-login: false)"
  elif [ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ] && [ -n "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ]; then
    "$BIN_DIR/determinate-nixd" login github-action ||
      log "::warning::FlakeHub login failed (continuing, as the installer action does)"
  fi
  return 0
}

capture() {
  local tmp="$STATE_DIR.tmp.$$"
  if [ ! -x "$BIN_DIR/determinate-nixd" ] || [ ! -f "$ETC_DIR/nix/nix.conf" ]; then
    log "nothing to capture (installer output missing); next job will run the installer again"
    return 0
  fi
  sudo rm -rf "$tmp"
  sudo mkdir -p "$tmp"
  sudo cp "$BIN_DIR/determinate-nixd" "$tmp/determinate-nixd"
  sudo cp "$ETC_DIR/nix/nix.conf" "$tmp/nix.conf"
  if [ -f "$ETC_DIR/nix/sentry-endpoint" ]; then
    sudo cp "$ETC_DIR/nix/sentry-endpoint" "$tmp/sentry-endpoint"
  fi
  "$PROFILE/bin/nix" --version | sudo tee "$tmp/nix-version" >/dev/null
  date +%s | sudo tee "$tmp/stamp" >/dev/null
  sudo rm -rf "$STATE_DIR"
  sudo mv "$tmp" "$STATE_DIR"
  log "captured installer state for the next warm job: $(cat "$STATE_DIR/nix-version")"
}

case "${1:-}" in
bootstrap) bootstrap ;;
capture) capture ;;
apply) apply ;;
flakehub-login) flakehub_login ;;
*)
  echo "usage: $0 bootstrap|capture|flakehub-login" >&2
  exit 2
  ;;
esac
