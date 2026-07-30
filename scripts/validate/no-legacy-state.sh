#!/usr/bin/env bash
set -euo pipefail

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

# Documentation may discuss migration history only when its exact path is reviewed and listed
# here. No current package document needs an exemption.
documentation_allowlist=()
scan_files=()

while IFS= read -r -d '' path; do
  [ -f "${path}" ] || continue
  is_allowlisted=0
  for allowed_path in "${documentation_allowlist[@]}"; do
    if [ "${path}" = "${allowed_path}" ]; then
      is_allowlisted=1
      break
    fi
  done
  if [ "${is_allowlisted}" -eq 0 ]; then
    scan_files+=("${path}")
  fi
done < <(git ls-files -z -co --exclude-standard -- packages)

legacy_hits=""
scan_status=1
if [ "${#scan_files[@]}" -gt 0 ]; then
  set +e
  legacy_hits="$(rg --line-number --fixed-strings \
    -e 'KTEAM_' \
    -e '.kteam' \
    -e 'kteamd' \
    -e 'kfleet' \
    -- "${scan_files[@]}")"
  scan_status=$?
  set -e
fi

if [ "${scan_status}" -eq 0 ]; then
  echo "❌ legacy identifiers or state paths found under packages/:" >&2
  printf '%s\n' "${legacy_hits}" >&2
  exit 1
fi
[ "${scan_status}" -gt 1 ] && echo "❌ failed to scan packages/ for legacy state references" >&2 && exit "${scan_status}"

echo "✅ No legacy identifiers or state paths found under packages/"
