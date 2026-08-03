#!/usr/bin/env bash
set -euo pipefail

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

config="wrangler.jsonc"
headers="packages/pwa/public/_headers"
redirects="packages/pwa/public/_redirects"

jq -e '
  .name == "ferretry"
  and .pages_build_output_dir == "./packages/pwa/dist"
  and (has("main") | not)
  and (has("vars") | not)
  and (has("kv_namespaces") | not)
  and (has("d1_databases") | not)
' "${config}" >/dev/null

rg -q '^/\*$' "${headers}"
rg -q "^  Content-Security-Policy: .*connect-src 'self' https: wss: http://localhost:\* http://127.0.0.1:\* ws://localhost:\* ws://127.0.0.1:\*;" "${headers}"
# The pairing scanner needs the camera on this origin and nowhere else. Pinned
# because `camera=()` silently disables `getUserMedia` for the whole site, and
# the symptom is a scan button that does nothing rather than a build failure.
rg -q '^  Permissions-Policy: camera=\(self\), geolocation=\(\), microphone=\(self\)$' "${headers}"
rg -q '^/index\.html$' "${headers}"
rg -q '^/sw\.\*$' "${headers}"
rg -q '^/manifest\*\.webmanifest$' "${headers}"
rg -q '^/assets/\*$' "${headers}"
rg -q '^  Cache-Control: no-cache, no-store, must-revalidate$' "${headers}"
rg -q '^  Cache-Control: public, max-age=31536000, immutable$' "${headers}"
# The static landing owns `/`; the app and its durable daemon/pair/setup routes
# are selectively rewritten to the PWA entry before the landing fallback.
rg -q '^/app/\* /app/index\.html 200$' "${redirects}"
rg -q '^/d/\* /app/index\.html 200$' "${redirects}"
rg -q '^/setup /app/index\.html 200$' "${redirects}"
rg -q '^/pair /app/index\.html 200$' "${redirects}"
rg -q '^/pair/\* /app/index\.html 200$' "${redirects}"
tail -n 1 "${redirects}" | grep -qx '/\* /index.html 200'

# The pairing URL the daemon mints — and so the QR `fy pair` draws from it — addresses this Pages
# project by hostname, and neither the daemon nor the CLI can read wrangler.jsonc at runtime. Pinned
# because a renamed project would leave every minted pairing link addressing a site that no longer
# exists, and nothing would fail until somebody scanned one.
pair_service="packages/daemon/src/lib/pairing/service.ts"
rg -qF "https://$(jq -r '.name' "${config}").pages.dev/pair" "${pair_service}" || {
  echo "❌ ${pair_service} does not address the Pages project named in ${config}" >&2
  exit 1
}

echo "✅ Cloudflare Pages configuration is static, scoped, and cache-safe"
