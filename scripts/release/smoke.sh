#!/usr/bin/env bash
set -euo pipefail

# Smoke-test one target's standalone binaries: every executable the CLI package (`fy`) and the daemon
# host (the kernel package, `fyd`) declare is present beside the CLI binary with the same target suffix,
# loads on this platform, and answers `--version` with exit 0.
#
# FERRETRY 5.0, DAY 1: the hosts are stubs (packages/cli/bin/fy.ts, packages/core/kernel/host/fyd.ts), so
# this is the LAUNCH stage only — it proves the compiled bytes run on the target, which is what a broken
# cross-compile or a missing embedded addon breaks first. The 4.x smoke also drove the first-session
# journey (`daemon start` through the supervisor, `daemon import claude` into a fake harness, a session to
# running and back, `fyd --check` starting every worker and the WebRTC engine — guarantee R689). That stage
# returns here as `fy`/`fyd` gain those verbs; the 4.x script is in the reference tree at
# scripts/release/smoke.sh.
#
# Usage: smoke.sh <cli-binary>
bin="${1:?Usage: smoke.sh <cli-binary>}"

# Every name comes from the packages' .bin keys — never assert on a hardcoded name. The FIRST key of a
# package is its own executable (the two-name model); any further key is a helper shipped beside it.
own_name() {
  local value
  value="$(jq -r '.bin | to_entries[0].key' "$1")"
  if [ -z "${value}" ] || [ "${value}" = "null" ]; then
    echo "❌ no .bin entry in $1" >&2
    exit 1
  fi
  printf '%s\n' "${value}"
}
name="$(own_name packages/cli/package.json)"
own_name packages/core/kernel/package.json >/dev/null

cli_base="$(basename "${bin}")"
suffix="${cli_base#"${name}"}"
[[ ${suffix} == "${cli_base}" ]] && echo "❌ ${bin} is not named after the CLI's bin key '${name}'" >&2 && exit 1

count=0
while IFS= read -r executable_name; do
  executable="$(dirname "${bin}")/${executable_name}${suffix}"
  [ ! -f "${executable}" ] && echo "❌ no binary at ${executable}" >&2 && exit 1
  chmod +x "${executable}"
  xattr -d com.apple.quarantine "${executable}" 2>/dev/null || true # mac-only; harmless elsewhere
  "${executable}" --version || { echo "❌ ${executable} --version failed" >&2 && exit 1; }
  echo "✅ launches: ${executable}"
  count=$((count + 1))
done < <(jq -r '.bin | keys_unsorted[]' packages/cli/package.json packages/core/kernel/package.json)

echo "✅ smoke (launch stage) passed for ${count} executable(s) of ${suffix#-}"
