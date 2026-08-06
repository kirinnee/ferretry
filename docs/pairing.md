# Pairing — how another device gets access to one machine

A Ferretry daemon serves exactly the devices it has been told to serve. Pairing is the whole of that
decision: a short-lived code is minted on one side, read by the device being added, and exchanged once
for a durable device credential. This document is the contract. Implement against it rather than
against the code, and change it in the same commit as the behaviour.

## The one-sentence version

The machine mints a code that lives for **two minutes** and works **once**; the device that reads it
gets a device token; the machine keeps only a hash of that token and can revoke it at any time.

## What travels, and what never does

| value        | where it lives                                  | who may read it                       |
| ------------ | ----------------------------------------------- | ------------------------------------- |
| pairing code | the daemon's memory for its TTL, and one screen | whoever is being shown the code       |
| pairing id   | the mint response, and revoke URLs              | anybody who may reach the pairing API |
| device token | the redeeming device, once                      | that device, forever after            |
| token digest | `state/devices.json`                            | the daemon, to compare against        |

Two properties hold by construction rather than by discipline:

- **No route returns a device token or anything derived from one.** `PairedDeviceSchema` — the
  projection that crosses the wire — has no field for a digest. A daemon that volunteered one is
  refused by the schema rather than rendered.
- **The code never enters a URL path or query.** Revocation is addressed by **pairing id**, which is a
  non-secret handle the mint answers with for exactly this reason: a URL reaches every access log in
  the path, and a code in a log outlives its two minutes. The pairing _link_ carries the code in a
  **fragment**, which is never sent in an HTTP request.

## The exchange

```
POST /v1/pair/code            (operator minimum, `pairing.use`)   → { pairingId, code, expiresAt, link+reach | refusal }
GET  /v1/pair/code/:pairingId (operator minimum, `pairing.use`)   → pending | redeemed | expired
DELETE /v1/pair/code/:pairingId (operator minimum, `pairing.use`) → the code's fate, never the code
POST /v1/pair                 (none minimum — the code is the credential) → { deviceToken, daemonId, capabilities, carriers }
GET  /v1/pair/devices         (operator minimum, `pairing.use`)   → who may reach this machine
DELETE /v1/pair/devices/:id   (operator minimum, `pairing.use`)   → the remaining list
GET  /v1/carriers             (authenticated minimum, no-store)    → { carriers } — the set, asked again later
```

**`operator` is the route's credential minimum, not an admin token.** Any credential but a warden's
meets it — a paired device's token included — which is what lets a browser, whose only credential comes
from redeeming a pairing code, add the second device. An `admin-token` minimum would have left that
journey where it started: on the command line. The narrowing that remains is the capability demand
beside it, and off the host that is the operator's to switch off.

`POST /v1/pair` is the only public route on this surface, and it is public because a device redeeming a
code has no credential yet — the **code is** the credential for that one request. Everything else either
mints a credential, lists and revokes them, or is read with one.

### Redemption has two carriers, and one of them is not a route

`POST /v1/pair` is the **direct** redemption. A device that cannot reach the daemon's address at all
redeems through a rendezvous instead: a **sealed `pair` record** on a pre-auth relay session, specified
exactly in [relay-protocol.md](relay-protocol.md) §14 — the daemon is proved against the QR-pinned
fingerprint before the code is sent, exactly one attempt per session, one sealed outcome (`paired`
carrying this same redemption response verbatim, or one generic `pair-refused`), then the session
closes. The relayed path is deliberately a **record and not a route**: a pre-auth session issues no
requests, so "`POST /v1/pair` is the only public route on this surface" stays literally true, and no
credential-less request path exists for the next `minimum: 'none'` route to inherit. Direct is still
attempted first, like every other exchange in this product; the rendezvous is the fallback, not a
choice. What a relay operator can and cannot observe about a redemption is §10 and §13 of the same
document: fingerprint, IPs, timing and frame shape — never the code, the token, the device name, or
the outcome.

### What a redemption hands back

`POST /v1/pair` answers with `carriers`: **every way this daemon can be reached**, not merely the address
this device happened to pair over. A phone that learned only the direct address has nothing to fall back
on when it leaves the house, and it cannot discover a rendezvous by itself — each end used to read its own
build-time directory, so the two met only by coincidence of picking the same service.

