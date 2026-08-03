#!/usr/bin/env bash
set -euo pipefail

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

config="wrangler.jsonc"
headers="packages/pwa/public/_headers"

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
rg -q '^/index\.html$' "${headers}"
rg -q '^/sw\.\*$' "${headers}"
rg -q '^/manifest\*\.webmanifest$' "${headers}"
rg -q '^/assets/\*$' "${headers}"
rg -q '^  Cache-Control: no-cache, no-store, must-revalidate$' "${headers}"
rg -q '^  Cache-Control: public, max-age=31536000, immutable$' "${headers}"

echo "✅ Cloudflare Pages configuration is static, scoped, and cache-safe"
