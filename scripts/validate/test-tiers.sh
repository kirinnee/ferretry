#!/usr/bin/env bash
set -euo pipefail

# THE TEST TIERS HOLD THEIR LINE (docs/standards/testing/index.md, "The tiers").
#
# A test's tier is decided by where it lives, and each tier makes a promise the pull-request gate
# relies on. The promise this script can hold from the outside is the integration tier's: its outcome
# is deterministic, so it never asserts that something was fast enough, small enough or rare enough on
# THIS machine, and it never hands a server a port it guessed. Such a timing claim is real and worth
# keeping, but it belongs in the realworld tier, which is non-blocking and files an issue instead of
# failing a merge. Four checks:
#
#   1. every `*.test.ts(x)` lives under tests/{unit,integration,realworld,sit,contract,e2e}/ of a
#      package, so Bun's tiers (bunfig.*.toml) and the CI groups see every test exactly once;
#   2. nothing under tests/integration/ asserts an UPPER bound on elapsed time or on memory;
#   3. config/test-groups.json names only tiers `scripts/ci/test.sh` runs, and every group and every
#      prefix of it still matches a test file of its tier;
#   4. no test or local bench defines or calls a probe-then-close port helper (`freeLoopbackPort`,
#      a `freePort` definition): a daemon is given `port: 0` and its recorded port is read back (`recordedPort`).
#
# It also counts the unit tier's `unitClock.useRealTime(` escapes and refuses one with no reason, so a
# reviewer sees the number grow. The unit tier's timing rules themselves are enforced where they run,
# by the unit preload (packages/daemon/tests/support/unit-determinism.ts).
#
# An upper bound is the claim that depends on the machine; a LOWER bound (a timer really waited at least
# its interval) cannot fail because a machine was slow, so it stays. A `Math.abs(...)` difference is a
# clock-skew sanity check between two clocks, not a speed claim, and is not flagged either.

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

failures=0
refuse() {
  echo "❌ $*" >&2
  failures=$((failures + 1))
}

all_tests() {
  git ls-files --cached --others --exclude-standard -- 'packages/*.test.ts' 'packages/*.test.tsx' | sort -u |
    while IFS= read -r file; do [[ -f ${file} ]] && echo "${file}"; done
}

