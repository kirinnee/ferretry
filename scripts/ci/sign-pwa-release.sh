#!/usr/bin/env bash
# Signs a built PWA release: an Ed25519 signature over the EXACT bytes of
# <dist>/release-manifest.json, written to <dist>/release-manifest.sig as
# `<SHA-256 of the key's SPKI, base64url>.<signature, base64url>` (docs/pwa-release-signing.md).
#
#   printf '%s\n' "${KEY}" | scripts/ci/sign-pwa-release.sh <dist> [<public-key.pem>]
#
# DEPENDENCY-FREE ON PURPOSE: openssl and coreutils, nothing else. It runs in the `sign` job of
# pwa-pages.yaml, the only job that holds the key, which installs no package and runs no build — so
# no dependency's install script or build plugin ever shares a runner, a process table or a
# filesystem with the key.
#
# The private key (PKCS#8 PEM) arrives on STDIN, never through the environment or an argument. It is
# written only to a 0600 file under a fresh 0700 temp directory, removed by the trap on every exit
# path, and never echoed: `set -x` is never enabled here. The script refuses a key whose public half
# is not <public-key.pem> (default: the committed packages/pwa/release-signing-key.pub), because every
# installed copy trusts that key and would refuse anything else, and it proves the signature with
# verify-pwa-release.sh before it returns.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dist="${1:?usage: sign-pwa-release.sh <dist> [<public-key.pem>]  (key on stdin)}"
public_key="${2:-${script_dir}/../../packages/pwa/release-signing-key.pub}"
manifest="${dist}/release-manifest.json"

fail() {
  echo "❌ $*" >&2
  exit 1
}

[[ -s ${manifest} ]] || fail "${manifest} is missing or empty; build the release first"
openssl pkey -pubin -in "${public_key}" -noout -text 2>/dev/null | grep -q '^ED25519 Public-Key' ||
  fail "${public_key} is not an Ed25519 public key"

key_dir="$(mktemp -d)"
trap 'rm -rf "${key_dir}"' EXIT
chmod 700 "${key_dir}"
key_file="${key_dir}/release-signing-key.pem"
(umask 077 && cat >"${key_file}")
grep -q -e '-----BEGIN PRIVATE KEY-----' "${key_file}" ||
  fail "no PKCS#8 signing key arrived on stdin; refusing to publish an unsigned PWA release"

derived="$(openssl pkey -in "${key_file}" -pubout -outform DER 2>/dev/null | openssl base64 -A)" ||
  fail "the signing key is not a PKCS#8 private key"
committed="$(openssl pkey -pubin -in "${public_key}" -outform DER | openssl base64 -A)"
[[ -n ${derived} && ${derived} == "${committed}" ]] || fail "the signing key is not the key in ${public_key}"

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

fingerprint="$(openssl pkey -pubin -in "${public_key}" -outform DER | openssl dgst -sha256 -binary | b64url)"
openssl pkeyutl -sign -inkey "${key_file}" -rawin -in "${manifest}" -out "${key_dir}/signature.bin"
printf '%s.%s\n' "${fingerprint}" "$(b64url <"${key_dir}/signature.bin")" >"${dist}/release-manifest.sig"

"${script_dir}/verify-pwa-release.sh" --signature-only "${dist}" "${public_key}"
echo "✅ PWA release signed"
