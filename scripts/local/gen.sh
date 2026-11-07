#!/usr/bin/env bash
set -euo pipefail

# Regenerate the git-ignored plugin registries (scripts/gen/registries.ts, the SDK slice's generator):
# packages/core/kernel/src/generated/plugins.ts, packages/cli/src/generated/commands.ts,
# packages/app/src/generated/surfaces.ts and generated/. The hosts import them, so every route that
# installs, builds, tests or typechecks runs this first (root `postinstall`, scripts/validate/typecheck.sh,
# scripts/ci/test.sh, scripts/release/compile.sh, scripts/local/build.sh, nix/ferretry.nix).
#
# DAY-1 ORDERING ONLY: until rebuild/spine-sdk is merged into rebuild/5.0 the generator does not exist on
# every branch, and this says so instead of failing every install. Once it is merged, delete the branch
# below so a missing generator fails loudly.

root_dir="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "${root_dir}"

generator="scripts/gen/registries.ts"
if [[ ! -f ${generator} ]]; then
  echo "⏳ ${generator} is not on this branch yet (rebuild/spine-sdk): no registries generated" >&2
  exit 0
fi
exec bun "${generator}" "$@"
