#!/usr/bin/env bash
set -euo pipefail

# Typecheck every workspace project.
#
# The workspace is NOT one program. `packages/pwa` is browser code and needs the
# DOM lib; every other package is a Node/Bun program that must NOT be able to
# reach for `document` by accident. One `tsc --noEmit` over the whole tree would
# have to hand the DOM to all of them, so the root project excludes the PWA and
# the PWA is checked against its own config instead.

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

tsc="./node_modules/.bin/tsc"
[ ! -x "${tsc}" ] && echo "❌ typescript is not installed: ${tsc}" >&2 && exit 1

# ONE TYPECHECK AT A TIME ON THIS MACHINE.
#
# A `tsc` over this workspace peaks at about 4.5 GB (2026-11-06, Linux x64), and
# the pre-commit hook runs this script on every commit. A machine running many
# agents in many worktrees commits from several of them at once, and N checks side
# by side held N × 2–4.5 GB of the same user's memory budget — enough to push
# the daemon itself into reclaim and swap. So a run takes a per-user lock first
# and the others queue behind it. Queueing costs a commit tens of seconds; the
# memory it saves is what kept the machine answering.
#
# The lock lives in a directory only this user can write: `$XDG_RUNTIME_DIR`, else
# `${XDG_CACHE_HOME:-$HOME/.cache}/ferretry` (created 0700). Never a predictable
# path in a shared `/tmp`, where another user could pre-create the directory and
# plant links in it. A directory is used only if it is a real directory (not a
# symlink), owned by this user, and not group/other-writable; if none qualifies the
# check runs WITHOUT the lock and says why — a commit is never failed over the lock.
#
# The lock is named after the product and held for the whole run. A run that finds
# it taken says who holds it, waits at most `TYPECHECK_LOCK_WAIT` seconds (600 by
# default), then runs anyway rather than failing a commit over a stuck neighbour.
# After acquiring, the run exports `FY_TYPECHECK_LOCK_HELD=<lock path>`, so a check
# started from inside this one (a hook calling a hook) does not queue behind its
# own ancestor. A run that gave up waiting never claims the lock. CI runs one check
# per job, so it never takes the lock; neither does a machine without `flock`
# (macOS ships none), which runs as before.
lock_wait="${TYPECHECK_LOCK_WAIT:-600}"

# Succeeds when "$1" is a directory only this user can write, creating it (0700)
# if it is absent. A concurrent first run creating it too is expected, not an error.
trusted_lock_dir() {
  local candidate="$1"
  [ -n "${candidate}" ] || return 1
  if [ ! -e "${candidate}" ] && [ ! -L "${candidate}" ]; then
    mkdir -p "$(dirname "${candidate}")" 2>/dev/null || true
    mkdir -m 700 "${candidate}" 2>/dev/null || true
  fi
  [ -d "${candidate}" ] && [ ! -L "${candidate}" ] && [ -O "${candidate}" ] || return 1
  [ -z "$(find "${candidate}" -maxdepth 0 \( -perm -020 -o -perm -002 \) 2>/dev/null)" ]
}

if [ -z "${CI:-}" ] && command -v flock >/dev/null 2>&1; then
  lock_dir=""
  for candidate in "${XDG_RUNTIME_DIR:-}" "${HOME:+${XDG_CACHE_HOME:-${HOME}/.cache}/ferretry}"; do
    if trusted_lock_dir "${candidate}"; then
      lock_dir="${candidate}"
      break
    fi
  done
  product="$(jq -r '.name // empty' package.json 2>/dev/null)" || product=""

  if [ -z "${lock_dir}" ] || [ -z "${product}" ]; then
    echo "⚠️  no trusted per-user directory for the typecheck lock (need an own-only directory under \$XDG_RUNTIME_DIR or \$HOME/.cache, and a package name); checking without it" >&2
  else
    lock="${lock_dir}/${product}-typecheck.lock"
    holder="${lock}.holder"
    if [ "${FY_TYPECHECK_LOCK_HELD:-}" = "${lock}" ]; then
      : # an ancestor of this run already holds this lock and is waiting on us
    elif [ -L "${lock}" ] || ! { exec 9>>"${lock}"; } 2>/dev/null; then
      echo "⚠️  cannot open the typecheck lock ${lock}; checking without it" >&2
    else
      acquired=1
      if ! flock -n 9; then
        holder_note="holder unknown"
        if [ ! -L "${holder}" ] && [ -f "${holder}" ]; then
          holder_note="$(cat "${holder}" 2>/dev/null)" || holder_note="holder unknown"
        fi
        echo "⏳ another typecheck holds ${lock} (${holder_note}); waiting up to ${lock_wait}s" >&2
        if ! flock -w "${lock_wait}" 9; then
          acquired=0
          echo "⚠️  the typecheck lock is still held after ${lock_wait}s; checking anyway" >&2
        fi
      fi
      if [ "${acquired}" = 1 ]; then
        # Replace the holder note by rename, so a link planted at its name is
        # replaced rather than written through.
        if printf 'pid %s in %s since %s\n' "$$" "${root_dir}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"${holder}.$$" 2>/dev/null; then
          mv -f "${holder}.$$" "${holder}" 2>/dev/null || rm -f "${holder}.$$"
        fi
        export FY_TYPECHECK_LOCK_HELD="${lock}"
      fi
    fi
  fi
fi

projects=(tsconfig.json)
while IFS= read -r project; do
  projects+=("${project}")
done < <(find packages -mindepth 2 -maxdepth 2 -name tsconfig.json | sort)

for project in "${projects[@]}"; do
  "${tsc}" --noEmit -p "${project}"
done

echo "✅ Typecheck passed: ${projects[*]}"
