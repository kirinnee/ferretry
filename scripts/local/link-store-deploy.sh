#!/usr/bin/env bash
set -euo pipefail

# Deploys the link-store Worker to YOUR OWN Cloudflare account (task link-store:deploy).
#
# A deploy restarts the Worker and its Durable Objects, so it is a decision a person makes at a
# keyboard, never a side effect of automation. Refuse in CI and without a terminal unless the caller
# says in so many words that an unattended deploy is intended.

root_dir="$(git rev-parse --show-toplevel)"

if [[ -z ${LINK_STORE_DEPLOY_UNATTENDED:-} ]]; then
  if [[ -n ${CI:-} ]]; then
    echo "❌ refusing to deploy the link store from CI; set LINK_STORE_DEPLOY_UNATTENDED=1 if that is intended" >&2
    exit 1
  fi
  if [[ ! -t 0 ]]; then
    echo "❌ refusing to deploy the link store without a terminal; set LINK_STORE_DEPLOY_UNATTENDED=1 if that is intended" >&2
    exit 1
  fi
fi

cd "${root_dir}/packages/plugins/catalogs/worker"
wrangler deploy --config wrangler.link-store.jsonc
