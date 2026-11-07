# `@ferretry/relay`

The carrier-agnostic end-to-end session protocol, and the Cloudflare rendezvous that can carry it.

The wire contract lives in **[docs/relay-protocol.md](../../docs/relay-protocol.md)** — that
document, not this code, is the thing to implement against.

## Why this package exists

A daemon behind NAT has no inbound route, so a browser somewhere else cannot reach it. There are four
kinds of carrier — direct, WebRTC, a hosted Cloudflare tunnel, and relay — and one security model
across all of them. This package owns the relay: a Worker + Durable Object forwarding frames it is
structurally unable to read. Ferretry operates one, with daemon-keyed metering, a runtime kill
switch, and per-daemon plus account-wide caps.

**The default asks nothing.** A device and machine nobody chose for goes through the relay. A person
may instead choose, per device and machine, **Auto** (direct, then WebRTC, then a tunnel, then
relay), or WebRTC, tunnel or relay only. First-run onboarding asks no carrier question, and the
machine's Connection panel names the live carrier and holds that preference, so nothing degrades
silently. Running a relay of your own remains supported as an **expert opt-in path** with its own
runbook — [`docs/cloudflare-relay-self-hosting.md`](../../docs/cloudflare-relay-self-hosting.md). The
carrier rules are in [docs/relay-protocol.md](../../docs/relay-protocol.md) §1 and §15.

No **carrier** address is compiled into this package. The client build does carry one address — the
**discovery origin** it reads the advertisement from, because the relay has its own hostname and the
PWA is a static bundle — and that names a service, never a user or a daemon. The relay endpoint it
ends up using, and the daemon URL it dials, are both runtime values. The hosted Worker serves a
no-store
`/v1/default-relay` advertisement whose address can be changed or set to `null` without releasing or
deploying code. A relay you run yourself still serves exactly the daemon fingerprints its deployer
listed. `docs/relay-protocol.md` §§9, 11 and 13 define both operating modes and their disclosure.

## Layout

| Path                              | What                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------- |
| `src/lib/`                        | The protocol itself: framing, handshake, record layer, flow control, rendezvous rules |
| `src/adapters/`                   | WebCrypto binding, and the Worker + Durable Object                                    |
| `wrangler.jsonc`                  | Deployment configuration for **your** account                                         |
| `wrangler.hosted.json`            | Ferretry's separately metered and capped hosted deployment                            |
| `wrangler.link-store.jsonc`       | Deployment configuration for **your** link store (optional)                           |
| `wrangler.link-store.hosted.json` | Ferretry's hosted link store, a separate Worker (`workers_dev: false`)                |

`src/lib/rendezvous.ts` is the whole rendezvous as a pure state machine; the Durable Object around it
moves bytes and reads clocks and decides nothing.
The hosted tunnel provisioner has the same shape: `src/lib/tunnel-pool.ts` (placement, nonces,
reclaim, the operator view) and `src/lib/tunnel-provisioner.ts` (the call order, behind a
`CloudflareTunnelApi` port and a `TunnelStore` port) decide; `src/adapters/hosted-tunnel-control.ts`
(the `TUNNEL_CONTROL` Durable Object), `hosted-tunnel-routes.ts` and `cloudflare-tunnel-api.ts` move
bytes.

## The link store

A second, separate Worker, `ferretry-link-store`, keeps the sealed envelopes behind catalog links so a
skill can reach someone with no connection to the publisher's machine. It is its own deployment so that
shipping it never restarts the relay's rendezvous objects.

- `src/lib/link-store.ts` is the wire contract; `src/lib/link-store-reducer.ts` is every rule as one pure function.
- `src/adapters/link-store-worker.ts` is the Worker and its three SQLite-backed Durable Objects:
  `LinkBundleDurableObject` (one per link; envelope in rows of at most 512 KiB, an alarm at its end),
  `LinkOwnerDurableObject` (one per daemon; nonces, quota leases) and `LinkStoreControlDurableObject` (the
  singleton; operator switches, limits, global counters, the registry of known ids and the per-IP windows).
- `task link-store:check` rehearses; `task link-store:deploy` publishes your own and **refuses to run in CI or
  unattended** without `LINK_STORE_DEPLOY_UNATTENDED=1`. The hosted one is deployed only by the manual
  `.github/workflows/link-store-hosted.yaml`; there is no automatic deploy.
- Operator switches and limits: `GET|PUT /v1/operator/link-store`, behind the `LINK_STORE_OPERATOR_TOKEN` Worker secret.

