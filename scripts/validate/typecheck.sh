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
# The lock lives in the user's runtime directory (`$XDG_RUNTIME_DIR`, else
# `/tmp/<uid>`), is named after the product, and is held for the whole run. A run
# that finds it taken says who holds it, waits at most `TYPECHECK_LOCK_WAIT`
# seconds (600 by default), then runs anyway rather than failing a commit over a
# stuck neighbour. CI runs one check per job, so it never takes the lock; neither
# does a machine without `flock` (macOS ships none), which runs as before.
lock_wait="${TYPECHECK_LOCK_WAIT:-600}"
if [ -z "${CI:-}" ] && command -v flock >/dev/null 2>&1; then
  lock_dir="${XDG_RUNTIME_DIR:-/tmp/$(id -u)}"
  [ -d "${lock_dir}" ] || mkdir -m 700 "${lock_dir}"
  lock="${lock_dir}/$(jq -r '.name' package.json)-typecheck.lock"
  exec 9>>"${lock}"
  if ! flock -n 9; then
    echo "⏳ another typecheck holds ${lock} ($(cat "${lock}.holder" 2>/dev/null || echo 'holder unknown')); waiting up to ${lock_wait}s" >&2
    flock -w "${lock_wait}" 9 || echo "⚠️  the typecheck lock is still held after ${lock_wait}s; checking anyway" >&2
  fi
  echo "pid $$ in ${root_dir} since $(date -u +%Y-%m-%dT%H:%M:%SZ)" >"${lock}.holder"
fi

projects=(tsconfig.json)
while IFS= read -r project; do
  projects+=("${project}")
done < <(find packages -mindepth 2 -maxdepth 2 -name tsconfig.json | sort)

for project in "${projects[@]}"; do
  "${tsc}" --noEmit -p "${project}"
done

echo "✅ Typecheck passed: ${projects[*]}"
