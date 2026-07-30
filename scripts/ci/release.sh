#!/usr/bin/env bash
set -euo pipefail

[ -z "${GITHUB_TOKEN:-}" ] && echo "❌ 'GITHUB_TOKEN' env var not set" >&2 && exit 1

./scripts/ci/setup.sh
# The release commit ("release: x.y.z") must not fight local hooks in CI.
rm -f .git/hooks/*
./node_modules/.bin/semantic-release

echo "✅ Release complete"
