#!/usr/bin/env bash
# Proves a signed PWA release before it is published (docs/pwa-release-signing.md):
#
#   - <dist>/release-manifest.sig is a signature by <public-key.pem> (default: the committed
#     packages/pwa/release-signing-key.pub) over the exact bytes of <dist>/release-manifest.json;
#   - unless --signature-only: every file in <dist> is listed, and every listed file's SHA-256 is the
#     one the list names — so the bytes that are deployed are the bytes that were signed.
#
#   scripts/ci/verify-pwa-release.sh [--signature-only] <dist> [<public-key.pem>]
#
# openssl and coreutils only (plus jq for the file check), so the `sign` job can run it without
# installing anything. The deploy job runs it in full on what it is about to upload.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
signature_only=false
if [[ ${1:-} == --signature-only ]]; then
  signature_only=true
  shift
fi
dist="${1:?usage: verify-pwa-release.sh [--signature-only] <dist> [<public-key.pem>]}"
public_key="${2:-${script_dir}/../../packages/pwa/release-signing-key.pub}"
manifest="${dist}/release-manifest.json"

fail() {
  echo "❌ $*" >&2
  exit 1
}

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

[[ -s ${manifest} ]] || fail "${manifest} is missing or empty"
signature_line="$(cat "${dist}/release-manifest.sig")"
[[ ${signature_line} =~ ^([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{86})$ ]] ||
  fail "${dist}/release-manifest.sig is not a release signature (is it still the unsigned marker?)"
fingerprint="${BASH_REMATCH[1]}"
encoded="${BASH_REMATCH[2]}"

expected="$(openssl pkey -pubin -in "${public_key}" -outform DER | openssl dgst -sha256 -binary | b64url)"
[[ ${fingerprint} == "${expected}" ]] || fail "the release is not signed by the key in ${public_key}"

work_dir="$(mktemp -d)"
trap 'rm -rf "${work_dir}"' EXIT
printf '%s==' "${encoded}" | tr '_-' '/+' | openssl base64 -d -A >"${work_dir}/signature.bin"
openssl pkeyutl -verify -pubin -inkey "${public_key}" -rawin -in "${manifest}" \
  -sigfile "${work_dir}/signature.bin" >/dev/null 2>&1 || fail "the release signature does not verify"

if [[ ${signature_only} == false ]]; then
  listed="$(jq -r '.files | keys[]' "${manifest}" | LC_ALL=C sort)"
  present="$(cd "${dist}" && find . -type f ! -name _headers ! -name _redirects ! -name 'release-manifest.*' |
    sed 's|^\./||' | LC_ALL=C sort)"
  [[ ${listed} == "${present}" ]] || fail "${manifest} does not list exactly the files in ${dist}"
  while IFS=$'\t' read -r path hash; do
    actual="$(openssl dgst -sha256 -binary "${dist}/${path}" | b64url)"
    [[ ${actual} == "${hash}" ]] || fail "${path} is not the file the release signed"
  done < <(jq -r '.files | to_entries[] | "\(.key)\t\(.value)"' "${manifest}")
fi
echo "✅ PWA release signature verified$([[ ${signature_only} == true ]] || echo ' with every file')"
