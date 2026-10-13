#!/usr/bin/env bash
set -euo pipefail

# Fails the commit that hands an UNBOUND `fetch` to something that will store it.
#
# `fetch` is a WebIDL operation on the global object, and WebIDL rejects a call whose receiver is
# neither the global nor absent. A bare builtin written as a value therefore works right up until
# somebody keeps it — `this.#network(url, init)` makes the holder the receiver, and the browser
# answers `Failed to execute 'fetch' on 'Window': Illegal invocation` before a byte leaves the tab.
# Every paired daemon reads as unreachable at once, and no test that injects a fetcher can see it,
# because an injected plain function does not care what its receiver is.
#
# This repository has shipped that bug twice — PR #223 through `DaemonHttpTransport`, and the
# carrier router through `network: fetch` handed in by the composition root. The second time the
# router's own arrow DEFAULT was already correct and simply never ran. A default cannot protect an
# injected value, so the rule is enforced where the value is written instead:
#
#   packages/pwa/src/lib/runtime-models.ts exports `browserFetch`, and that is the ONLY spelling of
#   the real network this package may use.
#
# Scanned with comments and string bodies left alone on purpose: this pattern cannot appear inside
# a string or a comment without being either an example (rewrite it) or a lie (delete it), and a
# cleaned-source walker would be a second thing to keep true for no gain.

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

# The one file allowed to name the builtin: it is where `browserFetch` is defined.
definition='packages/pwa/src/lib/runtime-models.ts'

scan_files=()
while IFS= read -r -d '' path; do
  [ -f "${path}" ] || continue
  [ "${path}" = "${definition}" ] && continue
  scan_files+=("${path}")
done < <(git ls-files -z -co --exclude-standard -- 'packages/pwa/src')

if [ "${#scan_files[@]}" -eq 0 ]; then
  echo "❌ found no packages/pwa/src files to scan for fetch bindings" >&2
  exit 2
fi

# Three ways an unbound builtin gets written down, and nothing else:
#   `= fetch`  a parameter default or an assignment
#   `?? fetch` a fallback in a composition root
#   `: fetch`  an object property, which is how it reached the carrier router
bare_hits=""
scan_status=1
set +e
bare_hits="$(rg --line-number --pcre2 \
  -e '(=|\?\?|:)\s*fetch\s*(,|\)|;|\}|$)' \
  -- "${scan_files[@]}")"
scan_status=$?
set -e

if [ "${scan_status}" -eq 0 ]; then
  echo "❌ an unbound fetch builtin is used as a value in packages/pwa/src:" >&2
  printf '%s\n' "${bare_hits}" >&2
  echo >&2
  echo "   Import browserFetch from src/lib/runtime-models.ts instead. A stored builtin throws" >&2
  echo '   "Illegal invocation" the moment it is invoked as a member, and no injected-fetcher test' >&2
  echo "   can catch it." >&2
  exit 1
fi
[ "${scan_status}" -gt 1 ] && echo "❌ failed to scan packages/pwa/src for fetch bindings" >&2 && exit "${scan_status}"

# ── Second rule: nothing CALLS the network directly, except the files below. ──────────────────────
#
# The rule above stops a builtin being stored; it never stopped one being CALLED. Two screens built a
# daemon request by hand and called the builtin on it — Settings' environment inspection and Tasks
# search with its "Mark done" — so on a daemon only the relay can reach they failed while every other
# screen worked. Renaming such a call to `browserFetch(` would have passed a spelling check just as
# well, so the rule is about the CALL, under either name: a daemon request goes through the carrier
# router (`useDaemonFetch()` in a component, the store's `carrier.fetch` in the composition root).
#
# A default parameter or a fallback VALUE (`fetcher: DaemonFetch = browserFetch`) is not a call and is
# not matched here; that is a known, separate residual.
#
# Each allowed file must name WHY it may reach the network without the carrier, and an entry whose
# file no longer makes such a call is a failure, so the list can only shrink honestly.
declare -A call_allowlist=(
  ['packages/pwa/src/lib/runtime-models.ts']='defines browserFetch, the one wrapper around the builtin'
  ['packages/pwa/src/components/fy-render-sandbox.tsx']='fetches a pinned rendering library from this page'"'"'s own origin, never a daemon'
  ['packages/pwa/src/worker/service-worker.ts']='the service worker fetches this site'"'"'s own release files and passes unanswered requests through unchanged; it never builds a daemon request'
)

call_hits=""
call_status=1
set +e
call_hits="$(rg --line-number --pcre2 \
  -e '(?<![\w$.])(?:fetch|browserFetch)\s*\(' \
  -e '\b(?:globalThis|window|self)\.fetch\s*\(' \
  -- "${scan_files[@]}" "${definition}")"
call_status=$?
set -e
[ "${call_status}" -gt 1 ] && echo "❌ failed to scan packages/pwa/src for direct network calls" >&2 && exit "${call_status}"

unexpected=""
declare -A calling_files=()
while IFS= read -r hit; do
  [ -n "${hit}" ] || continue
  path="${hit%%:*}"
  calling_files["${path}"]=1
  [ -n "${call_allowlist[${path}]+set}" ] || unexpected+="${hit}"$'\n'
done <<<"${call_hits}"

if [ -n "${unexpected}" ]; then
  echo "❌ a direct network call in packages/pwa/src skips the carrier router:" >&2
  printf '%s' "${unexpected}" >&2
  echo >&2
  echo "   A daemon request must reach a daemon the browser can only reach through the relay." >&2
  echo "   In a component use useDaemonFetch() from src/lib/store.tsx; in a module take a DaemonFetch" >&2
  echo "   from the caller. If this call genuinely never talks to a daemon, add the file to" >&2
  echo "   call_allowlist in ${BASH_SOURCE[0]} with the reason." >&2
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

# The definition itself must keep the wrapper shape it promises everyone else.
if ! rg -q --fixed-strings 'export const browserFetch: DaemonFetch = (input, init) => globalThis.fetch(input, init);' "${definition}"; then
  echo "❌ ${definition} no longer defines browserFetch as an arrow wrapper around globalThis.fetch" >&2
  exit 1
fi

echo "✅ No unbound fetch builtin is used as a value, and no direct network call skips the carrier, in packages/pwa/src"
