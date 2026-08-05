#!/usr/bin/env bash
set -euo pipefail

# The hosted relay has no test that can fail for it.
#
# Its Worker config, its deploy workflow and the operator control plane only meet each other in
# production: `bun test` never reads `wrangler.hosted.json`, and the first execution of the deploy
# job's shell is the real one, against the real account. That gap already cost one shipped defect —
# every operator mutation echoed the GET response back as the PUT body, `updatedAt` and all, and the
# strict endpoint rejected all of them, so the relay could not be enabled and the kill switch could
# not be flipped. Nothing in CI noticed, because nothing in CI looked.
#
# So this gate looks. Where it can, it does so by BEHAVIOUR rather than by prose: the jq programs
# below are the exact strings the workflow runs, asserted to be present in the workflow AND executed
# here against a representative control-plane response. A projection that stops producing the strict
# document fails here, at pre-commit, instead of at 3am against production.

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

hosted_config="packages/relay/wrangler.hosted.json"
byo_config="packages/relay/wrangler.jsonc"
workflow=".github/workflows/relay-hosted.yaml"
ci_workflow=".github/workflows/ci.yaml"
worker="packages/relay/src/adapters/worker.ts"
control="packages/relay/src/adapters/hosted-control.ts"

fail() {
  echo "❌ $*" >&2
  exit 1
}

# ─── the Worker configuration ─────────────────────────────────────────────────────────────────

assert_hosted() {
  jq -e "$1" "${hosted_config}" >/dev/null 2>&1 || fail "${hosted_config}: $2"
}

# `RELAY_MODE` is the whole hosted/self-hosted switch. Lose it and `relayMode()` reads the
# deployment as self-hosted, which serves the fingerprints in `RELAY_DAEMON_IDS` — an unset list,
# so the hosted relay would answer 404 for everybody while looking perfectly healthy.
assert_hosted '.vars.RELAY_MODE == "hosted"' 'vars.RELAY_MODE must be "hosted"'
# An allowlist here is a contradiction the code cannot report: hosted mode never consults it, so a
# fingerprint list would read as access control while enforcing nothing.
assert_hosted '.vars | has("RELAY_DAEMON_IDS") | not' 'a hosted deployment must not carry RELAY_DAEMON_IDS'
assert_hosted '.main == "src/adapters/worker.ts"' 'main must stay the Worker entry that exports both Durable Objects'
# The deploy job derives this deployment's public origin from the Worker name plus the account's
# workers.dev subdomain. A rename would leave the workflow probing a hostname that does not exist,
# and the failure would be an opaque curl error rather than anything naming the cause.
assert_hosted '.name == "ferretry-hosted-relay"' 'name is the origin the deploy workflow derives; it cannot drift alone'
assert_hosted '.workers_dev == true' 'workers.dev must stay enabled; it is the origin discovery falls back to'
assert_hosted '.observability.enabled == true' 'observability is how an operator sees a failing deployment at all'

# Two bindings, exactly. `RENDEZVOUS` carries sessions; `RELAY_CONTROL` is the single global meter,
# kill switch and admission controller. Without the second one every hosted request refuses with
# "hosted relay accounting is unavailable" — fail-closed, but completely dead.
assert_hosted '
  [.durable_objects.bindings[] | {name, class_name}] | sort_by(.name) == [
    {name: "RELAY_CONTROL", class_name: "HostedRelayControlDurableObject"},
    {name: "RENDEZVOUS", class_name: "RendezvousDurableObject"}
  ]
' 'durable_objects.bindings must bind exactly RENDEZVOUS and RELAY_CONTROL to their classes'