The daemon resolves that set **once, at boot**, and hands the same value to this response and to the
refresh route below. Neither entry is a secret: a rendezvous address is already known to the rendezvous,
and a daemon address is already known to whoever was authorised to pair. The daemon **fingerprint** is the
secret in this subject and it is not on the list — the wire schema has no field for one. The full carrier
contract is [relay-protocol.md](relay-protocol.md) §13.

### Asking again — `GET /v1/carriers`

A set published only at pairing time goes stale while both halves stay healthy: an operator changes or
switches off a rendezvous, and the only repair a device has is to pair again. This route is the second
moment.

- **`authenticated`**, so any caller this daemon issued a credential to may refresh its own copy —
  including a paired device and the capability-scoped warden. One class higher would refuse the reader
  that needs it and protect nothing.
- **`no-store`**, because the entire value of the answer is that it is current. A cached copy re-serves
  the rendezvous the operator just switched off.
- **Not `privilegedOnly`, and no capability demand.** A caller on the host already has the machine and
  needs no list; the remote phone is the reader. And an operator who switches `pairing` off to stop **new**
  devices being added must not thereby strand the devices already paired on a rendezvous this daemon no
  longer dials.
- **Read-only.** There is no `POST`, `PUT` or `DELETE` here. A device may learn where this daemon can be
  reached and can never re-point it: that is a change to the operator's own document.

**The daemon is authoritative and a client's copy is a cache.** A client REPLACES its stored set with this
answer rather than merging into it — that is what makes both halves of a disagreement resolve, because a
relay the daemon dropped disappears instead of being dialled forever, and a relay the daemon added arrives
without anybody re-pairing. A merge would only ever fix the second.

**This route is not a way in.** It is reached with the token redemption already issued, on any
carrier. Pairing itself now has a relayed form too — the sealed record above, not a route — so first
contact no longer requires an address reachable on its own: a daemon that publishes a rendezvous is
pairable by a phone that can never dial it directly.

### Who may mint

Read [grants.md](grants.md) first: minting is governed by the `pairing` capability, so a caller **on the
host** is ungoverned and a caller **off the host** mints while the operator leaves `pairing` on. The two
facts a UI needs before it offers anything — whether this request arrived on the host, and which grant is
the caller's own — are on `GET /v1/pair/devices` as `hostLocal` and `thisDeviceId`. Both are
carrier-derived and server-derived respectively; neither may be inferred in a browser.

### Who may redeem

**Never mint a link without saying who can redeem it.** The advertisement decision has three answers,
and the mint response carries that answer rather than making each renderer infer it again:

- `reach: "any-device"` accompanies an address another device can dial. The command line and browser
  panel show the link and draw its QR.
- `reach: "local-only"` accompanies a loopback address, and describes the **direct** address alone.
  Alone, it means no QR: on a phone, loopback names the phone. Beside a `relayCandidate` it no longer
  means unredeemable — the QR is drawn, because another device can redeem the link through the named
  rendezvous — and the notice says what that rendezvous can observe. `localOnlyNotice` owns both
  sentences; no surface re-derives the answer, and
  `invitationRedeemableByAnotherDevice` in `@ferretry/protocol` is the one narrowing that decides
  whether a QR is drawn at all.
- `refusal` replaces `daemonUrl`, `pairUrl`, and `reach` when a wildcard bind or missing port leaves no
  address to hand out. The daemon still mints the short-lived code; the surfaces show no link and name
  the fix for **that** reason. A refusal never carries a `relayCandidate` — the supported invariant,
  enforced by the schema, is that **a relay candidate only ever rides beside a link**: the redeeming
  device's connection model has no shape for a daemon with no address at all, and the `v2` fragment
  requires one.

### The link names its relay candidate, in a versioned fragment

