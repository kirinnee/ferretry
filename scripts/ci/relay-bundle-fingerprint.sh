#!/usr/bin/env bash
set -euo pipefail
#
# Fingerprints the hosted relay Worker, so the deploy workflow publishes only when it changed.
#
#   relay-bundle-fingerprint.sh             what a deploy WOULD publish, from the checkout
#   relay-bundle-fingerprint.sh --deployed  what Cloudflare is serving now, or nothing if unknown
#
# WHY THIS EXISTS. Every hosted Worker deploy restarts the Worker and its Durable Objects, and that
# drops every live WebSocket on both ends: every daemon's rendezvous claim and every phone's session.
# The deploy used to run on every push to main, so a busy day of unrelated merges disconnected every
# user dozens of times. The workflow stamps each published version with this fingerprint as its tag
# and skips a deploy whose fingerprint is already the one serving.
#
# WHAT IS HASHED. The bundle Wrangler builds (`deploy --dry-run --outdir`) — so a change anywhere the
# Worker imports from, including @ferretry/protocol, a dependency bump or a new Wrangler, is a change —
# plus the hosted configuration, because bindings, vars, migrations and the compatibility date ship
# beside the bundle rather than inside it. Source maps are left out (they carry paths, not behaviour),
# and so is the README Wrangler writes into the output, which is stamped with the build time.
#
# The default mode needs the relay package's dependencies installed (`bun install --frozen-lockfile`
# in packages/relay) and reads no credentials and no network. `--deployed` reads Cloudflare with the
# CLOUDFLARE_* environment and prints NOTHING whenever it cannot tell — the first deploy, an API
# change, a version published by hand — because the caller treats unknown as "deploy": skipping on a
# guess would leave a stale Worker serving, which is the worse mistake.
#
# Output: one line, `bundle-` and 16 hex characters — short enough for a Worker version tag.

root_dir="$(git rev-parse --show-toplevel)"
relay_dir="${root_dir}/packages/relay"
config="wrangler.hosted.json"
cd "${relay_dir}"

if [[ ${1-} == "--deployed" ]]; then
  # The version carrying the most traffic is the one serving; during a gradual rollout that is still
  # the old one, and redeploying over a rollout is not this script's decision to skip.
  version="$(
    wrangler deployments status --config "${config}" --json 2>/dev/null |
      jq -r '[.versions[]?] | max_by(.percentage) | .version_id // empty' 2>/dev/null
  )" || version=""
  [[ -n ${version} ]] || exit 0
  wrangler versions view "${version}" --config "${config}" --json 2>/dev/null |
    jq -r '.annotations["workers/tag"] // empty | select(startswith("bundle-"))' 2>/dev/null || true
  exit 0
fi

outdir="$(mktemp -d)"
trap 'rm -rf "${outdir}"' EXIT

wrangler deploy --dry-run --config "${config}" --outdir "${outdir}" >/dev/null

digest="$(
  {
    (cd "${outdir}" && find . -type f ! -name '*.map' ! -name 'README.md' -print0 | LC_ALL=C sort -z | xargs -0 sha256sum)
    sha256sum <"${config}"
  } | sha256sum | awk '{print $1}'
)"
printf 'bundle-%s\n' "${digest:0:16}"