mapfile -t tests < <(all_tests)
[[ ${#tests[@]} -ge 100 ]] || {
  echo "❌ found only ${#tests[@]} test files; the extraction is stale" >&2
  exit 1
}

# ─── 1. every test lives in a tier ──────────────────────────────────────────────────────────────

tier_dirs='unit|integration|realworld|sit|contract|e2e'
for file in "${tests[@]}"; do
  [[ ${file} =~ ^packages/[^/]+/tests/(${tier_dirs})/ ]] ||
    refuse "${file}: a test file must live under packages/<pkg>/tests/{${tier_dirs//|/,}}/; unit and integration are the blocking tiers, realworld holds what depends on the machine"
done

# ─── 2. no wall-clock or memory upper bound in the integration tier ────────────────────────────

upper='\.(below|belowOrEqual|lessThan|lessThanOrEqual)\(|toBeLessThan(OrEqual)?\('
claims=(
  # a clock difference fed to an upper bound
  "(performance\\.now\\(\\)|Date\\.now\\(\\)).*(${upper})"
  # a named duration fed to an upper bound
  "(should|expect)\\(\\s*\\w*(elapsed|took|duration|latency)\\w*[^)]*\\)\\.(be\\.|not\\.)?(${upper#\\.})"
  # a resident-memory budget
  "(rss|heapUsed|memoryUsage|addedMb|residentMb)[^;]*(${upper})"
)
mapfile -t integration < <(printf '%s\n' "${tests[@]}" | rg '^packages/[^/]+/tests/integration/' || true)
for pattern in "${claims[@]}"; do
  for file in "${integration[@]}"; do
    hits="$(rg -n -i -e "${pattern}" "${file}" | rg -v 'Math\.abs\(' || true)"
    [[ -n ${hits} ]] || continue
    while IFS= read -r hit; do
      refuse "${file}:${hit%%:*}: asserts a wall-clock or memory upper bound (${hit#*:}); move the claim to ${file/\/integration\//\/realworld\/} (the realworld tier) and keep the deterministic part here"
    done <<<"${hits}"
  done
done

# ─── 3. config/test-groups.json agrees with the tiers ───────────────────────────────────────────

groups="config/test-groups.json"
# The tiers `scripts/ci/test.sh` accepts a group for, and the directories each leaves out (see its `find`).
declare -A excluded=(
  [unit]='/tests/(integration|sit|realworld)/'
  [int]='/tests/(unit|sit|realworld)/'
)
for tier in $(jq -r 'keys[] | select(. != "schemaVersion")' "${groups}"); do
  [[ -n ${excluded[${tier}]:-} ]] || {
    refuse "${groups}: '${tier}' is not a tier with test groups (unit and int are); realworld has none, SIT runs whole"
    continue
  }
  tier_files="$(printf '%s\n' "${tests[@]}" | rg -v -- "${excluded[${tier}]}" || true)"
  # test.sh gives a file to the FIRST group with a prefix of it, so a group that wins no file would hold
  # none and fail its run; a prefix no file starts with is dead text that hides a move.
  while IFS= read -r problem; do
    [[ -n ${problem} ]] && refuse "${groups}: ${tier} ${problem}; delete or fix it (a prefix that moved with its tests?)"
  done < <(jq -n -r --rawfile files <(printf '%s' "${tier_files}") --slurpfile config "${groups}" --arg tier "${tier}" '
    ($files | split("\n") | map(select(. != ""))) as $files
    | $config[0][$tier] as $groups
    | ($groups | to_entries[]) as $entry
    | $entry.value as $group
    | (
        ($group.prefixes[] | select(. as $prefix | $files | any(startswith($prefix)) | not)
          | "group \"\($group.name)\" has the prefix \"\(.)\", which no \($tier)-tier test file starts with"),
        (if ($files | map(select(. as $file
              | ([$groups[] | select(any(.prefixes[]; . as $prefix | $file | startswith($prefix)))][0].name) == $group.name)) | length) == 0
         then "group \"\($group.name)\" owns no \($tier)-tier test file" else empty end)
      )')
done

# A group's "processes" (scripts/ci/test.sh runs its files in that many isolated bun processes inside its
# one runner) is the owner's last resort, so it is bounded: an integer from 2 to 4, and only for int.
while IFS= read -r problem; do
  [[ -n ${problem} ]] && refuse "${groups}: ${problem}"
done < <(jq -r 'to_entries[] | select(.key != "schemaVersion") | .key as $tier | .value[] | select(has("processes")) |
  if ($tier != "int") then "\($tier) group \"\(.name)\" sets processes; only int groups may run several processes"
  elif ((.processes | type) != "number" or .processes != (.processes | floor) or .processes < 2 or .processes > 4)
  then "int group \"\(.name)\" has processes \(.processes); it must be an integer from 2 to 4"
  else empty end' "${groups}")

# ─── 4. no guessed ports ────────────────────────────────────────────────────────────────────────

# Binding port 0, reading the number and closing the socket leaves a window in which another process
# can take the port before the daemon binds it. The daemon asks the OS itself (`"port": 0` in
# config/daemon.json) and records what it got; a server the test starts binds port 0 and reads .port.
# This covers only the test trees and the local benches: a PRODUCT adapter that must hand a number to
# Chrome's remote-debugging flag (src/adapters/browser/...) is not a test fixture, and the pages-dev and
# Safari harnesses wrap binaries (wrangler, safaridriver) that have no way to report a port they chose.
# A DEFINITION of `freePort` is the probe helper; a stub or a call of the product's own `freePort` adapter
# member (login-window, login-runtime) is not. The one definition left is start-over.test.ts: a child
# process it spawns binds the callback port, and the service under test is configured with that number.
guessed='\bfreeLoopbackPort\b|\b(function|const|let)[[:space:]]+freePort\b'
allowed='packages/daemon/tests/integration/fleet-login/start-over.test.ts'
while IFS=: read -r file line _; do
  [[ -n ${file} && ${file} != "${allowed}" ]] || continue
  refuse "${file}:${line}: a probe-then-close port helper races the daemon's bind; write \"port\": 0 and read the bound port with recordedPort(home) (packages/daemon/tests/integration/support/os-port.ts), or bind Bun.serve port 0"
done < <(rg -n --no-heading -e "${guessed}" --glob 'packages/*/tests/**' --glob 'scripts/local/**' packages scripts/local || true)

# ─── the unit tier's real-time escapes ──────────────────────────────────────────────────────────

# Each call names why it needs the real clock; the reviewer reads the list, and the count only grows on purpose.
real_time=0
while IFS=: read -r file line _; do
  [[ -n ${file} ]] || continue
  # The call's arguments, which may continue over a few lines.
  joined="$(sed -n "${line},$((line + 4))p" "${file}" | tr '\n' ' ')"
  args="${joined#*unitClock.useRealTime(}"
  args="${args%%)*}"
  reason="$(sed -E "s/^[[:space:]]*(['\"\`])(.*)\1[[:space:]]*,?[[:space:]]*\$/\2/" <<<"${args}")"
  real_time=$((real_time + 1))
  if [[ -z ${reason//[[:space:]]/} ]]; then
    refuse "${file}:${line}: unitClock.useRealTime() needs a reason: say why this unit test cannot use the fake clock"
  else
    echo "  real time: ${file}:${line}: ${reason}"
  fi
done < <(rg -n --no-heading 'unitClock\.useRealTime\(' --glob 'packages/*/tests/unit/**' packages || true)
echo "unitClock.useRealTime( calls in the unit tier: ${real_time}"

if [[ ${failures} -gt 0 ]]; then
  echo "❌ ${failures} test-tier violation(s)" >&2
  exit 1
fi
echo "✅ test tiers hold: ${#tests[@]} test files in a tier, no integration timing or memory bound, groups match their files, no guessed ports"
