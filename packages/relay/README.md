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

**Neither should be a question a user is asked.** The required carrier behaviour is direct first,
hosted relay when direct does not work, and the live carrier always named on screen so nothing
degrades silently. The current PWA still carries an interim three-way chooser and self-hosting setup
route; removing those is an explicit GAP. Running a relay of your own remains supported as an
**expert opt-in path** with its own runbook —
[`docs/cloudflare-relay-self-hosting.md`](../../docs/cloudflare-relay-self-hosting.md).

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

**The DAEMON end of the transport is wired; the BROWSER end is not.** That is the honest limit today,
and it is a different limit from the one this section described before.

[PR #202](https://github.com/kirinnee/ferretry/pull/202) supplies discovery — both ends compile
`HOSTED_RELAY_DIRECTORY_ORIGIN` from this package's one source constant, then read and parse
`/v1/default-relay` at runtime. The temporary personal `workers.dev` default is shared by forks too;
the operator can still switch the advertised carrier off without a release.

`packages/daemon` now dials. `src/lib/relay` holds the daemon half of the rendezvous — the claim it
signs with the key pairing already minted, the per-session handshake, the record layer, the credit
window, and the tunnel in §14 that carries one request and one answer into the daemon's own route
table. `src/adapters/relay` is the outbound socket, its redial and its liveness sweep, and
`DaemonRelayConfigSchema` is where an operator points it at an address. It is proved end to end over a
real WebSocket against a server that verifies the claim and runs the client half.

What remains is the BROWSER end. `packages/pwa/src/lib/daemon-transport.ts` still builds every request
from one direct `baseUrl`, and `ConnectionMethod` still has no consumer outside this package, so
`daemon-connection.ts`, `connections.ts`, `daemon-transport.ts` and `event-transport.ts` still move
together — followed by active-carrier disclosure for a live session and removal of the interim
chooser. §13 of the protocol document lists each piece and its state. Until the browser end ships,
deploying a relay gets you a relay and a daemon sitting in it, not a remote connection.

Two shapes the tunnel does not carry on either end, named in §14 rather than left to be discovered:
the protocol-switching surfaces (`/v1/events`, terminal streams) and the byte-shaped dictation routes.
There is also no `fy` verb for the configuration block yet — an operator writes `relay` into
`<state home>/config/daemon.json` by hand.
