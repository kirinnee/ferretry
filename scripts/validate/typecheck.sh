#!/usr/bin/env bash
set -euo pipefail

# Typecheck every workspace project.
#
# The root includes core/plugin app halves and their app tests, with React JSX
# and the same DOM libraries as packages/app. The shell itself is checked against
# its own config. Any other package carrying a tsconfig is checked too, at any
# depth. Pending app ports have explicit, documented exclusions in tsconfig.json.
#
# EVERY WORKSPACE PACKAGE IS CHECKED, and that is proved rather than assumed: a
# package (from the root manifest's `workspaces` globs) with no tsconfig of its own
# must have its TypeScript files in the root project's file list, so a new package
# that no project includes fails here instead of going unchecked.

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
# That validation is BEST EFFORT and deliberately small: it checks the leaf only, and
# the lock is opened by path with `exec 9>>"$lock"` — an append-open, which writes
# no byte and cannot truncate. The script writes NOTHING into the lock directory (no
# holder note). A lock path that is a symlink or anything but a regular file (a FIFO
# would block the open forever, a dangling link would have its target created) is
# refused BEFORE the open, with a warning and an unlocked run.
#
# Residual, accepted: that check-then-open gap, like the directory check itself, can
# only be exploited by someone who can write in (or swap) the user-owned 0700
# directory — in practice the user, or an owner of a parent directory. At worst they
# defeat serialization (two checks at once — the behaviour before this lock existed),
# make the open block, or leave an empty file created; they can never truncate or
# write to an existing file.
#
# The wait is bounded: at most `TYPECHECK_LOCK_WAIT` seconds (600 by default), then
# the check runs anyway rather than failing a commit over a stuck neighbour. CI runs
# one check per job, so it never takes the lock; neither does a machine without
# `flock` (macOS ships none), which runs as before.
#
# A check started from inside a locked one (a hook calling a hook) inherits
# descriptor 9, an open file description the ancestor already holds the lock on. If
# descriptor 9 is open AND is the same file as the lock, this run reuses it, and
# `flock -n 9` succeeds at once because flock locks belong to the description. No
# environment marker is involved, so a descendant that closed descriptor 9 simply
# opens the lock fresh and waits like anyone else.
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

# Prints "device:inode" of what "$1" resolves to; fails when it does not exist.
file_id() {
  stat -L -c '%d:%i' "$1" 2>/dev/null || stat -L -f '%d:%i' "$1" 2>/dev/null
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
    echo '⚠️  no trusted per-user directory for the typecheck lock (need an own-only directory under XDG_RUNTIME_DIR or ~/.cache, and a package name); checking without it' >&2
  else
    lock="${lock_dir}/${product}-typecheck.lock"
    have_lock_fd=0
    fd9_id="$(file_id /dev/fd/9)" || fd9_id=""
    lock_id="$(file_id "${lock}")" || lock_id=""
    if [ -n "${fd9_id}" ] && [ "${fd9_id}" = "${lock_id}" ]; then
      have_lock_fd=1 # an ancestor's open lock descriptor, inherited
    elif [ -L "${lock}" ] || { [ -e "${lock}" ] && [ ! -f "${lock}" ]; } || ! { exec 9>>"${lock}"; } 2>/dev/null; then
      echo "⚠️  cannot open the typecheck lock ${lock}; checking without it" >&2
    else
      have_lock_fd=1
    fi
    if [ "${have_lock_fd}" = 1 ] && ! flock -n 9; then
      echo "⏳ waiting for another typecheck on this machine (up to ${lock_wait} s)" >&2
      flock -w "${lock_wait}" 9 || echo "⚠️  the typecheck lock is still held after ${lock_wait} s; checking anyway" >&2
    fi
  fi
fi

# The hosts import the git-ignored generated registries, so they are regenerated before anything is checked.
./scripts/local/gen.sh

# The repository's own Bun scripts (gates, CI helpers, release tooling) are a project of their own.
# scripts/gen (the registry generator and the 5.0 checks) is its own project, with its own includes.
projects=(tsconfig.json scripts/tsconfig.json scripts/gen/tsconfig.json)
while IFS= read -r project; do
  projects+=("${project}")
done < <(find packages -path '*/node_modules' -prune -o -name tsconfig.json -print | sort)

mapfile -t workspace_packages < <(
  jq -r '.workspaces[]' package.json | while IFS= read -r glob; do
    for dir in ${glob}; do [ -f "${dir}/package.json" ] && printf '%s\n' "${dir}"; done
  done | sort -u
)
[ "${#workspace_packages[@]}" -eq 0 ] && echo "❌ no workspace packages found from package.json workspaces" >&2 && exit 1
root_files="$("${tsc}" -p tsconfig.json --listFilesOnly | sed "s#^${root_dir}/##")"
# Check every app source, not merely the first source in its workspace package.
# A checked manifest must never hide an unchecked TSX view in that same package.
printf '%s\n' "${root_files}" | bun scripts/validate/typecheck-apps.ts
uncovered=()
for package in "${workspace_packages[@]}"; do
  [ -f "${package}/tsconfig.json" ] && continue
  # App sources have just been checked individually, including the exact pending-port exceptions.
  # Use a non-app source for the package-level proof, so an explicitly pending app/index.ts is not
  # mistaken for an entirely unchecked package. A new unchecked app file fails the check above.
  sources="$(git ls-files -co --exclude-standard -- "${package}/*.ts" "${package}/*.tsx" |
    awk '$0 !~ /^packages\/(core|plugins)\/[^/]+\/(app\/|tests\/(unit|support)\/app\/)/' | sed -n 1p)"
  [ -z "${sources}" ] && continue
  grep -qxF -- "${sources}" <<<"${root_files}" || uncovered+=("${package} (${sources})")
done
if [ "${#uncovered[@]}" -gt 0 ]; then
  echo "❌ these workspace packages are in no typecheck project (add a tsconfig.json, or include them in the root):" >&2
  printf '   %s\n' "${uncovered[@]}" >&2
  exit 1
fi

for project in "${projects[@]}"; do
  if [[ -n ${FY_TSC_CACHE_DIR:-} ]]; then
    mkdir -p "${FY_TSC_CACHE_DIR}"
    cache_name=${project//\//-}
    "${tsc}" --noEmit --incremental --tsBuildInfoFile "${FY_TSC_CACHE_DIR}/${cache_name}.tsbuildinfo" -p "${project}"
  else
    "${tsc}" --noEmit -p "${project}"
  fi
done

echo "✅ Typecheck passed: ${projects[*]} (covering ${#workspace_packages[@]} workspace packages)"
