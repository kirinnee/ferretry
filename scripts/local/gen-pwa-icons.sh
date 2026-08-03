#!/usr/bin/env bash
set -euo pipefail

# Render the PWA's committed PNG icons from the chosen brand direction.
#
# The brand marks in `docs/brand/fleet-grid/` are the source of truth and are
# hand-authored SVG. Browsers still need raster for three jobs SVG cannot do
# portably: iOS `apple-touch-icon` ignores SVG entirely, Android's install
# prompt and home-screen shortcut want a real bitmap, and Safari before 16.4 has
# no SVG favicon at all. Those PNGs are therefore COMMITTED artifacts under
# `packages/pwa/public/icons/`, not build output — the Pages deployment publishes
# `dist/` verbatim and `vite build` copies `public/` without transforming it, so
# a generation step in the build would need Chrome in CI to produce files the
# bundle already has.
#
# This script exists so those bytes can be re-derived rather than hand-edited.
# It is NOT a verification gate: Chrome's encoder is free to change bytes between
# versions, so comparing output to the committed files would fail for reasons
# that have nothing to do with the artwork. What IS enforced, in
# `packages/pwa/tests/unit/app-icons.test.ts`, is the part that can actually be
# wrong in a way nobody notices: every icon the manifest and the document name
# exists, its real pixel dimensions match the size it claims, and the maskable
# art still fits inside Android's circular crop.
#
#   ./scripts/local/gen-pwa-icons.sh

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

brand_dir="docs/brand/fleet-grid"
out_dir="packages/pwa/public/icons"

chrome="$(command -v google-chrome || command -v chromium || true)"
if [[ -z ${chrome} ]]; then
  echo "❌ no system Chrome or Chromium found — this script renders through headless Chrome" >&2
  exit 1
fi

work_dir="$(mktemp -d)"
trap 'rm -rf "${work_dir}"' EXIT
mkdir -p "${out_dir}"

# One <img> sized to the exact pixel box, at device scale factor 1, so the
# rasteriser sees the size the browser will: the fleet grid's 4-unit geometry
# lands on whole pixels at 16 and 32, and that alignment is the whole reason this
# direction was chosen. Scaling a 512 render down would throw it away.
#
# The background is NAMED at every call rather than defaulted, because getting it
# wrong is silent: `logomark-dark.svg` is light ink with no field of its own, so
# on Chrome's default white page it renders as pale grey on white — a legible
# shape in the SVG and mud in the PNG. The brand PNGs in `docs/brand` composite
# the same way and for the same reason.
render() {
  local source="$1" size="$2" background="$3" target="$4"
  cp "${brand_dir}/${source}" "${work_dir}/art.svg"
  cat >"${work_dir}/page.html" <<HTML
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>icon</title>
    <style>
      html, body { margin: 0; padding: 0; width: ${size}px; height: ${size}px; overflow: hidden; background: ${background}; }
      img { display: block; width: ${size}px; height: ${size}px; }
    </style>
  </head>
  <body><img src="art.svg" alt="" /></body>
</html>
HTML
  # `--no-sandbox` is what the rest of this repo's Chrome usage already does:
  # playwright-core launches with `chromiumSandbox: false` by default, which is
  # how `packages/pwa/harness/screenshot.ts` and the visual integration tests
  # drive the same binary. The nix-store Chrome ships a `chrome-sandbox` helper
  # that is not setuid root, and Chrome aborts rather than silently dropping the
  # sandbox — so the flag has to be explicit here.
  "${chrome}" --headless --no-sandbox --disable-gpu --hide-scrollbars \
    --force-device-scale-factor=1 --window-size="${size},${size}" \
    --screenshot="${work_dir}/shot.png" "file://${work_dir}/page.html" >/dev/null 2>&1
  mv "${work_dir}/shot.png" "${target}"
  echo "🖼  ${target} ← ${brand_dir}/${source} at ${size}px"
}

# The tab fallbacks take the DARK logomark on the brand's own `--bg`: a favicon
# PNG cannot follow the reader's colour scheme the way `favicon.svg` does, so it
# ships as a self-contained tile that is legible against a light and a dark tab
# strip alike. Light ink on a light strip would not be.
render logomark-dark.svg 16 '#0b0b0d' "${out_dir}/favicon-16.png"
render logomark-dark.svg 32 '#0b0b0d' "${out_dir}/favicon-32.png"

# The home-screen icons take the MASKABLE art, which carries its own opaque field
# and keeps the mark inside the safe zone. iOS crops to a squircle and Android to
# a circle; neither adds padding of its own, so padding has to already be there.
# The page background is the same `#0b0b0d` the art paints, so the two cannot
# disagree along the edge if the field is ever inset.
render logomark-maskable.svg 180 '#0b0b0d' "${out_dir}/apple-touch-icon.png"
render logomark-maskable.svg 192 '#0b0b0d' "${out_dir}/icon-192.png"
render logomark-maskable.svg 512 '#0b0b0d' "${out_dir}/icon-512.png"

echo "✅ PWA icons rendered into ${out_dir}"
