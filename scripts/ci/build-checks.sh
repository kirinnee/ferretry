#!/usr/bin/env bash
set -euo pipefail

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"
./scripts/ci/setup.sh
export FY_CI_SETUP_DONE=1

# The documented install: `fy` and `fyd` compiled by Nix from the CLI and kernel hosts.
echo "🔨 Building the documented Nix install bundle"
nix build .#default --no-link

# The Worker rehearsals, credential-free (`--dry-run` publishes nothing). Each Worker is a plugin's
# (Connections: the relay; Catalogs: the link store) and is rehearsed once its port has put it there; until
# then the step says so instead of rehearsing nothing (scripts/validate/relay-config.sh lists the same).
relay_dir="packages/plugins/connections/worker"
if [[ -f ${relay_dir}/wrangler.hosted.json ]]; then
  (
    cd "${relay_dir}"
    wrangler deploy --dry-run --config wrangler.jsonc
    wrangler deploy --dry-run --config wrangler.hosted.json
  )
else
  echo "⏳ ${relay_dir} is not ported yet: no relay Worker to rehearse" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
fi
link_store_dir="packages/plugins/catalogs/worker"
if [[ -f ${link_store_dir}/wrangler.link-store.hosted.json ]]; then
  (
    cd "${link_store_dir}"
    wrangler deploy --dry-run --config wrangler.link-store.jsonc
    wrangler deploy --dry-run --config wrangler.link-store.hosted.json
  )
else
  echo "⏳ ${link_store_dir} is not ported yet: no link-store Worker to rehearse" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
fi

# The app's static bundle and the Pages contract (scripts/ci/build-pwa.sh), once the app shell has a build.
if jq -e '.scripts.build // empty' packages/app/package.json >/dev/null; then
  ./scripts/ci/build-pwa.sh
else
  echo "⏳ packages/app declares no build script yet (app-shell port): no bundle to build" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
fi
