# `@ferretry/relay`

The carrier-agnostic end-to-end session protocol, and the Cloudflare rendezvous that can carry it.

The wire contract lives in **[docs/relay-protocol.md](../../docs/relay-protocol.md)** — that
document, not this code, is the thing to implement against.

## Why this package exists

A daemon behind NAT has no inbound route, so a browser somewhere else cannot reach it. There are
three explicit connection choices and one security model across all of them:

- **Direct** — the browser dials the daemon. Preferred whenever it is configured and reachable.
- **Your own relay** — a Worker + Durable Object in your Cloudflare account, forwarding frames it is
  structurally unable to read.
- **Hosted relay** — the same encrypted carrier operated by Ferretry, with daemon-keyed metering,
  runtime kill switch, and per-daemon plus account-wide caps.

There is no relay address compiled into this package. The hosted Worker serves a no-store
`/v1/default-relay` advertisement whose address can be changed or set to `null` without releasing or
deploying code. Your own relay still serves exactly the daemon fingerprints its deployer listed.
`docs/relay-protocol.md` §§9, 11 and 13 define both operating modes and their disclosure.

## Layout

| Path                   | What                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------- |
| `src/lib/`             | The protocol itself: framing, handshake, record layer, flow control, rendezvous rules |
| `src/adapters/`        | WebCrypto binding, and the Worker + Durable Object                                    |
| `wrangler.jsonc`       | Deployment configuration for **your** account                                         |
| `wrangler.hosted.json` | Ferretry's separately metered and capped hosted deployment                            |

`src/lib/rendezvous.ts` is the whole rendezvous as a pure state machine; the Durable Object around it
moves bytes and reads clocks and decides nothing.

## Deploying your own

```
1. put your daemon fingerprint in wrangler.jsonc → vars.RELAY_DAEMON_IDS   (`fy pair` prints it)
2. task relay:deploy
```

Read **"Running your own relay"** in the protocol document first. You will be operating a relay, and
it bills to your account.

## Operating the hosted deployment

`.github/workflows/relay-hosted.yaml` deploys the hosted Worker through the repository's nix shell,
using `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Manual `enable`, `disable` and `metrics`
operations talk to the already-deployed control object; they do not deploy a release. The operator
bearer is a domain-separated digest of the GitHub Cloudflare token and is installed as a Worker
secret, so neither credential is present in this repository or browser bundle.

The metrics response contains connection requests and refusals, exact encoded bytes forwarded,
current/peak concurrent connections, first/last activity and current minute/day windows globally and
for every daemon. It contains no payload, device token, session content, command, output or name.

## Status

The protocol, both relay operating modes, the runtime control plane and operator metrics are tested.
The `fyd` and PWA connection clients are separate units; onboarding consumes the public
advertisement and keeps direct, self-hosted and hosted as explicit choices.