**The hosted relay routes to it**: `wrangler.hosted.json` binds it as `LINK_STORE`, and
`src/adapters/hosted-link-store-routes.ts` forwards the store's paths, unchanged and unread, in hosted mode only
(a self-hosted relay has no binding and answers 404). Publishing that is a relay deploy and drops every live
session once; what it drops, for how long and in what order to deploy are `docs/relay-protocol.md` §13 ("The
link-store binding"). The contract, the limits and the honest gaps are `docs/relay-protocol.md` §17; running your own is
"Your own link store" in [`docs/cloudflare-relay-self-hosting.md`](../../docs/cloudflare-relay-self-hosting.md).

## Deploying one of your own (expert)

```
1. put your daemon fingerprint in wrangler.jsonc → vars.RELAY_DAEMON_IDS   (`fy pair` prints it)
2. task relay:check     # compiles and prints bindings; publishes nothing
3. task relay:deploy
```

**[docs/cloudflare-relay-self-hosting.md](../../docs/cloudflare-relay-self-hosting.md) is the
runbook** — plan requirements, the narrowest API token that works, verification, teardown and what it
costs. Read **"Running your own relay"** in the protocol document for what you are taking on: you
will be operating a relay, and it bills to your account.

## Operating the hosted deployment

`.github/workflows/relay-hosted.yaml` deploys the hosted Worker through the repository's nix shell,
using `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. It publishes to the Worker's own
`workers.dev` origin by default; set the `HOSTED_RELAY_ORIGIN` repository variable to advertise a
custom origin instead. Manual `enable`, `disable` and `metrics` operations talk to the
already-deployed control object; they do not deploy a release.

**A deploy drops every live session**: it restarts the Worker and its Durable Objects, so every
daemon and every browser on the relay reconnects. A push to `main` therefore deploys only when it
touches the paths the Worker is built from, and only when the built bundle's fingerprint
(`scripts/ci/relay-bundle-fingerprint.sh`, stamped on each version as its tag) differs from the
version Cloudflare is serving. The operator secret ships with the deploy (`--secrets-file`) rather
than as a second version. A manual `deploy` always publishes.

The operator bearer is a domain-separated digest of the GitHub Cloudflare token, installed as a
Worker secret, so neither credential is present in this repository or in a browser bundle. **After
rotating `CLOUDFLARE_API_TOKEN`, run the `deploy` operation once** to reinstall the derived secret —
until you do, every runtime control operation answers `401`.

**The hosted tunnel service** (`docs/relay-protocol.md` §15) runs in the same Worker, hosted mode only.
Its pool of Cloudflare accounts is the Worker secret `TUNNEL_ACCOUNTS`, installed from the GitHub
secret `HOSTED_TUNNEL_ACCOUNTS` by a publishing `deploy` or, without a deploy, by the `tunnel-accounts`
operation; the `tunnels` operation reads its status and sets `reclaim_after_days`. The runbook is
[docs/cloudflare-tunnel-pool.md](../../docs/cloudflare-tunnel-pool.md).

The metrics **API** is daemon-keyed: connection requests and refusals, exact encoded bytes forwarded,
current/peak concurrent connections, first/last activity and current minute/day windows, globally and
for every daemon. It contains no payload, device token, session content, command, output or name. The
`metrics` workflow operation prints only the account-wide summary and a daemon **count** — the full
inventory of fingerprints is not written into a public Actions log; read it from the authenticated
endpoint instead.

## Status

The protocol, both relay operating modes, the runtime control plane and operator metrics are
implemented and tested.

**Both ends of the transport are live.** The daemon dials (`packages/daemon/src/lib/relay` and
`src/adapters/relay`), the browser opens sessions over whichever carrier wins
(`packages/pwa/src/lib/relay-session.ts`, `relay-carrier.ts`), and both ends discover the hosted
default from `HOSTED_RELAY_DIRECTORY_ORIGIN`. Deploying a relay gets you every
request/response route and the live event, terminal and remote-browser streams. First pairing over
the hosted rendezvous works even when the daemon's direct address is unreachable; a daemon whose
only relay is one you run needs a directly reachable first contact.

What is still open is listed in [docs/relay-protocol.md §13](../../docs/relay-protocol.md): there is no
`fy` verb to edit the daemon's `carriers` list (an operator writes it into
`<state home>/config/daemon.json` by hand), a fresh device can discover only the hosted rendezvous,
and no surface yet renders the session-ceiling refusal (`4429`).
