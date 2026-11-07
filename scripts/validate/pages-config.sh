#!/usr/bin/env bash
set -euo pipefail

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

config="wrangler.jsonc"
app="packages/app"
headers="${app}/public/_headers"
redirects="${app}/public/_redirects"

jq -e '
  .name == "ferretry"
  and .pages_build_output_dir == "./packages/app/dist"
  and (has("main") | not)
  and (has("vars") | not)
  and (has("kv_namespaces") | not)
  and (has("d1_databases") | not)
' "${config}" >/dev/null

# The app shell copies today's `public/_headers` and `_redirects` (docs/rebuild/spine.md §9 slice 5). Until it
# has, there is nothing to hold them to, and saying so is not a pass of the rules below: the Pages deploy
# (scripts/ci/build-pwa.sh) still refuses to publish a bundle without them.
if [[ ! -f ${headers} && ! -f ${redirects} ]]; then
  echo "⏳ ${app}/public has no _headers or _redirects yet (app-shell port): only ${config} was checked"
  exit 0
fi

rg -q '^/\*$' "${headers}"
rg -q "^  Content-Security-Policy: .*connect-src 'self' https: wss: https://api.groq.com https://api.cerebras.ai http://localhost:\* http://127.0.0.1:\* ws://localhost:\* ws://127.0.0.1:\*;" "${headers}"
# Dictation clean-up calls Groq and Cerebras straight from the browser with a key this device holds
# (docs/secrets.md, "Device-held speed-up keys"). In 4.x this also held `connect-src` to the provider table
# in @ferretry/protocol; that table moves into the Voice plugin's contract, and the cross-check returns with it.
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
#
# EACH SHELL NEEDS TWO RULES. Pages' pretty URLs redirect `/<name>.html` to `/<name>`, and
# `_headers` matches the REQUESTED path, so the document itself is served under the extensionless
# rule. Shipping only the `.html` rule framed the shell with `frame-ancestors 'none'` in production.
for shell in /fy-render-sandbox.html /fy-render-sandbox /fy-render-html.html /fy-render-html; do
  require_in_block "${shell}" '^  ! Content-Security-Policy$'
  require_in_block "${shell}" "^  Content-Security-Policy: frame-ancestors 'self'; sandbox allow-scripts$"
  require_in_block "${shell}" '^  X-Content-Type-Options: nosniff$'
  require_in_block "${shell}" '^  Cache-Control: no-cache$'
done

# A `video`/`audio` block with an https `src:` plays through the app's own <video>/<audio>, which only
# `media-src https:` allows; nothing but a block the reader pressed Render on creates one. IMAGES ARE
# NOT WIDENED, deliberately: Markdown renders `![](url)` as an <img> in every surface without a gesture,
# so `img-src https:` would turn every remote image an agent writes into an automatic request. An https
# `image` block is fetched and admitted by the parent instead (docs/fy-render.md).
require_in_block '/*' "media-src 'self' blob: https:;"
# The ONE https host `img-src` names is the map tile server (docs/fy-render.md, "Maps"): a `map` block is
# drawn in the page by the reader's press of Render and loads tiles from there and nowhere else. It is pinned
# exactly, and the refusal below is for a BARE `https:` scheme, which is the widening this guards against.
require_in_block '/*' "img-src 'self' data: blob: https://tile.openstreetmap.org;"
refuse_in_block '/*' "img-src[^;]* https:( |;)" 'widened img-src to https:, which makes every Markdown image an automatic request'

# The shell's CONTENT policy lives in the generated document, not here. Assert the
# `/*` policy was not widened to accommodate it: the app still frames nothing, and
# it never gained the `'unsafe-eval'` the sandbox deliberately does without.
#
# `'wasm-unsafe-eval'` is a DIFFERENT, narrower source and the app carries it on purpose: it lets
# WebAssembly compile (on-device dictation's ONNX Runtime, docs/voice.md) and nothing else — no
# `eval`, no `new Function`, no string timers. So the refusal matches the quoted keyword exactly,
# and the narrow one is pinned to the place it belongs: `script-src`, right after `'self'`.
require_in_block '/*' "^  Content-Security-Policy: default-src 'self';.*frame-ancestors 'none';"
refuse_in_block '/*' "'unsafe-eval'" "gained 'unsafe-eval'"
require_in_block '/*' "script-src 'self' 'wasm-unsafe-eval' 'sha256-"
[[ "$(block_of '/*' | rg -o "wasm-unsafe-eval" | wc -l)" -eq 1 ]] || {
  echo "❌ ${headers}: rule /* names 'wasm-unsafe-eval' somewhere other than once, in script-src" >&2
  exit 1
}

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
rg -q '^/join /app/index\.html 200$' "${redirects}"
rg -q '^/shared /app/index\.html 200$' "${redirects}"
require_in_block "/join" '^  Cache-Control: no-store$'
tail -n 1 "${redirects}" | grep -qx '/\* /index.html 200'

# The pairing URL the daemon mints — and so the QR `fy pair` draws from it — addresses this Pages project by
# hostname. In 4.x this held HOSTED_APP_ORIGIN (@ferretry/protocol) and the daemon's pairing link to the
# project name in wrangler.jsonc; both move into the Access plugin, and the cross-check returns with its port.

echo "✅ Cloudflare Pages configuration is static, scoped, and cache-safe"
