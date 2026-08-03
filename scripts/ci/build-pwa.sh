#!/usr/bin/env bash
set -euo pipefail

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

./scripts/validate/pages-config.sh

cd packages/pwa
bun install --frozen-lockfile
bun run build

test -f dist/_headers
cmp public/_headers dist/_headers

echo "✅ PWA static bundle and Pages headers are ready"
