# `@ferretry/relay`

The carrier-agnostic end-to-end session protocol, and the Cloudflare rendezvous that can carry it.

The wire contract lives in **[docs/relay-protocol.md](../../docs/relay-protocol.md)** — that
document, not this code, is the thing to implement against.

## Why this package exists

A daemon behind NAT has no inbound route, so a browser somewhere else cannot reach it. There are two
carriers and one security model across both:

- **Direct** — the browser dials the daemon. Attempted first, automatically, whenever it works.
- **Relay** — a Worker + Durable Object forwarding frames it is structurally unable to read. The
  automatic fallback. Ferretry operates one, with daemon-keyed metering, a runtime kill switch, and
  per-daemon plus account-wide caps.

**Neither is a question a user is asked.** The carrier is behaviour: direct first, hosted relay when
direct does not work, and the live carrier always named on screen so nothing degrades silently.
Running a relay of your own is still possible and still supported, but it is an **expert opt-in
path** with its own runbook — [`docs/cloudflare-relay-self-hosting.md`](../../docs/cloudflare-relay-self-hosting.md) —
not an onboarding option.

No **carrier** address is compiled into this package. The client build does carry one address — the
**discovery origin** it reads the advertisement from, because the relay has its own hostname and the
PWA is a static bundle — and that names a service, never a user or a daemon. The relay endpoint it
ends up using, and the daemon URL it dials, are both runtime values. The hosted Worker serves a
no-store
`/v1/default-relay` advertisement whose address can be changed or set to `null` without releasing or
deploying code. A relay you run yourself still serves exactly the daemon fingerprints its deployer
listed. `docs/relay-protocol.md` §§9, 11 and 13 define both operating modes and their disclosure.

## Layout

| Path                   | What                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------- |
| `src/lib/`             | The protocol itself: framing, handshake, record layer, flow control, rendezvous rules |
| `src/adapters/`        | WebCrypto binding, and the Worker + Durable Object                                    |
| `wrangler.jsonc`       | Deployment configuration for **your** account                                         |
| `wrangler.hosted.json` | Ferretry's separately metered and capped hosted deployment                            |

`src/lib/rendezvous.ts` is the whole rendezvous as a pure state machine; the Durable Object around it
moves bytes and reads clocks and decides nothing.

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

The operator bearer is a domain-separated digest of the GitHub Cloudflare token, installed as a
Worker secret, so neither credential is present in this repository or in a browser bundle. **After
rotating `CLOUDFLARE_API_TOKEN`, run the `deploy` operation once** to reinstall the derived secret —
until you do, every runtime control operation answers `401`.

The metrics **API** is daemon-keyed: connection requests and refusals, exact encoded bytes forwarded,
current/peak concurrent connections, first/last activity and current minute/day windows, globally and
for every daemon. It contains no payload, device token, session content, command, output or name. The
`metrics` workflow operation prints only the account-wide summary and a daemon **count** — the full
inventory of fingerprints is not written into a public Actions log; read it from the authenticated
endpoint instead.

## Status

The protocol, both relay operating modes, the runtime control plane and operator metrics are
implemented and tested.

**The transport is not wired, and that is the honest limit of this package.**
[PR #202](https://github.com/kirinnee/ferretry/pull/202) supplies the discovery half — the PWA reads
and parses `/v1/default-relay` from a build-time `FY_RELAY_DIRECTORY_ORIGIN`, so a browser can learn
the relay's address and whether the operator has switched it off — and surfaces that live state in
onboarding. It stops there deliberately, and says so on the glass: nothing dials a relay.

Nothing here does either. `packages/pwa/src/lib/daemon-transport.ts` builds every request from one
direct `baseUrl`, and `ConnectionMethod` has no consumer outside this package.

What remains is the transport. `packages/daemon/src` has no relay client and no relay configuration
at all, and needs one plus its persisted claim key and a `fy` surface to configure it;
`DaemonConnection` has no carrier field, so `daemon-connection.ts`, `connections.ts`,
`daemon-transport.ts` and `event-transport.ts` move together. Then active-carrier disclosure for a
live session. §13 of the protocol document lists all four pieces. Until they ship, deploying a relay
gets you a relay, not a remote connection.
