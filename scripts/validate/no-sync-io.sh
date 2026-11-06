#!/usr/bin/env bash
set -euo pipefail

# Fails when daemon code gains a synchronous file call or `spawnSync` that the ledger does not list.
#
# WHY. The daemon's main thread answers every client, and a synchronous call holds it for as long as the
# disk takes. On 2026-11-05 the owner's daemon stalled for up to 61.9 s while swap saturated its disk; a
# synchronous `fsync` there had measured 38 s before. Async calls run on the runtime's I/O threads, so the
# loop keeps answering while the disk is slow.
#
# WHAT IS MATCHED. EVERY call — several on one line count several — of any `…Sync` function `node:fs` exports
# (the list is read from the runtime, so a new one cannot be missed), `spawnSync`, `execSync` or `execFileSync`,
# by name followed by `(` (spaces allowed between), on a line that is not a comment, in tracked TypeScript under
# `packages/daemon/src`, `packages/daemon/bin` and `packages/fleet/src` (the fleet library runs inside the
# daemon). Tests are out of scope. Prose that explains the rule names a function in backticks without its
# parenthesis. Importing one of those names UNDER ANOTHER NAME (`readFileSync as read`) is refused outright: the
# count is by spelling, and an alias is a spelling it cannot see.
#
# THE LEDGER (`scripts/validate/sync-io-allowlist.txt`) holds the exact count per file and the reason each
# remaining call may block. EXACT BOTH WAYS: more fails (a new blocking call), fewer fails too (lower the
# line), so the ledger is always the true inventory rather than a ceiling that drifts.
#
# Exit codes follow the repo convention: 0 clean, 1 a violation, 2 a broken gate.

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

ledger="scripts/validate/sync-io-allowlist.txt"
[ -f "${ledger}" ] || {
  echo "❌ the synchronous-IO ledger is missing: ${ledger}" >&2
  exit 2
}

# The runtime's own list of synchronous file functions, plus the three that start a child and wait for it.
fs_names="$(bun -e 'console.log(Object.keys(require("node:fs")).filter(name => /^[a-z][A-Za-z]*Sync$/.test(name)).join("|"))' 2>/dev/null)" || fs_names=''
case "${fs_names}" in
*existsSync*) ;;
*)
  echo "❌ could not read the synchronous function list from node:fs (is bun on PATH?)" >&2
  exit 2
  ;;
esac
names="${fs_names}|spawnSync|execSync|execFileSync"
# `[(]`, not an escaped parenthesis: the same text is an ERE for git grep and for awk, which reads escapes itself.
pattern="(^|[^A-Za-z0-9_\$])(${names})[[:space:]]*[(]"
alias_pattern="(^|[^A-Za-z0-9_\$])(${names})[[:space:]]+as[[:space:]]"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT

status=0
git grep -n -E "${pattern}" -- 'packages/daemon/src/**.ts' 'packages/daemon/bin/**.ts' 'packages/fleet/src/**.ts' \
  >"${tmp_dir}/hits.raw" 2>"${tmp_dir}/err" || status=$?
case "${status}" in
0 | 1) ;;
*)
  echo "❌ git grep failed (exit ${status}) while searching daemon code for synchronous IO:" >&2
  cat "${tmp_dir}/err" >&2
  exit 2
  ;;
esac

# `path:line:text` — keep a hit whose text is code, not a `//` or ` * ` comment line.
awk '{ text = $0; sub(/^[^:]*:[0-9]+:/, "", text); if (text !~ /^[[:space:]]*(\*|\/\/)/) print }' \
  "${tmp_dir}/hits.raw" >"${tmp_dir}/hits"
# Every CALL on a kept line, not the line: `existsSync(p) && readFileSync(p)` is two.
awk -v pattern="${pattern}" '{
  path = $0; sub(/:.*/, "", path)
  text = $0; sub(/^[^:]*:[0-9]+:/, "", text)
  calls[path] += gsub(pattern, "&", text)
} END { for (path in calls) print path, calls[path] }' "${tmp_dir}/hits" | sort >"${tmp_dir}/found"

if git grep -n -E "${alias_pattern}" -- 'packages/daemon/src/**.ts' 'packages/daemon/bin/**.ts' 'packages/fleet/src/**.ts' \
  >"${tmp_dir}/aliases" 2>/dev/null; then
  echo "❌ a synchronous file function is imported under another name, which this gate cannot count:" >&2
  sed 's/^/  /' "${tmp_dir}/aliases" >&2
  exit 1
fi

# The ledger: `<count> <path>  # …`, several lines per path summed.
awk '!/^[[:space:]]*(#|$)/ {
  if ($1 !~ /^[0-9]+$/ || $2 == "") { printf "malformed ledger line %d: %s\n", NR, $0 > "/dev/stderr"; bad = 1; next }
  sum[$2] += $1
} END { for (path in sum) print path, sum[path]; exit bad }' "${ledger}" | sort >"${tmp_dir}/allowed" || {
  echo "❌ ${ledger} has a malformed line (see above)" >&2
  exit 2
}

join -a 1 -a 2 -e 0 -o 0,1.2,2.2 "${tmp_dir}/found" "${tmp_dir}/allowed" >"${tmp_dir}/joined"
awk '$2 != $3' "${tmp_dir}/joined" >"${tmp_dir}/drift"

if [ -s "${tmp_dir}/drift" ]; then
  echo "❌ synchronous IO in daemon code does not match ${ledger}:" >&2
  while read -r path found allowed; do
    if [ "${found}" -gt "${allowed}" ]; then
      echo "  ${path}: ${found} blocking call(s), the ledger allows ${allowed}" >&2
      grep -F "${path}:" "${tmp_dir}/hits" | sed 's/^/      /' >&2
    else
      echo "  ${path}: ${found} blocking call(s) left, the ledger still says ${allowed} — lower it" >&2
    fi
  done <"${tmp_dir}/drift"
  cat >&2 <<'GUIDANCE'

The daemon's main thread answers every client; a synchronous file call holds all of them while the disk is
slow. Use `node:fs/promises` (or the descriptor helpers in packages/fleet/src/adapters/descriptor-io.ts), or
run the work on a worker thread. If the call truly cannot yield — boot, a CLI subcommand's own process, a
worker thread, a descriptor bracket — add or adjust its ledger line with the reason.
GUIDANCE
  exit 1
fi

echo "✅ daemon code holds exactly the synchronous IO its ledger declares ($(awk '{ s += $2 } END { print s + 0 }' "${tmp_dir}/found") calls)"
