#!/usr/bin/env bash
# Signs the built PWA release in packages/pwa/dist with PWA_RELEASE_SIGNING_KEY (PKCS#8 PEM).
#
# The key is written ONLY to a 0600 file under a fresh temp directory, removed by the trap on every
# exit path, and never echoed: `set -x` is never enabled here and the value is passed to the signer
# as a file path, not an argument. A missing key is a failure, not an unsigned deploy — the hosted
# app must never publish a release an installed copy cannot verify. See docs/pwa-release-signing.md.
set -euo pipefail

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

if [[ -z ${PWA_RELEASE_SIGNING_KEY:-} ]]; then
  echo "❌ PWA_RELEASE_SIGNING_KEY is not set; refusing to deploy an unsigned PWA release" >&2
  echo "   Add it to the protected 'pwa-release' environment (docs/pwa-release-signing.md)." >&2
  exit 1
fi

key_dir="$(mktemp -d)"
trap 'rm -rf "${key_dir}"' EXIT
chmod 700 "${key_dir}"
key_file="${key_dir}/release-signing-key.pem"
(umask 077 && printf '%s\n' "${PWA_RELEASE_SIGNING_KEY}" >"${key_file}")

(cd packages/pwa && bun run scripts/sign-release.ts "${key_file}" dist)

grep -qv '^unsigned$' packages/pwa/dist/release-manifest.sig || {
  echo "❌ packages/pwa/dist/release-manifest.sig is still the unsigned marker" >&2
  exit 1
}
echo "✅ PWA release signed"
