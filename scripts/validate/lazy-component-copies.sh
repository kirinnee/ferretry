#!/usr/bin/env bash
set -euo pipefail

# Fails when the app halves' `app/lazy.ts` copies are not byte-for-byte identical.
#
# WHY. Every app half loads its views on first use through its own `lazyComponent` (`packages/*/*/app/lazy.ts`): a half
# cannot import another package's app files (`context-imports`), and the only shell import a half may make is the
# whole `@ferretry/app` barrel, which its React-light index must not pull in. So the helper is copied, and a copy that
# drifts brings back what one fix removed: the copies once suspended by THROWING their loading promise, which React
# treats as a deprecated suspension, and inside `act` a view still loading was re-tried in one retry lane after another
# without the event loop ever running — `ferret-page-opens.test.tsx` spun at 100% CPU on a cold machine. The copies now
# suspend through React's `use()`; this gate keeps all of them that way.
#
# FILE SET. Tracked files matching `packages/*/*/app/lazy.ts`. The first in sorted order is the reference; a change is
# made to every copy at once.
#
# Exit codes follow the repo convention: 0 clean, 1 a violation, 2 a broken gate.

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

mapfile -t copies < <(git ls-files -- 'packages/*/*/app/lazy.ts' | sort)
if [[ ${#copies[@]} -eq 0 ]]; then
  echo "lazy-component-copies: no packages/*/*/app/lazy.ts is tracked; the gate has nothing to compare" >&2
  exit 2
fi

# `git hash-object` rather than `cmp`: the pre-commit environment carries git but not diffutils.
mapfile -t hashes < <(git hash-object -- "${copies[@]}")
reference="${copies[0]}"
drifted=()
for i in "${!copies[@]}"; do
  [[ ${hashes[$i]} == "${hashes[0]}" ]] || drifted+=("${copies[$i]}")
done

if [[ ${#drifted[@]} -gt 0 ]]; then
  echo "lazy-component-copies: these app/lazy.ts copies differ from ${reference}:" >&2
  for copy in "${drifted[@]}"; do
    echo "  ${copy}" >&2
  done
  echo "Change every copy together (they must stay byte-for-byte identical; see the header of this script)." >&2
  exit 1
fi

echo "lazy-component-copies: ${#copies[@]} identical app/lazy.ts copies"