A mint whose daemon publishes at least one rendezvous carries `relayCandidate` — the **first relay in
the daemon's published order** — and its link uses the **v2** fragment form,
`#v2;url=…;code=…;fp=…;relay=…`; a mint with no rendezvous keeps the v1 form unchanged. One codec in
`@ferretry/protocol` (`formatPairingFragment` / `parsePairingFragment`) writes and reads both forms,
so the daemon and the browser cannot hold different opinions about the same string: readers accept
both versions, require `url`/`code`/`fp`, ignore an unrecognised field name, refuse a duplicated one,
honour `relay` only under v2, and **drop** a candidate that fails the published-relay URL rule rather
than failing a link whose direct half still works. The candidate serves **one redemption** and is
never stored — what a device navigates by afterwards is the redemption response's `carriers`, and the
browser refuses a relayed pairing whose published set does not name the rendezvous the exchange
crossed ([relay-protocol.md](relay-protocol.md) §14).

**Rollout is ordered:** a reader older than v2 fails a v2 link outright, direct pairing included, so
the reader that accepts both forms deploys — as the hosted app, which ships ahead of the daemon
binary — **before** any daemon emits v2. The ordering is contract; release notes state it.

**A remedy that cannot be followed is a dead end with extra steps**, so there is one per reason rather
than one for all of them — `localOnlyNotice` and `refusalNotice` in `@ferretry/protocol` own every
sentence, and `fy pair`, the Add-a-device panel and `fyd --check` all render those and never their own:

