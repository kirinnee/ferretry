# `@ferretry/relay`

The carrier-agnostic end-to-end session protocol, and the Cloudflare rendezvous that can carry it.

The wire contract lives in **[docs/relay-protocol.md](../../docs/relay-protocol.md)** — that
document, not this code, is the thing to implement against.

## Why this package exists

A daemon behind NAT has no inbound route, so a browser somewhere else cannot reach it. There are two
carriers and one security model across both:

- **Direct** — the browser dials the daemon. Preferred whenever it is configured and reachable.
- **Your own relay** — a Worker + Durable Object in your Cloudflare account, forwarding frames it is
  structurally unable to read.

There is **no hosted relay and no default relay address**. A relay serves the daemon fingerprints its
deployer listed, and nobody else. `docs/relay-protocol.md` §9 and §11 explain why.

## Layout

| Path             | What                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------- |
| `src/lib/`       | The protocol itself: framing, handshake, record layer, flow control, rendezvous rules |
| `src/adapters/`  | WebCrypto binding, and the Worker + Durable Object                                    |
| `wrangler.jsonc` | Deployment configuration for **your** account                                         |

`src/lib/rendezvous.ts` is the whole rendezvous as a pure state machine; the Durable Object around it
moves bytes and reads clocks and decides nothing.

## Deploying your own

```
1. put your daemon fingerprint in wrangler.jsonc → vars.RELAY_DAEMON_IDS   (`fy pair` prints it)
2. task relay:deploy
```

Read **"Running your own relay"** in the protocol document first. You will be operating a relay, and
it bills to your account.

## Status

The protocol and the relay are complete and tested. The `fyd` client and the PWA client that speak
this contract are separate units and are **not** in this package; nothing here is wired into
onboarding yet.
