#!/usr/bin/env bash
set -euo pipefail

# Fails when daemon code gains a synchronous file call or `spawnSync` that the ledger does not list.
#
# WHY. The daemon's main thread answers every client, and a synchronous call holds it for as long as the
# disk takes. On 2026-11-05 the owner's daemon stalled for up to 61.9 s while swap saturated its disk; a
# synchronous `fsync` there had measured 38 s before. Async calls run on the runtime's I/O threads, so the
# loop keeps answering while the disk is slow.
#
# WHAT IS MATCHED. A call of any `node:fs` `…Sync` function, `spawnSync`, `execSync` or `execFileSync`, by
# name followed by `(`, on a line that is not a comment, in tracked TypeScript under `packages/daemon/src`,
# `packages/daemon/bin` and `packages/fleet/src` (the fleet library runs inside the daemon). Tests are out
# of scope. Prose that explains the rule names a function in backticks without its parenthesis.
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

names='readFileSync|writeFileSync|appendFileSync|statSync|lstatSync|fstatSync|existsSync|accessSync'
names+='|readdirSync|opendirSync|mkdirSync|mkdtempSync|rmdirSync|rmSync|renameSync|unlinkSync|copyFileSync|cpSync'
names+='|openSync|readSync|writeSync|closeSync|fsyncSync|fdatasyncSync|ftruncateSync|truncateSync'
names+='|chmodSync|fchmodSync|chownSync|fchownSync|utimesSync|futimesSync'
names+='|realpathSync|readlinkSync|symlinkSync|linkSync|spawnSync|execSync|execFileSync'
pattern="(^|[^A-Za-z0-9_\$])(${names})\("

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
cut -d ':' -f 1 "${tmp_dir}/hits" | sort | uniq -c | awk '{ print $2, $1 }' | sort >"${tmp_dir}/found"

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
