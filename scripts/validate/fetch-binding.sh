#!/usr/bin/env bash
set -euo pipefail

# Fails the commit that hands an UNBOUND `fetch` to something that will store it, or that calls the
# network directly from browser code instead of through the daemon client.
#
# `fetch` is a WebIDL operation on the global object, and WebIDL rejects a call whose receiver is
# neither the global nor absent. A bare builtin written as a value therefore works right up until
# somebody keeps it — `this.#network(url, init)` makes the holder the receiver, and the browser
# answers `Failed to execute 'fetch' on 'Window': Illegal invocation` before a byte leaves the tab.
# Every paired daemon reads as unreachable at once, and no test that injects a fetcher can see it,
# because an injected plain function does not care what its receiver is. Ferretry 4 shipped that bug
# twice (PR #223 through `DaemonHttpTransport`, and the carrier router through `network: fetch`).
#
# Ferretry 5.0 scope: every browser half — the app shell (`packages/app/src`) and each subsystem's
# `app/` half (`packages/core/*/app`, `packages/plugins/*/app`). A new package is scanned the moment it
# has an `app/` directory.
#
# Scanned with comments and string bodies left alone on purpose: this pattern cannot appear inside
# a string or a comment without being either an example (rewrite it) or a lie (delete it).

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

# ── Second rule's allowlist: the ONLY files that may call the network directly. ──────────────────
#
# A daemon request must reach a daemon the browser may only reach through a sealed session, so it goes
# through the generated per-daemon client (docs/rebuild/spine.md §5; `contract-consumes` holds the rest).
# Each entry names WHY its file may reach the network without it, and an entry whose file no longer makes
# such a call is a failure, so the list can only shrink honestly. The app shell adds its one wrapper and
# its service worker here, with their reasons, when it lands.
declare -A call_allowlist=(
  ['packages/app/src/worker/service-worker.ts']='the service worker fetches this site'"'"'s own signed release files (FetchReleaseNetwork, pinned to its own origin and refusing a cross-origin answer) and passes an unanswered same-origin request through unchanged; it never builds a daemon request'
  ['packages/plugins/voice/app/shell-voice.ts']='defines browserFetch, the one wrapper around the builtin; speech-model downloads and speed-up provider calls never talk to a daemon (every daemon request goes through the plugin client: useDaemonFetch refuses rather than fall back to it)'
)

scan_files=()
while IFS= read -r -d '' path; do
  [ -f "${path}" ] || continue
  scan_files+=("${path}")
done < <(git ls-files -z -co --exclude-standard -- 'packages/app/src' 'packages/core/*/app/*' 'packages/plugins/*/app/*' |
  { grep -zE '\.(ts|tsx|mts|cts|js|jsx)$' || true; })

if [ "${#scan_files[@]}" -eq 0 ]; then
  echo "❌ found no browser source (packages/app/src, packages/*/*/app) to scan for fetch bindings" >&2
  exit 2
fi

# Three ways an unbound builtin gets written down, and nothing else:
#   `= fetch`  a parameter default or an assignment
#   `?? fetch` a fallback in a composition root
#   `: fetch`  an object property, which is how it reached the carrier router
set +e
bare_hits="$(rg --line-number --pcre2 \
  -e '(=|\?\?|:)\s*fetch\s*(,|\)|;|\}|$)' \
  -- "${scan_files[@]}")"
scan_status=$?
set -e

if [ "${scan_status}" -eq 0 ]; then
  echo "❌ an unbound fetch builtin is used as a value in browser code:" >&2
  printf '%s\n' "${bare_hits}" >&2
  echo >&2
  echo "   Wrap it as (input, init) => globalThis.fetch(input, init) in the one allowlisted file instead." >&2
  echo '   A stored builtin throws "Illegal invocation" the moment it is invoked as a member, and no' >&2
  echo "   injected-fetcher test can catch it." >&2
  exit 1
fi
[ "${scan_status}" -gt 1 ] && echo "❌ failed to scan browser code for fetch bindings" >&2 && exit "${scan_status}"

# ── Second rule: nothing CALLS the network directly, except the allowlisted files. ───────────────
#
# The rule above stops a builtin being stored; it never stopped one being CALLED. Two 4.x screens built a
# daemon request by hand and called the builtin on it, so on a daemon only the relay can reach they failed
# while every other screen worked. The rule is about the CALL, under either name.
set +e
call_hits="$(rg --line-number --pcre2 \
  -e '(?<![\w$.])(?:fetch|browserFetch)\s*\(' \
  -e '\b(?:globalThis|window|self)\.fetch\s*\(' \
  -- "${scan_files[@]}")"
call_status=$?
set -e
[ "${call_status}" -gt 1 ] && echo "❌ failed to scan browser code for direct network calls" >&2 && exit "${call_status}"

unexpected=""
declare -A calling_files=()
while IFS= read -r hit; do
  [ -n "${hit}" ] || continue
  path="${hit%%:*}"
  calling_files["${path}"]=1
  [ -n "${call_allowlist[${path}]+set}" ] || unexpected+="${hit}"$'\n'
done <<<"${call_hits}"

if [ -n "${unexpected}" ]; then
  echo "❌ a direct network call in browser code skips the daemon client:" >&2
  printf '%s' "${unexpected}" >&2
  echo >&2
  echo "   A daemon request goes through the generated per-daemon client. If this call genuinely never" >&2
  echo "   talks to a daemon, add the file to call_allowlist in ${BASH_SOURCE[0]} with the reason." >&2
  exit 1
fi

for path in "${!call_allowlist[@]}"; do
  if [ -z "${call_allowlist[${path}]}" ]; then
    echo "❌ ${path} is allowed to call the network directly but names no reason" >&2
    exit 1
  fi
  if [ -z "${calling_files[${path}]+set}" ]; then
    echo "❌ ${path} is allowed to call the network directly but no longer does — delete its entry" >&2
    exit 1
  fi
done

echo "✅ No unbound fetch builtin is used as a value, and no direct network call skips the daemon client, in ${#scan_files[@]} browser files"
