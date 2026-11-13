#!/usr/bin/env bash
# Signs a daemon release's checksum list for the standalone self-update (docs/updating.md): an
# Ed25519 signature over `ferretry-daemon-release-v1\n` followed by the EXACT bytes of
# <dist>/checksums.txt, written to <dist>/checksums.txt.sig as
# `<SHA-256 of the key's SPKI, base64url>.<signature, base64url>`.
#
#   printf '%s\n' "${KEY}" | scripts/ci/sign-daemon-release.sh <dist>
#
# THE CONTEXT LINE IS READ FROM ITS SOURCE MODULE, never retyped here: `fy` verifies against
# DAEMON_RELEASE_SIGNATURE_CONTEXT, and a signer that drifted from it would publish signatures no
# shipped `fy` accepts.
#
# IT REFUSES A KEY NO SHIPPED `fy` TRUSTS. The trusted keys are the list DAEMON_RELEASE_KEYS
# (the Updates plugin); a key whose public half is not in it would sign
# releases that every standalone install refuses, so it fails here instead of at somebody's update.
#
# The private key (PKCS#8 PEM) arrives on STDIN, never through the environment or an argument. It is
# written only to a 0600 file under a fresh 0700 temp directory, removed by the trap on every exit
# path, and never echoed: `set -x` is never enabled here. openssl and coreutils only.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="${script_dir}/../.."
dist="${1:-}"

fail() {
  echo "❌ $*" >&2
  exit 1
}

[[ -n ${dist} ]] || fail "usage: sign-daemon-release.sh <dist>  (key on stdin)"
checksums="${dist}/checksums.txt"
[[ -f ${checksums} ]] || fail "no ${checksums} to sign"

# Ferretry 5.0: both facts are the Updates plugin's (docs/rebuild/ports/updates.md). Each is FOUND by its
# exported name rather than by a path, so the port places them where its layout wants; a fact with no owner
# or two owners refuses to sign.
owner_of() {
  local found
  mapfile -t found < <(grep -rlE --include='*.ts' --exclude-dir=node_modules --exclude-dir=tests "^export const $1\b" "${repo}/packages" || true)
  [[ ${#found[@]} -eq 1 ]] || fail "exactly one module under packages/ must export $1; found ${#found[@]}"
  printf '%s\n' "${found[0]}"
}
keys_file="$(owner_of DAEMON_RELEASE_KEYS)"
protocol_file="$(owner_of DAEMON_RELEASE_SIGNATURE_CONTEXT)"

context="$(sed -n "s/^export const DAEMON_RELEASE_SIGNATURE_CONTEXT = '\(.*\)\\\\n';$/\1/p" "${protocol_file}")"
[[ -n ${context} ]] || fail "cannot read DAEMON_RELEASE_SIGNATURE_CONTEXT from ${protocol_file}"

key_dir="$(mktemp -d)"
trap 'rm -rf "${key_dir}"' EXIT
chmod 700 "${key_dir}"
key_file="${key_dir}/daemon-release-key.pem"
(umask 077 && cat >"${key_file}")
grep -q -e '-----BEGIN PRIVATE KEY-----' "${key_file}" ||
  fail "no PKCS#8 signing key arrived on stdin; refusing to sign"

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

openssl pkey -in "${key_file}" -pubout -out "${key_dir}/public.pem" 2>/dev/null ||
  fail "the signing key is not a PKCS#8 private key"
# Capture first, then match: `openssl | grep -q` under pipefail fails with SIGPIPE when grep exits on its first match.
public_key_text="$(openssl pkey -pubin -in "${key_dir}/public.pem" -noout -text 2>/dev/null)" || public_key_text=''
grep -q '^ED25519 Public-Key' <<<"${public_key_text}" ||
  fail "the signing key is not an Ed25519 key"
public="$(openssl pkey -pubin -in "${key_dir}/public.pem" -outform DER | b64url)"
grep -qF "'${public}'" "${keys_file}" ||
  fail "the signing key's public half is not listed in ${keys_file}; no shipped fy would trust it"

message="${key_dir}/message"
printf '%s\n' "${context}" >"${message}"
cat "${checksums}" >>"${message}"
openssl pkeyutl -sign -inkey "${key_file}" -rawin -in "${message}" -out "${key_dir}/signature.bin"
openssl pkeyutl -verify -pubin -inkey "${key_dir}/public.pem" -rawin -in "${message}" \
  -sigfile "${key_dir}/signature.bin" >/dev/null || fail "the signature does not verify"

fingerprint="$(openssl pkey -pubin -in "${key_dir}/public.pem" -outform DER | openssl dgst -sha256 -binary | b64url)"
printf '%s.%s\n' "${fingerprint}" "$(b64url <"${key_dir}/signature.bin")" >"${dist}/checksums.txt.sig"
echo "✅ daemon release checksums signed"
