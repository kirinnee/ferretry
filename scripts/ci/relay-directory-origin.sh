#!/usr/bin/env bash
#
# Prints the hosted relay's discovery ORIGIN for the PWA build, or nothing.
#
# The PWA needs this origin at BUILD time: Cloudflare Pages is static — no
# Functions, no proxy — and the hosted relay is a separate Worker hostname, so a
# relative `/v1/default-relay` could never reach it. `packages/pwa/vite.config.ts`
# bakes whatever this prints into the bundle as `__FY_RELAY_DIRECTORY__`.
#
# WHY THIS IS A SCRIPT AND NOT ONE LINE OF YAML. Passing `vars.HOSTED_RELAY_ORIGIN`
# straight through looked equivalent and was not: that repository variable is
# OPTIONAL for the relay's own deploy, which derives the workers.dev origin from
# the Cloudflare account when it is blank. With no variable set — which is the
# state of this repository today — the Worker would deploy at a real address while
# the production bundle compiled an empty one and never asked anybody anything.
# The default would be missing in production and nothing would have failed.
#
# So resolution happens in the same order the relay's deploy uses, from the same
# inputs, and refuses to be quietly wrong:
#
#   1. `HOSTED_RELAY_ORIGIN`, when set. The explicit override, including a custom
#      hostname that is not on `workers.dev`.
#   2. Otherwise DERIVE `https://<worker>.<subdomain>.workers.dev` from the
#      Cloudflare account, exactly as `.github/workflows/relay-hosted.yaml` does,
#      taking `<worker>` from `packages/relay/wrangler.hosted.json` so the two
#      cannot name different Workers.
#   3. With `--require`, a failure to resolve is a FAILED BUILD, not an empty
#      string. Shipping a production bundle with no default silently is the exact
#      outcome this script exists to prevent.
#
# NO HOSTED RELAY IN THE TREE IS NOT A FAILURE. If `wrangler.hosted.json` is
# absent, this product has no hosted relay to point at and a bundle without a
# default is correct — that is reported loudly and exits 0, because failing would
# break a deploy over a service that does not exist. The moment that file lands,
# `--require` starts insisting on a real origin.
#
# Local builds and forks call nothing here: `FY_RELAY_DIRECTORY_ORIGIN` simply
# stays unset, the bundle has no directory, and the setup screen says so.

set -euo pipefail

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

require=0
[[ ${1-} == "--require" ]] && require=1

hosted_config="packages/relay/wrangler.hosted.json"
api="https://api.cloudflare.com/client/v4"

fail() {
  echo "❌ $1" >&2
  exit 1
}

# An explicit override wins, and is trusted as given: a custom hostname is the
# whole reason this input exists, so it is not checked against workers.dev.
if [[ -n ${HOSTED_RELAY_ORIGIN-} ]]; then
  printf '%s\n' "${HOSTED_RELAY_ORIGIN}"
  echo "ℹ️  relay directory origin: HOSTED_RELAY_ORIGIN (explicit override)" >&2
  exit 0
fi

if [[ ! -f ${hosted_config} ]]; then
  echo "⚠️  ${hosted_config} is absent: this tree ships no hosted relay, so the PWA is built with" >&2
  echo "    no relay directory and the setup screen will say so. Nothing to derive." >&2
  exit 0
fi

worker_name="$(jq -er '.name' "${hosted_config}" 2>/dev/null || true)"
[[ -z ${worker_name} || ${worker_name} == "null" ]] && fail "${hosted_config} declares no Worker name"

if [[ -z ${CLOUDFLARE_API_TOKEN-} || -z ${CLOUDFLARE_ACCOUNT_ID-} ]]; then
  message="no HOSTED_RELAY_ORIGIN and no Cloudflare credentials, so ${worker_name}'s origin cannot be derived"
  ((require == 1)) && fail "${message}. Set the HOSTED_RELAY_ORIGIN repository variable, or give this
    job CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID so it can read the account's workers.dev
    subdomain — a production bundle must not ship without a relay default."
  echo "⚠️  ${message}; building with no relay directory" >&2
  exit 0
fi

# The same account read the relay's own deploy performs. `jq -e` turns a
# well-formed error document into a non-zero exit rather than the string "null".
subdomain="$(
  curl --fail --silent --show-error --retry 3 --retry-all-errors --retry-delay 2 \
    --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    "${api}/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/subdomain" |
    jq -er '.result.subdomain'
)" || subdomain=""

if [[ -z ${subdomain} ]]; then
  message="the Cloudflare account did not answer with a workers.dev subdomain"
  ((require == 1)) && fail "${message}, so ${worker_name}'s origin cannot be derived. Set the
    HOSTED_RELAY_ORIGIN repository variable to the relay's real origin — a production bundle must
    not ship without a relay default."
  echo "⚠️  ${message}; building with no relay directory" >&2
  exit 0
fi

printf 'https://%s.%s.workers.dev\n' "${worker_name}" "${subdomain}"
echo "ℹ️  relay directory origin derived for ${worker_name} from the Cloudflare account" >&2
