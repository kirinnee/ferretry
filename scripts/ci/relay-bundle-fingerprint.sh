#!/usr/bin/env bash
set -euo pipefail
#
# Fingerprints the hosted relay Worker, so the deploy workflow publishes only when it changed.
#
#   relay-bundle-fingerprint.sh                  what a deploy WOULD publish, from the checkout
#   relay-bundle-fingerprint.sh --outdir <dir>   the same, and keep the bundle Wrangler built in <dir>
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
# It needs the relay package's dependencies installed (`bun install --frozen-lockfile` in the
# Connections plugin's Worker, packages/plugins/connections/worker) and reads no credentials and no
# network. It runs the checkout's code, so it runs only in the workflow's `build` job, which holds no
# secret; `--outdir` is how that job hands the very bundle it fingerprinted to the `deploy` job. What
# Cloudflare is serving now is read by the `deploy` job itself, with the pinned Wrangler it installs,
# because that is the job that holds the token and it runs no code from this repository.
#
# Output: one line, `bundle-` and 16 hex characters — short enough for a Worker version tag.

root_dir="$(git rev-parse --show-toplevel)"
relay_dir="${root_dir}/packages/plugins/connections/worker"
config="wrangler.hosted.json"
cd "${relay_dir}"

if [[ ${1-} == "--outdir" ]]; then
  outdir="${2:?--outdir needs a directory}"
  mkdir -p "${outdir}"
elif [[ $# -eq 0 ]]; then
  outdir="$(mktemp -d)"
  trap 'rm -rf "${outdir}"' EXIT
else
  echo "usage: relay-bundle-fingerprint.sh [--outdir <dir>]" >&2
  exit 2
fi

wrangler deploy --dry-run --config "${config}" --outdir "${outdir}" >/dev/null

digest="$(
  {
    (cd "${outdir}" && find . -type f ! -name '*.map' ! -name 'README.md' -print0 | LC_ALL=C sort -z | xargs -0 sha256sum)
    sha256sum <"${config}"
  } | sha256sum | awk '{print $1}'
)"
printf 'bundle-%s\n' "${digest:0:16}"
