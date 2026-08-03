#!/usr/bin/env bash
set -euo pipefail

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

./scripts/validate/pages-config.sh

cd packages/pwa
bun install --frozen-lockfile

cd "${root_dir}"
task build:pwa

test -f packages/pwa/dist/_headers
test -f packages/pwa/dist/_redirects
cmp packages/pwa/public/_headers packages/pwa/dist/_headers
cmp packages/pwa/public/_redirects packages/pwa/dist/_redirects

echo "✅ PWA static bundle and Pages headers are ready"
