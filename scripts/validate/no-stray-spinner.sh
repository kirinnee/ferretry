#!/usr/bin/env bash
set -euo pipefail

# Fails the commit that draws its own turning icon instead of the shared spinner.
#
# One busy mark (`<Spinner>`, packages/app/src/ui/spinner.tsx) is what a theme restyles and what the one 300 ms loader
# threshold gates. A lucide `LoaderCircle` / `Loader2` / `RefreshCw` with Tailwind's `animate-spin` is neither: it keeps
# one look in every style and shows at once, so a fast read flashes it. A wait uses `<Spinner wait size={…} />`; feedback
# for an action or a running activity uses `<Spinner size={…} />`.
#
# Scope: the browser source (the app shell and each subsystem's `app/` half), tests excluded. The stylesheet's
# reduced-motion rule for the Tailwind utility is CSS and is not scanned.

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

scan_files=()
while IFS= read -r -d '' path; do
  [ -f "${path}" ] || continue
  scan_files+=("${path}")
done < <(git ls-files -z -co --exclude-standard -- 'packages/app/src' ':(glob)packages/core/*/app/**' ':(glob)packages/plugins/*/app/**' |
  { grep -zE '\.(ts|tsx|mts|cts|js|jsx)$' || true; })

if [ "${#scan_files[@]}" -eq 0 ]; then
  echo "❌ found no browser source (packages/app/src, packages/*/*/app) to scan for stray spinners" >&2
  exit 2
fi

set +e
hits="$(rg --with-filename --line-number --no-heading --fixed-strings -e 'animate-spin' -- "${scan_files[@]}")"
status=$?
set -e
if [ "${status}" -gt 1 ]; then
  echo "❌ failed to scan for stray spinners" >&2
  exit 2
fi

if [ -n "${hits}" ]; then
  echo "❌ a turning icon drawn with animate-spin bypasses the shared spinner and the 300 ms loader threshold:" >&2
  printf '%s\n' "${hits}" >&2
  echo >&2
  echo "   Use <Spinner wait size={…} /> for a wait, <Spinner size={…} /> for an action or a running activity" >&2
  echo "   (import { Spinner } from '@ferretry/app/ui')." >&2
  exit 1
fi

echo "✅ No animate-spin icon bypasses the shared spinner, in ${#scan_files[@]} browser files"
