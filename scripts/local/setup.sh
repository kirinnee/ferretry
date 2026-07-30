#!/usr/bin/env bash
set -euo pipefail

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

echo "📦 Installing dependencies..."
bun install --frozen-lockfile
echo "✅ Dependencies installed"