# SQLite-backed classes are what the Workers Free plan allows, and `new_classes` would silently
# provision the key-value backend instead — a different storage product under the same code.
assert_hosted '
  ([.migrations[].new_sqlite_classes // []] | flatten | sort)
    == ["HostedRelayControlDurableObject", "RendezvousDurableObject"]
' 'migrations must declare both Durable Object classes as new_sqlite_classes'
assert_hosted '[.migrations[] | keys[]] | index("new_classes") | not' 'migrations must not use the key-value new_classes backend'

# A class named in a migration that the entry module does not export is a deploy-time failure in
# production and nothing at all here, so check the two halves agree.
for class_name in RendezvousDurableObject HostedRelayControlDurableObject; do
  rg -q "\b${class_name}\b" "${worker}" ||
    fail "${worker} does not export ${class_name}, which ${hosted_config} deploys"
done

# The opposite drift, and the dangerous one: hosted mode skips the fingerprint allowlist entirely
# because it serves everybody. Setting it in the bring-your-own config would turn somebody's private
# relay into an open one, silently, with their account paying for it.
if rg -q '"RELAY_MODE"' "${byo_config}"; then
  fail "${byo_config} must never set RELAY_MODE; hosted mode ignores the fingerprint allowlist"
fi
rg -q '"RELAY_DAEMON_IDS"' "${byo_config}" ||
  fail "${byo_config} must keep RELAY_DAEMON_IDS; it is the whole access control of a self-hosted relay"

# ─── the deploy and control workflow ──────────────────────────────────────────────────────────

rg -qF -- '--config wrangler.hosted.json' "${workflow}" ||
  fail "${workflow} must deploy and set secrets against ${hosted_config}"
rg -qF -- 'wrangler deploy --dry-run --config wrangler.jsonc' "${ci_workflow}" ||
  fail "${ci_workflow} must compile the self-hosted relay configuration"
rg -qF -- 'wrangler deploy --dry-run --config wrangler.hosted.json' "${ci_workflow}" ||
  fail "${ci_workflow} must compile the hosted relay configuration"
# A clean Actions checkout has no node_modules. Both the credential-free rehearsal and the real
# deployment must install from inside the relay package before Wrangler bundles workspace imports;
# otherwise @ferretry/protocol and zod disappear only in CI/production while a prepared developer
# checkout keeps passing. Keep this package-local, matching the repository's other build scripts.
for worker_workflow in "${workflow}" "${ci_workflow}"; do
  rg -U -q 'cd packages/relay[[:space:]]*\n[[:space:]]*bun install --frozen-lockfile' "${worker_workflow}" ||
    fail "${worker_workflow} must install locked relay workspace dependencies before Wrangler runs"
done
if rg -qF -- 'bunx wrangler' "${workflow}"; then
  fail "${workflow} must use the flake-locked Wrangler, not resolve npm latest with bunx"
fi

# The derived operator bearer is a digest of a registered secret, not the secret, so GitHub masks
# nothing about it on its own. Both jobs must register it before use.
mask_count="$(rg -cF -- '::add-mask::$operator_token' "${workflow}" || true)"
[[ ${mask_count} -ge 2 ]] ||
  fail "${workflow} must mask the derived operator bearer in both the deploy and control jobs"

# Constants the workflow addresses by hand. Renaming one in the adapter and not the other turns
# every operator request into a 404 that no test would see.
pinned_path() {
  rg -o "$1 = '[^']*'" "${control}" | sed "s/.*'\\(.*\\)'/\\1/" | head -n 1
}
for constant in HOSTED_RELAY_OPERATOR_CONFIG_PATH HOSTED_RELAY_OPERATOR_METRICS_PATH HOSTED_RELAY_PUBLIC_PATH; do
  path="$(pinned_path "${constant}")"
  [[ -n ${path} ]] || fail "${control} no longer declares ${constant}"
  rg -qF -- "${path}" "${workflow}" ||
    fail "${workflow} does not address ${path}, the route ${constant} declares"
done

rg -qF -- "https://$(jq -r '.name' "${hosted_config}").\$worker_subdomain.workers.dev" "${workflow}" ||
  fail "${workflow} derives an origin that does not match the Worker name in ${hosted_config}"

# ─── both ends must read the SAME advertisement, from the same path ───────────────────────────
#
# A session crosses a relay only if BOTH ends are on it. Three modules now spell the discovery path:
# the Worker that serves the document, the browser that reads it, and the daemon that reads it to
# decide whether it dials anything at all. A daemon that discovered nothing while a browser reported
# the relay as healthy is precisely the shape of failure this product has already shipped, and the
# path drifting by one character is enough to cause it.
public_path="$(pinned_path HOSTED_RELAY_PUBLIC_PATH)"
for reader in \
  "packages/pwa/src/features/onboarding/hosted-relay.ts" \
  "packages/daemon/src/lib/relay/discovery.ts"; do
  rg -qF -- "'${public_path}'" "${reader}" ||
    fail "${reader} does not read the advertisement from ${public_path}, the path ${control} serves"
done

# ─── the daemon half must actually be given a directory to ask ────────────────────────────────
#
# The daemon binds loopback and is reachable from another device only over a rendezvous it dialled
# outbound. It has nothing to dial until a directory names one, so a release that ships the binary
# without the discovery origin ships a daemon nobody can reach — silently, and with every test
# passing. Three links in that chain, each asserted where it is written.
daemon_environment="packages/daemon/src/adapters/system/runtime-environment.ts"
compile="scripts/release/compile.sh"
cd_workflow=".github/workflows/cd.yaml"
rg -qF -- '__FY_RELAY_DIRECTORY__' "${daemon_environment}" ||
  fail "${daemon_environment} no longer reads the compiled relay directory origin"
rg -qF -- '__FY_RELAY_DIRECTORY__' "${compile}" ||
  fail "${compile} no longer bakes the relay directory origin into the daemon binary"
rg -qF -- 'relay-directory-origin.sh --require' "${cd_workflow}" ||
  fail "${cd_workflow} must resolve the relay directory origin, and must fail rather than ship without one"
# The origin is a SERVICE address resolved at build time; a carrier address compiled into either end
# would put the half of this contract that must stay runtime into a release.
if rg -qF -- 'workers.dev' "${daemon_environment}"; then
  fail "${daemon_environment} names a relay hostname; the build carries a directory origin, never a carrier"
fi

# ─── the strict configuration document, proved by running the real projections ────────────────

# These three strings are the jq programs the workflow executes. They are asserted to be present in
# the workflow and then run here, so the gate cannot drift from the thing it is gating.
# `$relay_url` is a jq variable bound by `--arg`, not a shell one, and this string has to stay
# byte-identical to what the workflow runs or the comparison below is worthless. Escaping it is not
# an option: shfmt normalises the escaped form straight back to these single quotes.
# shellcheck disable=SC2016
seed_projection='.configuration | {version, relayUrl: $relay_url, limits}'
disable_projection='.configuration | {version, relayUrl: null, limits}'
metrics_projection='{configured, configuration, global, observedAt, daemonCount: (.daemons | length)}'

# Initial seed and enable share one program; disable is its own.
enable_count="$(rg -cF -- "${seed_projection}" "${workflow}" || true)"
[[ ${enable_count} -ge 2 ]] ||
  fail "${workflow} must project {version, relayUrl, limits} for both the initial seed and enable"
rg -qF -- "${disable_projection}" "${workflow}" ||
  fail "${workflow} must project {version, relayUrl, limits} for disable"

# The shape that shipped broken: PUTting the stored document straight back, `updatedAt` included.
if rg -qF -- '.configuration | .relayUrl =' "${workflow}"; then
  fail "${workflow} echoes the GET document back as the PUT body; the strict endpoint rejects updatedAt"
fi

# What `GET /v1/operator/config` actually answers: the stored document, which carries the
# server-owned `updatedAt` the strict input schema refuses.
stored_response='{
  "configured": true,
  "configuration": {
    "version": 1,
    "relayUrl": "https://old.example",
    "limits": {"maxConcurrentConnectionsPerDaemon": 16, "maxTrackedDaemons": 10000},
    "updatedAt": 1785000000000
  }
}'
expected_keys='["limits","relayUrl","version"]'

assert_body() { # projected-body, expected-relayUrl-json, label
  [[ "$(jq -c 'keys' <<<"$1")" == "${expected_keys}" ]] ||
    fail "the ${3} projection no longer produces exactly {version, relayUrl, limits}"
  [[ "$(jq -c '.relayUrl' <<<"$1")" == "$2" ]] || fail "the ${3} projection set the wrong relayUrl"
  # Dropping the operator's ceilings would reset every limit to the schema default on the next write.
  [[ "$(jq -c '.limits.maxTrackedDaemons' <<<"$1")" == '10000' ]] ||
    fail "the ${3} projection dropped the operator's configured limits"
}

assert_body "$(jq -c --arg relay_url 'https://relay.example' "${seed_projection}" <<<"${stored_response}")" \
  '"https://relay.example"' 'seed/enable'
assert_body "$(jq -c "${disable_projection}" <<<"${stored_response}")" 'null' 'disable'

# ─── the metrics summary must not publish the fingerprint inventory ───────────────────────────

rg -qF -- "${metrics_projection}" "${workflow}" ||
  fail "${workflow} must summarise operator metrics rather than printing every daemon row"

metrics_response='{
  "configured": true,
  "configuration": {"version": 1, "relayUrl": "https://relay.example", "limits": {}, "updatedAt": 1},
  "global": {"requestCount": 9, "bytesRelayed": 123, "trackedDaemons": 2},
  "daemons": [
    {"daemonId": "fy_daemon_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bytesRelayed": 100},
    {"daemonId": "fy_daemon_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "bytesRelayed": 23}
  ],
  "observedAt": 1785000200000
}'
metrics_summary="$(jq -c "${metrics_projection}" <<<"${metrics_response}")"
# A fingerprint is public one at a time; the whole list of them is the hosted user base, and a
# public repository's Actions log is readable by anyone.
if rg -qF -- 'fy_daemon_' <<<"${metrics_summary}"; then
  fail "the metrics projection prints daemon fingerprints into the Actions log"
fi
[[ "$(jq -c '.daemonCount' <<<"${metrics_summary}")" == '2' ]] ||
  fail "the metrics projection must still report how many daemons are tracked"
[[ "$(jq -c '.global.bytesRelayed' <<<"${metrics_summary}")" == '123' ]] ||
  fail "the metrics projection must still report the account-wide meter"

echo "✅ Hosted relay configuration, deploy workflow and control-plane projections agree"
