#!/usr/bin/env bash
set -euo pipefail

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"
./scripts/ci/setup.sh
export FY_CI_SETUP_DONE=1

echo "🔨 Building the documented Nix install bundle"
nix build .#default --no-link
cd packages/relay
wrangler deploy --dry-run --config wrangler.jsonc
wrangler deploy --dry-run --config wrangler.hosted.json
wrangler deploy --dry-run --config wrangler.link-store.jsonc
wrangler deploy --dry-run --config wrangler.link-store.hosted.json
cd "${root_dir}"
./scripts/ci/build-pwa.sh
