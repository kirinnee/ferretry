#!/usr/bin/env bash
set -euo pipefail

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

echo "📦 Installing dependencies..."
bun install --frozen-lockfile

echo "📝 Repository dead-code review"
./node_modules/.bin/knip --config knip.llm.json --no-exit-code

echo "📝 Production dead-code review"
./node_modules/.bin/knip --config knip.production.llm.json --no-exit-code

echo "✅ Dead-code review complete"
