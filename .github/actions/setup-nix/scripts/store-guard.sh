#!/usr/bin/env bash
# store-guard.sh: keep a Namespace cache volume that holds /nix usable when it is shared
# (setup-nix runs it on Namespace Linux only).
#
#   store-guard.sh start   after Nix is available, before any dev shell runs
#   store-guard.sh end     end of job, on success (setup-nix's post hook)
#
# Namespace commits a job's copy of the volume whenever the job succeeds (last write wins),
# and a generation larger than the configured size is not cloned: the next job on the tag
# starts from an EMPTY volume. Nothing here can stop or gate a commit (only runs-on labels
# can); it warns before the limit and points at jobs whose commits add nothing. It never
# deletes anything: freeing space is the caller's job (e.g. their own `nix store gc`).
#
# The size of the volume is read from the machine (the filesystem mounted at /nix, i.e. the
# cache volume the job's nscloud-cache-size-NNgb label sized), not from an input. When /nix
# is not a volume of its own (self-hosted, GitHub-hosted), no size is known and the size
# warnings are skipped.
#
# Environment (all optional):
#   IDLE_COMMIT_NOTICE_MINUTES  end: notice when the job changed nothing in /nix and ran at
#                             least this many minutes (default 0 = always; off = never)
#   STORE_GUARD_STATE         state file shared by start and end (default $RUNNER_TEMP/...)
#   STORE_GUARD_USED_BYTES    tests only: pretend /nix uses this many bytes
#   STORE_GUARD_SIZE_BYTES    tests only: pretend the volume is this many bytes ('' = unknown)
#
# Never fails the job: every problem is a warning and exit 0.
set -uo pipefail

state="${STORE_GUARD_STATE:-${RUNNER_TEMP:-/tmp}/durian-store-guard.state}"
devshell_dir="${DURIAN_SHELL_DIR:-/nix/durian-shell}"

log() { echo "[store-guard] $*"; }
gib() { awk -v b="$1" 'BEGIN { printf "%.1f GiB", b / 1073741824 }'; }

used_bytes() {
  if [ -n "${STORE_GUARD_USED_BYTES:-}" ]; then
    echo "$STORE_GUARD_USED_BYTES"
    return 0
  fi
  df -B1 --output=used /nix 2>/dev/null | tail -n1 | tr -d ' '
}

# Bytes of the volume mounted at /nix; empty when /nix is not a mount of its own.
volume_bytes() {
  if [ "${STORE_GUARD_SIZE_BYTES+x}" = x ]; then
    echo "$STORE_GUARD_SIZE_BYTES"
    return 0
  fi
  local target
  target="$(findmnt -n -o TARGET --target /nix 2>/dev/null | head -n1)"
  [ "$target" = "/nix" ] || return 0
  df -B1 --output=size /nix 2>/dev/null | tail -n1 | tr -d ' '
}

# What a commit of this job would change: the store's entries and the cached dev shells.
fingerprint() {
  {
    find /nix/store -mindepth 1 -maxdepth 1 -printf '%f\n' 2>/dev/null | LC_ALL=C sort | sha256sum
    find "$devshell_dir" \( -name '*.sh' -o -name '*.nocache' -o -name '*.root' \) -printf '%P %l\n' 2>/dev/null | LC_ALL=C sort | sha256sum
  } | sha256sum | cut -c1-32
}

size_report() {
  local used="$1" when="$2" limit pct
  limit="$(volume_bytes)"
  case "$limit" in '' | *[!0-9]*) limit=0 ;; esac
  if [ -z "$used" ] || [ "$limit" -le 0 ]; then
    log "volume size unknown (/nix is not a volume of its own): no size warning"
    return 0
  fi
  pct=$((used * 100 / limit))
  if [ "$used" -ge "$limit" ]; then
    echo "::error title=Nix cache volume over its size::/nix uses $(gib "$used") of the $(gib "$limit") cache volume ($pct%, $when). Namespace still commits this copy but will not clone it: the NEXT job on this cache tag starts from an EMPTY volume (full Nix install and store download). Free space (nix store gc), raise the nscloud-cache-size-NNgb label, or split the tag."
  elif [ "$pct" -ge 85 ]; then
    echo "::warning title=Nix cache volume nearly full::/nix uses $(gib "$used") of the $(gib "$limit") cache volume ($pct%, $when). At the full size the next job on this cache tag starts from an EMPTY volume. Free space (nix store gc) or raise the nscloud-cache-size-NNgb label."
  else
    log "/nix uses $(gib "$used") of $(gib "$limit") ($pct%, $when)"
  fi
}

case "${1:-}" in
start)
  printf '%s %s\n' "$(date +%s)" "$(fingerprint)" >"$state" 2>/dev/null || true
  size_report "$(used_bytes)" "job start"
  ;;
end)
  size_report "$(used_bytes)" "end of job, about to be committed"
  min="${IDLE_COMMIT_NOTICE_MINUTES:-0}"
  [ "$min" != off ] || exit 0
  case "$min" in '' | *[!0-9]*) min=0 ;; esac
  min=$((10#$min))
  [ -f "$state" ] || exit 0
  read -r started fp <"$state" || exit 0
  [ -n "${fp:-}" ] || exit 0
  mins=$((($(date +%s) - started) / 60))
  if [ "$(fingerprint)" = "$fp" ] && [ "$mins" -ge "$min" ]; then
    echo "::notice title=Cache volume commit adds nothing::This job changed nothing in /nix, but Namespace will still commit its copy of the cache volume when it succeeds. That copy was cloned ${mins} min ago, so it can overwrite newer dev shells and store paths other jobs on this cache tag committed meanwhile (last write wins). If this job never needs to store anything, add the runs-on label nscloud-cache-exp-do-not-commit (keep at least one job per workflow committing)."
  fi
  ;;
*)
  echo "usage: store-guard.sh start|end" >&2
  ;;
esac
exit 0
