#!/usr/bin/env bash
set -euo pipefail

# Regenerate the git-ignored plugin registries (scripts/gen/registries.ts, the SDK slice's generator):
# packages/core/kernel/src/generated/plugins.ts, packages/cli/src/generated/commands.ts,
# packages/app/src/generated/surfaces.ts and generated/. The hosts import them, so every route that
# installs, builds, tests or typechecks runs this first (root `postinstall`, scripts/validate/typecheck.sh,
# scripts/ci/test.sh, scripts/release/compile.sh, scripts/local/build.sh, nix/ferretry.nix).
# A missing generator fails loudly.

root_dir="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "${root_dir}"

exec bun scripts/gen/registries.ts "$@"
