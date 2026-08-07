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
# The `fy-render` sandbox shell and its two library bundles.
#
# EVERY CHECK BELOW IS SCOPED TO ITS OWN RULE BLOCK, and that is the point rather
# than tidiness. A bare `rg` for `Cache-Control: no-cache` passes as long as ANY
# rule in the file carries it, so deleting one library rule's own header would
# still have gone green. This is a contract gate for a policy nothing else tests —
# `bun test` never reads `_headers` — so a false positive here is release-shaped.
#
# A rule block is the `/path` line plus the indented header lines under it; a
# blank line, a comment, or the next path ends it.
block_of() {
  awk -v want="$1" '
    /^\// { inb = ($0 == want); next }
    /^  / { if (inb) print; next }
    { inb = 0 }
  ' "${headers}"
}

require_in_block() {
  local path="$1" pattern="$2"
  block_of "${path}" | rg -q "${pattern}" || {
    echo "❌ ${headers}: rule ${path} is missing a line matching: ${pattern}" >&2
    exit 1
  }
}

refuse_in_block() {
  local path="$1" pattern="$2" why="$3"
  if block_of "${path}" | rg -q "${pattern}"; then
    echo "❌ ${headers}: rule ${path} ${why}" >&2
    exit 1
  fi
}

# The detach line is the one most likely to be "tidied" away. Without it Cloudflare
# comma-joins this policy onto the `/*` one, which carries `frame-ancestors 'none'`
# — the shell then cannot be framed by anything and the feature is silently inert.
require_in_block '/fy-render-sandbox.html' '^  ! Content-Security-Policy$'
require_in_block '/fy-render-sandbox.html' "^  Content-Security-Policy: frame-ancestors 'self'; sandbox allow-scripts$"
require_in_block '/fy-render-sandbox.html' '^  X-Content-Type-Options: nosniff$'
require_in_block '/fy-render-sandbox.html' '^  Cache-Control: no-cache$'

# The shell's CONTENT policy lives in the generated document, not here. Assert the
# `/*` policy was not widened to accommodate it: the app still frames nothing, and
# it never gained the `'unsafe-eval'` the sandbox deliberately does without.
require_in_block '/*' "^  Content-Security-Policy: default-src 'self';.*frame-ancestors 'none';"
refuse_in_block '/*' "unsafe-eval" "gained 'unsafe-eval'"

# Fixed filenames, so each must revalidate on its own line. An immutable stale
# bundle would fail the shell's hash pin and disable the feature with no way to
# push a fix until the cache expired.
for asset in /fy-render-mermaid.js /fy-render-lottie.js; do
  require_in_block "${asset}" '^  X-Content-Type-Options: nosniff$'
  require_in_block "${asset}" '^  Cache-Control: no-cache$'
  refuse_in_block "${asset}" 'immutable' 'is marked immutable, but its filename is not content-addressed'
done

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
