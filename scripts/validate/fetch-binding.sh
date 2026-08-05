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

# The definition itself must keep the wrapper shape it promises everyone else.
if ! rg -q --fixed-strings 'export const browserFetch: DaemonFetch = (input, init) => globalThis.fetch(input, init);' "${definition}"; then
  echo "❌ ${definition} no longer defines browserFetch as an arrow wrapper around globalThis.fetch" >&2
  exit 1
fi

echo "✅ No unbound fetch builtin is used as a value in packages/pwa/src"
