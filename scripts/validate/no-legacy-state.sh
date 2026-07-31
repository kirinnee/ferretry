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

# Obsolete kteam WIRE identifiers are a regression only in production source:
# tests legitimately assert their absence, and migration docs recount them as
# history. Keep this pass to package source (*/src/*) so neither is flagged, and
# never broaden it to a per-path allowlist.
#
#   x-kteam-request-id / -kteam-  the pre-Ferretry request header family.
#   KBRF                          the pre-Ferretry browser frame magic. The
#                                 daemon emits "FYBF"; a decoder carrying the old
#                                 magic silently reinterpreted every real frame's
#                                 header as JPEG bytes, so the drift produced a
#                                 corrupt image rather than an error. This name is
#                                 matched, not the raw bytes: a byte-array literal
#                                 has no stable text form to scan for, and the
#                                 regression test that plants the old bytes lives
#                                 under tests/, which this pass does not scan.
source_files=()
for path in "${scan_files[@]}"; do
  case "${path}" in
  */src/*) source_files+=("${path}") ;;
  esac
done

wire_hits=""
wire_status=1
if [ "${#source_files[@]}" -gt 0 ]; then
  set +e
  wire_hits="$(rg --line-number --fixed-strings \
    -e 'x-kteam-request-id' \
    -e '-kteam-' \
    -e 'KBRF' \
    -- "${source_files[@]}")"
  wire_status=$?
  set -e
fi

if [ "${wire_status}" -eq 0 ]; then
  echo "❌ obsolete kteam wire identifiers found in package source:" >&2
  printf '%s\n' "${wire_hits}" >&2
  exit 1
fi
[ "${wire_status}" -gt 1 ] && echo "❌ failed to scan package source for obsolete wire identifiers" >&2 && exit "${wire_status}"

echo "✅ No legacy identifiers or state paths found under packages/"