| reason          | what actually fixes it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local-only`    | **bind first, then advertise**: `"host": "0.0.0.0"` _and_ `"publicUrl"` set to the address other devices reach this machine at, then restart. `publicUrl` alone changes nothing about the interface the daemon listens on, so on its own it turns an honest "only this machine can redeem it" into a QR a phone scans and then cannot connect to. The sentence names the exposure the wildcard opens — it accepts connections from other devices on the network — because that widening is the fix, not a side effect. The wildcard keeps loopback available, so commands on the machine are unaffected. |
| `wildcard-bind` | `"publicUrl"` alone, then restart — the daemon is already listening everywhere and needs only a single address to hand out.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `no-port`       | start the daemon once so it records the port it takes, or write `"port"` down. `publicUrl` cannot supply an address nothing has bound.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

The example address in each sentence carries **this daemon's** port, taken from the address the reader
was just shown — a first boot whose preferred port was taken is serving on another one, and an example
naming the compiled-in default is advice to type the wrong number.

Because the wildcard-plus-`publicUrl` pair is the documented answer rather than a suspicious one,
`advertisesForeignAddress` reports nothing for a wildcard bind: the boot notice that offers to remove a
`publicUrl` which "is not deliberate" must never fire at the operator who just deliberately added it.

Where a client on the machine **dials** the daemon is a different fact and is read from the recorded
bind (`recordedBindAddress`), never from `publicUrl`. A wildcard bind resolves to loopback at the
recorded port. Reading the advertisement there made an operator who followed the remedy unable to run
`fy pair` at all — the local client classified the daemon on its own desk as remote and refused to send
the owner-only token, which is the rule working correctly on the wrong input. `FY_URL` still wins
outright, and a genuinely remote daemon still requires its own `FY_TOKEN`.

The requester's own carrier never changes this answer. `ApiRequest.loopback` says who is **minting**,
not who will **redeem**; the normal phone journey is minted locally and redeemed elsewhere.

### What bounds a guess

- a **two-minute** TTL and a **five-attempt** budget per code, whichever comes first;
- a **separate relay budget** per code for attempts arriving through a rendezvous, which can never
  spend the direct five: without the split, anyone on the internet who knows a public fingerprint
  could expire a code sitting on somebody's desk. Exhausting the relay budget closes the **relay**
  path for that code and leaves a device on the LAN able to redeem it —
  [relay-protocol.md](relay-protocol.md) §14 owns the numbers and the disclosure;
- a fixed-window rate limit per peer, independent of that budget, so broken uploads cannot spend it —
  and a relayed caller's rate-limit identity is derived from its rendezvous session, never collapsed
  into a bucket the whole internet shares;
- one active code per daemon: minting **replaces** its predecessor, which is why a UI must not offer a
  mint button beside a live code;
- the comparison is constant-time and runs even when there is no active code, so timing says nothing
  about whether one exists.

## The QR code is a live credential

Whatever draws a QR of a pairing link is handling a credential for somebody's machine, so:

- **Generate it locally.** Never call a QR image service and never put a pairing URL in any third-party
  request. The browser does it with `packages/pwa/src/lib/qr-code.ts` — a pure byte-mode encoder in the
  bundle — and the command line does it with block characters in the terminal.
- **Never announce it.** The rendered symbol's accessible name says what it _is_, never what it encodes:
  a screen reader reading a pairing URL aloud puts a credential in the accessibility tree.
- **Never persist it.** No store, no `localStorage`, no URL, no log, no memo keyed by input. A code lives
  in component state for its TTL and then it is gone.
- **Never screenshot a real one.** Committed captures use a fixed fake code (`HARNESS_INVITE`). A QR is a
  machine-readable label, not obfuscation, so a PNG of a real code in a repository is a leaked credential.

## Revoking

Two different things are revocable and they are not the same act:

- **A code** — ends the window early. Idempotent for a code the daemon knows; a 404 for an id it never
  minted, because "revoked" and "there was nothing here" are different answers and a screen that cannot
  tell them apart claims to have closed a door it never found. A code that was already **redeemed** stays
  reported as redeemed rather than becoming "expired": a device got in, and saying otherwise is a lie.
- **A device** — ends its access. The document is written **first**, and only a successful write drops the
  live grant from the registry; the other order turns a failed write into a phone that stops working now
  and works again after a restart. There is no `await` between the two, so no request can authenticate
  against a credential the daemon has already promised to forget.

**Order matters when a device is stolen: revoke the device first, then switch `pairing` off.** Both acts
carry the same `pairing.use` demand, so turning the capability off from away from the machine also refuses
the revoke — and turning it back on is a local act. See [grants.md](grants.md).

Revoking the credential **you are currently using** is legitimate — handing a laptop back is exactly that
— so it is offered rather than blocked. What is not acceptable is being surprised by it, which is why each
row states what its revoke will do before the press.

## Where it lives

| concern                     | module                                                             |
| --------------------------- | ------------------------------------------------------------------ |
| the state machine           | `packages/daemon/src/lib/pairing/service.ts`                       |
| the routes and their minima | `packages/daemon/src/lib/runtime/mounts/pairing.ts`                |
| the carrier refresh         | `packages/daemon/src/lib/runtime/mounts/carriers.ts`               |
| durable identity and grants | `packages/daemon/src/adapters/pairing/state-pairing-repository.ts` |
| the wire contract           | `packages/protocol/src/lib/pairing.ts`                             |
| the command line            | `packages/cli/src/lib/pair/`                                       |
| the browser panel           | `packages/pwa/src/features/settings/add-device-settings.tsx`       |
| the QR encoder              | `packages/pwa/src/lib/qr-code.ts`                                  |

## Declared GAPs

- **`lastSeenAt` is never updated after pairing.** It is written once, at redemption, so the device list
  shows when a grant was created and not when the daemon last heard from it. The field is served because
  the shape is right; a UI must not present it as recent activity until something advances it.
- **A device cannot be renamed.** The name is whatever the device called itself when it redeemed, and it
  is attacker-influenced text bounded by `PairingDeviceNameSchema`. Two phones that both say "Chrome" are
  told apart only by when they were added.
- **There is no pairing audit record.** A revoked device leaves no trace beyond its absence from
  `devices.json`, so "when did this credential go away, and who ended it" is not answerable. The grant
  layer has an audit journal; this does not.
- **A device token never expires.** Revocation is the only way one ends. There is no rotation, no
  last-used cutoff and no maximum age, so a phone that redeemed a code a year ago is still a device.
- **The browser cannot scan on WebKit.** `BarcodeDetector` is Chromium-only, so the in-app scanner is
  absent there. This is not the blocked path it looks like — the intended carrier is the phone's own
  camera app, which opens the PWA pre-filled on every platform — but a reader who opened the app first
  gets the paste field rather than a bundled decoder every visitor would have to download.
- **`pairing.configure` governs no route.** Like `terminal` and `browser`, its configure
  axis governs exactly one thing: whether a remote caller may re-grant the capability. See
  [grants.md](grants.md).
- **Relayed redemption is specified and not yet implemented on either end.** The contract — the sealed
  record, the budgets, the v2 fragment, the ordering — is [relay-protocol.md](relay-protocol.md) §14,
  and §13 of the same document tracks which pieces exist. Until both ends implement it, a phone that
  cannot reach a daemon's address still cannot pair with it.
