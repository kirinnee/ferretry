# The Ferretry rendezvous protocol

`ferretry-relay/1`

This document is the contract. It is written so that somebody with no access to this repository can
implement either endpoint, or a compatible relay, in another language. Where an implementation
choice would be invisible on the wire it is still stated, because two implementations that differ
invisibly are the expensive kind.

Reference implementation: `packages/relay`. The pure protocol is `src/lib`; the Cloudflare
deployment is `src/adapters`.

---

## 1. What problem this solves

`fyd` runs on a machine behind NAT. The PWA runs in a browser somewhere else. Pairing already hands
the browser a daemon address and a **key fingerprint**; what was missing was a way to make that
address reachable when the daemon has no inbound route.

There are two carriers and one security model across both.

| Carrier    | What it is                                                                    | Where it belongs                                                  |
| ---------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **Direct** | The browser opens a WebSocket straight at the daemon.                         | Attempted first, automatically, whenever the daemon is reachable. |
| **Relay**  | A Cloudflare Worker + Durable Object forwarding opaque frames it cannot read. | The automatic fallback when direct is not. Ferretry operates one. |

**Neither is a question a conforming product asks.** The required behaviour is: try direct first
because it has fewer hops and fewer observers; fall back to the hosted relay when direct does not
work; and always say which carrier is live and why the other was passed over. No carrier chooser,
nothing to opt into, and no silent degradation — a surface that shows a connection without naming
its carrier is not conforming. The current PWA still contains an interim three-way chooser and
self-hosting setup route; §13 lists their removal as unbuilt work rather than pretending otherwise.

The decision layer for that behaviour is in this package today: `connectionPreferenceOrder` in
`packages/relay/src/lib/connection.ts` orders direct first, and `chooseConnection` returns the
which-carrier-and-why sentence a surface can show verbatim. Discovery — learning the hosted relay's
address and reading its kill switch — is provided by [PR #202](https://github.com/kirinnee/ferretry/pull/202).
**The transport now exists on both sides** — `fyd` dials a rendezvous and carries a session, and the
browser arrives at one, attempting direct first and falling back automatically. What a phone can do
over a relay is every request/response route and nothing that needs a stream; "What is not built yet"
in §13 names each remaining shape exactly.

Three addresses are involved and they are deliberately not the same thing:

| Address              | Where it comes from                                                                                                                                | Compiled in? |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| **Discovery origin** | Where the relay advertisement is read from. The relay has its own hostname, and the PWA is a static bundle, so the browser build carries this one. | **Yes**      |
| **Relay endpoint**   | The carrier actually used, served at runtime by that advertisement as `relayUrl` — or `null`, meaning no hosted carrier.                           | No           |
| **Daemon URL**       | Where one daemon lives. Handed to the browser by pairing, per user.                                                                                | No           |

The discovery origin names a **service**, not a person: it identifies the relay, and it is the same
string for everybody, so it discloses nothing about who is running a daemon or where. The address
that actually carries traffic is the runtime one, which is why changing the relay — including
disabling it entirely — needs no app release and no Worker deploy. Section 13 is the hosted
operating contract.

Anyone who would rather run the carrier themselves still can — the Worker in this repository deploys
to any Cloudflare account, and this document is the contract, so it can also be reimplemented from
scratch. That is an **expert opt-in path with its own runbook**
([`cloudflare-relay-self-hosting.md`](cloudflare-relay-self-hosting.md)). The required product keeps
it out of onboarding and ordinary setup rather than offering a third thing to decide about; the
current interim chooser has not caught up with that contract yet.

---

## 2. The security model, in one paragraph

Encryption terminates at `fyd` and at the browser. Never at the edge.

The daemon holds a long-term **Ed25519** identity created at install; its SHA-256 fingerprint is the
`daemonId`, and the pairing QR already carries that fingerprint out of band. Every session runs an
ephemeral **X25519** key agreement, authenticated by an Ed25519 signature from the daemon over the
whole handshake transcript, and every byte after that is **AES-256-GCM** with the frame header as
associated data. The client authenticates itself afterwards, inside the encrypted channel, with the
device token pairing already gave it.

That is the TLS 1.3 arrangement — ephemeral agreement for forward secrecy, a signature over the
transcript for identity, client credentials only after the channel is keyed — and it is chosen
because it is standard and reviewed, not because it is clever. Nothing here is invented.

The result: a relay operator, including a hostile one, can drop your traffic, delay it or refuse to
carry it. They cannot read it, alter it, or insert into it, and they cannot introduce your browser
to a daemon that is not yours.

**What a relay operator can still see** is in §10. It is more than nothing, and pretending otherwise
would be worse than disclosing it.

---

## 3. Wire format: frames

Everything on the wire is one binary WebSocket message carrying one frame. The framing is identical
on both carriers — a relayed conversation and a direct one are byte-for-byte the same above the
socket — with one exception noted in §8.

```
offset  size  field
0       1     magic      0xFE
1       1     version    0x01
2       1     kind       see below
3       1     reserved   0x00
4       16    sessionId  all zero addresses the rendezvous itself
20      8     sequence   unsigned 64-bit, big-endian
28      ...   payload
```

Header length is **28 bytes**. Maximum total frame length is **65536 bytes**.

| kind   | name        | scope      | payload                                            |
| ------ | ----------- | ---------- | -------------------------------------------------- |
| `0x01` | `control`   | hop-by-hop | UTF-8 JSON, §5. Absent on a direct carrier.        |
| `0x02` | `handshake` | end-to-end | UTF-8 JSON, §6. Opaque to a relay.                 |
| `0x03` | `data`      | end-to-end | AES-256-GCM ciphertext‖tag, §7. Opaque to a relay. |
| `0x04` | `credit`    | hop-by-hop | 4 bytes, unsigned 32-bit big-endian, §8.           |

A receiver **must** refuse a frame that is shorter than the header, longer than the maximum, does
not begin `FE 01`, carries an unknown `kind`, or whose reserved byte is not zero. Every refusal
closes the connection: a party that could not parse a frame does not know what it just failed to
understand, so carrying on is guessing.

Binary encodings inside JSON are **unpadded base64url** (`A–Z a–z 0–9 - _`), never padded, never
with whitespace. A decoder must reject anything else, including a value that decodes but does not
re-encode to the same string.

### Sequence numbers

`handshake` and `data` frames — and only those two — form the end-to-end stream. Each direction has
one counter across both kinds, starting at **0**:

- sequence `0` in each direction is that side's handshake frame;
- sequence `1` onward are records.

`control` and `credit` frames carry sequence `0` and are not part of the stream, so a relay's own
messages never disturb the counter.

A receiver accepts **exactly** the next sequence number. Anything else — a gap, a repeat, a jump —
ends the session (§7). It is never repaired and never skipped.

---

## 4. Addressing

Both carriers use the same path:

```
wss://<host>/v1/rendezvous/<daemonId>/<role>
```

`role` is `daemon` or `client`. On a direct carrier only `client` exists, because the daemon _is_
the server; asking for the daemon role against a direct address is an error, not a URL.

`daemonId` is `fy_daemon_` followed by 43 characters of base64url:

```
daemonId = "fy_daemon_" || base64url( SHA-256( SubjectPublicKeyInfo DER of the daemon Ed25519 public key ) )
```

An Ed25519 SPKI is 44 bytes: the fixed prefix `30 2A 30 05 06 03 2B 65 70 03 21 00` followed by the
32-byte public key.

A relay derives its Durable Object id from the string `ferretry-relay/1:<daemonId>`. One daemon's
state is never reachable as another's.

---

## 5. Relay control (`kind = 0x01`)

Only on a relayed carrier. All messages are a JSON object with a `t` discriminator; unknown shapes
are refused rather than ignored.

### Claiming the rendezvous

A `daemonId` is public. The address alone therefore cannot decide who may hold the slot — anyone who
photographed a QR code could sit in it. The daemon proves possession of the key instead.

```
relay  → daemon   { "t":"challenge", "protocol":"ferretry-relay/1",
                    "nonce": <32 bytes b64url>, "host":"relay.example", "deadlineSeconds":10 }

daemon → relay    { "t":"claim", "protocol":"ferretry-relay/1",
                    "publicKey": <44-byte SPKI b64url>, "signature": <64 bytes b64url> }

relay  → daemon   { "t":"claimed", "protocol":"ferretry-relay/1", "limits": { … } }
```

Both frames use the all-zero `sessionId`.

The signed message is:

```
"ferretry-relay-claim-v1"
  ‖ LP("ferretry-relay/1")
  ‖ LP(daemonId as UTF-8)
  ‖ LP(host as UTF-8)
  ‖ LP(challenge nonce)
```

`LP(x)` is a 4-byte big-endian length followed by `x`. The label is **not** length-prefixed; every
field after it is.

The relay accepts only if **both** hold:

1. `SHA-256(publicKey)` base64url, prefixed with `fy_daemon_`, equals the `daemonId` in the path;
2. the signature verifies under `publicKey` over the message above.

`host` is in the transcript so a hostile relay cannot take a live challenge from an honest one, hand
it over as its own, and use the answer to squat the daemon's slot elsewhere. **A daemon must refuse
to sign a `host` it did not configure.** A mismatch is a misconfiguration or an attack, and both are
worth stopping.

A daemon socket that has not claimed within `deadlineSeconds` is closed (`4402`).

### Sessions

```
relay  → client   { "t":"ready", "protocol":"ferretry-relay/1", "limits": { … } }   sessionId = the new session
relay  → daemon   { "t":"open" }                                                    sessionId = the new session
relay  → either   { "t":"closed", "code":4xxx, "reason":"…" }                       sessionId = the ended session
relay  → either   { "t":"error",  "code":4xxx, "reason":"…" }                        sent immediately before a close
```

The **relay** mints the 16-byte `sessionId` and tells the client what it is. A client may address
only that identifier; using another session's is a protocol error that ends its session.

Either endpoint may end one session without dropping its socket by sending
`{ "t":"closed", "code":…, "reason":… }` addressed to that session. That is how a daemon rejects a
client whose device token it does not recognise.

### Limits

`limits` is published so no endpoint has to guess what will be refused:

```json
{ "maxFrameBytes": 65536, "creditWindowFrames": 32, "maxSessions": 8, "heartbeatSeconds": 30 }
```

---

## 6. The handshake (`kind = 0x02`)

Two frames, one each way, both at sequence `0`.

```
client → daemon   { "t":"hs1", "protocol":"ferretry-relay/1",
                    "epk": <32-byte X25519 public key b64url>,
                    "nonce": <32 bytes b64url>,
                    "daemonId": "fy_daemon_…" }

daemon → client   { "t":"hs2", "protocol":"ferretry-relay/1",
                    "epk": <32-byte X25519 public key b64url>,
                    "nonce": <32 bytes b64url>,
                    "spki": <44-byte SPKI b64url>,
                    "sig":  <64 bytes b64url> }
```

The daemon refuses an `hs1` whose `daemonId` is not its own. On a correct carrier that cannot
happen, which is exactly why it is checked: on an incorrect one it is a misrouted session, and
answering would key a channel to a peer that thinks it reached somebody else.

### Transcript

```
TH = SHA-256(
       "ferretry-relay-handshake-v1"
       ‖ LP(sessionId, 16 raw bytes)
       ‖ LP(hs1.epk      as UTF-8 base64url text)
       ‖ LP(hs1.nonce    as UTF-8 base64url text)
       ‖ LP(hs1.daemonId as UTF-8)
       ‖ LP(hs2.epk      as UTF-8 base64url text)
       ‖ LP(hs2.nonce    as UTF-8 base64url text)
       ‖ LP(hs2.spki     as UTF-8 base64url text)
     )
```

Note the base64url fields enter the transcript **as their text**, not as decoded bytes. That is a
deliberate, checkable choice: it makes the transcript reproducible straight from the JSON a peer
received.

```
sig = Ed25519-Sign( daemon identity key, "ferretry-relay-daemon-auth-v1" ‖ 0x00 ‖ TH )
```

### Client checks, in this order

1. `SHA-256(hs2.spki)` matches the pinned fingerprint. **If it does not, abort** — no signature
   check, no key derivation, and above all no device token.
2. `sig` verifies over `"ferretry-relay-daemon-auth-v1" ‖ 0x00 ‖ TH`.
3. Key agreement (below) yields a usable secret.

### Key schedule

```
IKM = X25519(own ephemeral private, peer ephemeral public)     -- abort if all-zero
k_c2d = HKDF-SHA256(IKM, salt = TH, info = "ferretry-relay-c2d-v1", 32 bytes)
k_d2c = HKDF-SHA256(IKM, salt = TH, info = "ferretry-relay-d2c-v1", 32 bytes)
```

`HKDF-SHA256(ikm, salt, info, L)` is extract-then-expand, RFC 5869. Separate keys per direction mean
a record cannot be reflected at its sender and accepted.

### Client authentication

Immediately after the handshake, at sequence `1`, the client sends a `data` record whose plaintext
carries its device token. The daemon accepts or sends `{"t":"closed", …}` for the session. The token
never appears outside the encrypted channel, so a relay never sees it — this is the reason client
authentication happens after keying rather than during.

The token's own format belongs to the daemon's pairing API, not to this protocol. The exact record
that carries it is §14.

---

## 7. Records (`kind = 0x03`)

```
nonce = 4 zero bytes ‖ sequence as unsigned 64-bit big-endian     (12 bytes)
aad   = the 28-byte frame header of this frame, verbatim
body  = AES-256-GCM-Seal(k_direction, nonce, aad, plaintext)      (ciphertext ‖ 16-byte tag)
```

Maximum plaintext is `65536 − 28 − 16 = 65492` bytes.

Because the header is the associated data, the session identifier, kind and sequence number are
authenticated even though they travel in the clear for routing. A relay that edits any of them is
caught.

The sequence number is the nonce, so it is never reused under one key. A direction that reaches
`0xFFFFFFFF` ends the session rather than wrapping; at the maximum frame size that is 256 TiB of
traffic on one session.

**On any failure — a bad tag, a sequence that is not the next one, a record for another session —
the session ends.** There is no recovery path and that is intentional. A carrier that silently loses
frames would otherwise produce a session that looks healthy and is missing data.

---

## 8. Liveness and backpressure

### Heartbeat — the one exception to "everything is a frame"

Each side sends the **text** message `fy-ping` at least every `heartbeatSeconds`; the peer answers
with the **text** message `fy-pong`. These two exact strings are the only text messages this
protocol defines; any other text message is a protocol error.

They are text so that Cloudflare's WebSocket auto-responder can answer them without waking the
Durable Object. A heartbeat that woke the object every thirty seconds would defeat hibernation, and
an idle rendezvous would stop being free. A socket with no evidence of life for
`heartbeatSeconds × 1.5` is evicted (`4408`) — _no evidence_ means evicted, not means fine.

### Credit

A rendezvous **never queues**. It forwards a frame the instant it arrives or it ends the session, so
the only thing that could grow without bound is the socket buffer beneath it, and the only way to
bound that is to stop the sender.

- Each direction of each session starts with `creditWindowFrames` (32) frames of allowance.
- A sender may have at most that many frames outstanding.
- A receiver returns credit with a `credit` frame carrying a 32-bit count, once it owes at least
  half a window.
- A grant is **clamped**: it can never raise the outstanding allowance above one window. A peer
  granting four billion credits changes nothing.
- A grant that would change nothing is itself a protocol violation, which bounds the number of
  credit frames by the number of frames actually delivered.
- A sender that exceeds its allowance ends the session (`4430`).

Worst case in flight, one direction, one session: `32 × 65536` = 2 MiB, by construction rather than
by anyone's good behaviour.

---

## 9. Rendezvous behaviour, stated exactly

**One daemon. The incumbent wins.** While an authenticated daemon holds a rendezvous, a second
claim is refused (`4409`). A daemon whose network dropped is therefore locked out until the sweep
evicts its dead socket — at most `heartbeatSeconds × 1.5`. This is a deliberate trade: the other
resolution, letting the newest socket win, hands the rendezvous to whoever connected most recently.

**Many clients, each in its own session.** Up to `maxSessions` (8) clients may be connected at once —
a phone and a laptop, say. There is no shared "the client" slot to be ambiguous about. Each session
is an independent end-to-end conversation with its own keys, and one client can never address
another's session.

**No daemon, no session.** A client arriving at a rendezvous no daemon holds is closed with `4404`
rather than parked. There is nothing to wait for that the client cannot retry.

**Reconnection is normal, and it is not resumption.** A session is bound to its sockets. When either
socket drops, the session ends and both sides are told. Frames in flight are lost — and _known_ to be
lost, because the sequence discipline in §7 turns a gap into a torn-down session rather than a quiet
hole. Reconnecting creates a **new** session with new keys and a new session identifier. The
application above must re-request whatever it had in flight. There is no resume, no replay buffer,
and no "probably fine".

**Self-hosted refusals cost the caller more than the relay.** An unknown daemon fingerprint is
refused by a self-hosted deployment's stateless Worker before any Durable Object exists. The hosted
deployment deliberately accepts any valid fingerprint, reserves account-wide capacity before
routing it, and explains a refusal over an accepted WebSocket before closing so a browser can show
the real reason. Beyond that: at most 4 unproved daemon sockets, at most 30 socket arrivals per
rendezvous per minute, and every limit above.

### Close codes

| Code   | Meaning                                                                  |
| ------ | ------------------------------------------------------------------------ |
| `4400` | protocol error: unparseable, or right message in the wrong state         |
| `4401` | claim rejected: fingerprint mismatch or bad signature                    |
| `4402` | claim deadline expired                                                   |
| `4403` | the daemon refused the client's credentials inside the encrypted channel |
| `4404` | no daemon holds this rendezvous                                          |
| `4408` | heartbeat timeout                                                        |
| `4409` | a daemon already holds this rendezvous                                   |
| `4413` | frame too large                                                          |
| `4420` | sequence broken: a frame was dropped, duplicated or reordered            |
| `4421` | a record failed authentication                                           |
| `4426` | unsupported version or protocol identifier                               |
| `4429` | rendezvous busy: session, socket or rate limit reached                   |
| `4430` | flow violation: the sender exceeded its credit window                    |
| `4431` | the hosted relay is disabled by its runtime kill switch                  |
| `4432` | a per-daemon or global hosted connection ceiling was reached             |
| `4433` | a per-daemon or global hosted bandwidth ceiling was reached              |
| `4500` | the rendezvous itself failed                                             |

---

## 10. What a relay operator can see

An honest list. Everything here is metadata this design cannot hide, and claiming otherwise would be
worse than disclosing it.

- **The daemon fingerprint.** It is in the URL; it is what addresses the rendezvous. It is a stable
  pseudonymous identifier for one machine.
- **The daemon's Ed25519 public key**, presented in the claim.
- **Both IP addresses**, when each side connected, and how long each stayed.
- **Frame counts, frame sizes and exact timings**, in both directions. There is no padding and no
  cover traffic in this version, so an observer can tell a burst of typing from a screenshot.
- **How many clients** are connected to a daemon, and when each arrived and left.

The hosted deployment makes a bounded subset of that metadata durable for its operator: per-daemon
and global request counts, encoded bytes actually forwarded, accepted/refused connection counts,
current and peak concurrent connections, first/last activity timestamps, and the current minute/day
byte windows. It does **not** store source IP addresses in that meter, although Cloudflare and its
request logs can observe them as described above. Metrics are behind the operator bearer; the public
advertisement exposes only `version` and `relayUrl`.

What the operator cannot see: any frame payload, the device token, session content, command output,
daemon or device names, or anything about what the fleet is doing.

A **direct** carrier removes all of the above except what the networks in between can see anyway.
That is the main reason to prefer it.

---

## 11. Running your own relay

This is an **expert opt-in path**. The required onboarding and ordinary setup do not ask anyone to do
it, because the hosted relay in §13 carries anyone who does not want to operate their own; the
current interim chooser is the explicit exception listed in §13. It exists because someone should
always be able to own their own carrier — not because the product needs them to. The step-by-step
procedure, including plan requirements, the narrowest API token that works,
verification, teardown and what it costs, is
[`cloudflare-relay-self-hosting.md`](cloudflare-relay-self-hosting.md). This section stays
architectural: what a relay of your own _is_, and what you take on by running one.

```
1. Put your daemon fingerprint in packages/relay/wrangler.jsonc → vars.RELAY_DAEMON_IDS
2. task relay:check     # compiles and prints bindings, deploys nothing
3. task relay:deploy
```

`RELAY_DAEMON_IDS` is a space- or comma-separated list of `fy_daemon_…` fingerprints. A fingerprint
is public — it is printed in the pairing QR — so this is configuration, not a secret. **An empty
list serves nobody**, which is the only safe reading of a relay whose operator never said who it is
for.

Then point both ends at it: the daemon's relay address and the browser's must be the same string,
because it is the `host` the claim signature covers. Today there is no shipped interface for saying
so — see the client gap recorded in the runbook.

### What you are taking on

Read this before you deploy, so you learn it here rather than from a bill.

**You are operating a relay.** Durable Objects bill per request, per duration and per instance. Every
session your daemons hold costs your account, for as long as it is held. Hibernation makes an idle
rendezvous close to free, but a busy one is not free.

**A relay cannot police what it carries, and that is by design.** This deployment is structurally
incapable of reading what it forwards. That property is what makes it safe for _you_; it is also
what makes an open hosted instance abusable. Your own deployment therefore serves only the
fingerprints you list. Ferretry's hosted deployment accepts the open-service risk and bounds cost by
metadata-only metering and hard ceilings; it does not weaken encryption to recover visibility.

**Your fingerprint list is your whole access control at the relay layer.** Anyone who learns a listed
fingerprint can open sockets to that rendezvous and be refused — they cannot claim it without the
key, and cannot read a session without the handshake — but they can make you pay for the refusals,
bounded by the rate limit in §9. Treat the list as configuration you keep current: remove a daemon
you have retired.

**Reimplementing it is fine.** This document is the whole contract. A relay in another language, on
another platform, is a first-class option; nothing in either endpoint knows it is talking to
Cloudflare.

---

## 12. What is proved, and what is not

Everything in §3 through §9 is exercised by tests in `packages/relay`, against real WebCrypto
primitives, at 100% line coverage on both the domain and adapter ledgers — including a full
daemon-to-browser session carried by the actual rendezvous code, and the assertion that a tampered
record is refused.

**Cloudflare's runtime is not in that harness.** This repository cannot run `workerd`, so the
Durable Object is proved against fakes of the runtime surface it uses. What that proves is the
adapter's half of the contract — which runtime calls it makes, in what order, and what it does with
the answers. It does **not** prove that Cloudflare behaves as those fakes do. In particular:

- **Hibernation is designed for, not measured here.** The adapter uses the hibernation API
  (`acceptWebSocket`, socket attachments, storage-backed state, and an auto-responder for the
  heartbeat) so that nothing routine wakes the object, and it keeps no session state in instance
  fields that could not survive an eviction. Whether an idle rendezvous actually bills nothing is a
  claim only a real deployment can settle. Check your account's metrics after a day of idling — that
  is the honest verification, and it has not been performed here.
- Close-code delivery, socket buffering behaviour and alarm timing are Cloudflare's, not ours.

---

## 13. Ferretry's hosted relay

`packages/relay/wrangler.hosted.json` is a separate Cloudflare deployment named
`ferretry-hosted-relay`. It uses the same Worker entry, rendezvous state machine, handshake and
record layer as a relay you operate yourself. Hosted mode changes admission and accounting only:
the stateless Worker reserves a connection with one globally named control Durable Object, then
routes the socket to the Durable Object named by `ferretry-relay/1:<daemonId>`.

**This is the carrier every installation is intended to fall back to** when direct is not reachable,
configured entirely at runtime. Its address is seeded on the first deploy into an untouched control
object, from that Worker's own Cloudflare origin — so even the default address is a deployment fact
rather than a compiled constant. The server half of that is built and tested; the client half is
not, and "What is not built yet" below says exactly what is missing.

### Runtime default and kill switch

The public discovery contract is:

```
GET https://<hosted-relay-origin>/v1/default-relay
Cache-Control: no-store

{ "version": 1, "relayUrl": "https://<hosted-relay-origin>" }
```

`relayUrl` may instead be `null`. Null is disabled, not an empty address and not permission to guess.
The operator changes it through the authenticated `PUT /v1/operator/config` endpoint or the
`enable`/`disable` manual operation in `.github/workflows/relay-hosted.yaml`. Those operations mutate
the control Durable Object; they do not build, release or deploy the app or Worker. A normal deploy
initialises an untouched control object to the Worker's real `workers.dev` origin, but preserves any
existing address or disabled state, so a later deploy cannot undo an emergency stop.

New sockets see the switch before a per-daemon object is allocated. Live sockets re-check it on the
existing 30-second rendezvous sweep and receive `4431` before close. A control object that is absent,
unreadable, malformed or internally inconsistent fails closed with an explicit relay error; damaged
state is never reinterpreted as an unused account.

The operator bearer that authorises those writes is derived — `sha256("ferretry-relay-operator-v1\0"
‖ CLOUDFLARE_API_TOKEN)` — and installed as a Worker secret by the deploy job. **Rotating
`CLOUDFLARE_API_TOKEN` therefore breaks runtime control until the next deploy**, because the workflow
starts deriving a bearer the Worker has never been told about and every operation answers `401`. The
recovery is one `workflow_dispatch` with `operation: deploy`, which reinstalls the derived secret;
run it _before_ you need the kill switch, not during the incident that needs it.

### What is metered and capped

Every metric is keyed by the daemon fingerprint. The control object stores each daemon in a separate
durable row, plus global counters and one durable reservation per accepted WebSocket. A transaction
updates the daemon row, global row and reservation together. The operator reads a consistency-checked
snapshot at `GET /v1/operator/metrics`; it is refused rather than rendered if daemon rows,
reservations and global totals disagree.

`requestCount` counts connection attempts and decoded WebSocket frame events. `bytesRelayed`
counts the complete encoded frame length only when the rendezvous state machine will actually forward
that opaque frame. It excludes rejected frames, HTTP headers and control frames generated by the
relay. The meter receives a daemon fingerprint and a number of bytes — never a payload, decoded
handshake, device credential, command or result.

Reservation identifiers make both admission and release idempotent, and each operation retries once
when its answer is missing or unusable. There is deliberately no clock-only reservation reaper: the
control object cannot prove that an old reservation no longer belongs to a hibernating live socket,
so expiring one would make the cap undercount real traffic. That leaves a narrow distributed-systems
residual. If the stateless Worker terminates after admission commits but before the rendezvous owns
the socket, or if both reserve replies and both compensating release attempts fail to arrive, one
slot can remain stranded. It relays no bytes but reduces available connection capacity. This design
discloses that residual rather than claiming exact recovery or inventing an unsafe expiry rule.

Initial limits are deliberately configuration, not protocol constants:

| Ceiling                   | Per daemon | Global |
| ------------------------- | ---------: | -----: |
| Concurrent WebSockets     |         16 |    512 |
| Encoded bytes per minute  |     64 MiB |  1 GiB |
| Encoded bytes per UTC day |      1 GiB | 16 GiB |

At most 10,000 daemon metric rows are created. The operator can replace all limits through the same
runtime configuration endpoint. A connection ceiling is checked before routing; a byte ceiling is
checked before the frame's state transition is stored or sent. A refusal sends a typed `error`
control frame and then closes with `4432` or `4433`, including the reason (and, for bandwidth, a
reset timestamp in the control-plane decision). Failure to reach or parse the meter is `4500` and is
also a refusal. Nothing degrades into an unmetered path.

### How long per-daemon rows are kept

`maxTrackedDaemons` is a **recoverable ceiling on stored rows, not a lifetime lockout**. A bound that
only ever fills would eventually refuse every daemon that had never connected before — permanently,
and for no reason anyone could see.

So when the census is full and a daemon with no row asks for a connection, admission first
**re-counts every stored row and checks the total against the recorded census**. Only if the two
agree does it delete up to **64** rows, and only rows that are all of:

- holding **no** connections (`concurrentConnections == 0`);
- past their accounting day — the row's byte window began before the current **UTC** day; and
- carrying a **non-null** last-activity stamp that is also before the current UTC day.

Both time conditions are required because a refusal can stamp activity on a row without rolling its
window, and either test alone would let today's traffic be forgotten out from under its own caps. A
row with no activity stamp is kept, not reclaimed: every stored row has been through admission or
metering, both of which stamp it, so an unstamped row is evidence nobody can account for, and the
fail-closed reading of that is "still in use".

**If the recount disagrees with the census, or any row is damaged or ambiguous, the request is
refused and nothing is deleted.** Reclaiming never runs on evidence that does not add up.

What reclaiming costs is visible and worth stating: **deleting a row discards that daemon's
historical per-daemon counters** — its request count, bytes relayed, refusals, peak concurrency and
activity stamps are gone from `GET /v1/operator/metrics`. **Account-wide cumulative totals are not
touched.** A bill already run up does not shrink because a quiet daemon's row was tidied away, and
only `trackedDaemons` — the count of stored rows — goes down.

### What an open relay costs, stated plainly

A self-hosted deployment refuses an unlisted fingerprint in the stateless Worker. The hosted one
cannot: it serves whoever asks, so it accepts any well-formed fingerprint and charges the reservation
before the socket is proved. A fingerprint is public — it is in the pairing QR — and that has a
consequence worth saying out loud rather than discovering:

**Someone who knows a daemon's fingerprint can occupy that daemon's pre-claim connection slots.**
They cannot claim the rendezvous (that needs the key), cannot open a session (that needs the
handshake) and cannot read a byte of what the daemon is doing. What they can do is hold reservations
the real owner then cannot have, until those sockets are swept — so the honest description is a
**transient denial of the daemon's own capacity**, not a compromise of it.

The caps in this section are what bounds it: the per-daemon ceiling means one fingerprint cannot
consume the account, and the sweep plus reservation release means slots come back rather than
draining away. Those two properties are the whole mitigation, and they are only worth what their
implementation is worth — a reservation that leaked instead of being released would turn a transient
squeeze into a permanent lockout, which is why release-on-every-close and recovery of stale rows are
treated as correctness, not tidiness.

The normal socket lifecycle does release every close, error, refusal and sweep even when a peer
effect throws, and a partial kill-switch sweep attempts every socket before reporting failure. The
commit-to-handoff residual described above remains the exception: it can strand capacity without a
live attacker socket, which is why this section does not promise that every possible distributed
failure is transient.

What cannot be done about it is the point: **the relay cannot tell abuse from use.** Distinguishing
them means reading what is being carried, and it structurally cannot. Enrolment, quotas per identity
and abuse review are the service apparatus this design refuses. So the trade is stated rather than
solved: an open carrier, bounded by ceilings and a kill switch, in exchange for a carrier nobody has
to deploy.

### Honest hosted disclosure

Ferretry and Cloudflare can observe the daemon fingerprint, IP addresses, connection timing and
duration, encoded frame counts and sizes, traffic timing, and concurrent connections. The operator
meter persists the counts, sizes and timing fields described above. Neither party can observe frame
payloads, device tokens, session content, commands, output, daemon names or device names. The same
X25519/Ed25519/AES-256-GCM channel described in §§2, 6 and 7 terminates only at the daemon and browser.
The relay is incapable of decrypting content, including when a cap is hit.

### What is not built yet

The relay, the control plane, the caps and the disclosure text are implemented and tested. **The
transport gap is now closed on both ends: `fyd` dials, and the browser arrives.** What remains is
narrower and is listed exactly below — three shapes this tunnel does not carry, and one screen that
has not caught up with §1.

Discovery is supplied by [PR #202](https://github.com/kirinnee/ferretry/pull/202): the PWA reads and
parses this advertisement from its own build-time `FY_RELAY_DIRECTORY_ORIGIN`, so a browser can learn
the relay address and whether the operator has switched it off. What that does not do is use it.

**`fyd` now dials and carries a session.** `packages/daemon/src/lib/relay` is the daemon half of this
protocol — the claim signed with the key pairing already minted, the per-session handshake, the record
layer, the credit window, and the §14 tunnel that turns a relayed request into the same `ApiRequest`
the bound address serves. `packages/daemon/src/adapters/relay` is the outbound socket and its
liveness, and the `relay` block of the daemon configuration document is where an operator points it.

**The browser now can.** `packages/pwa/src/lib/relay-session.ts` is the client half of §6, §7, §8 and
§14 — the handshake against the fingerprint pairing pinned, the record layer, the credit window and the
tunnel — and `packages/pwa/src/lib/relay-carrier.ts` is what decides and dials.
`DaemonConnection` carries a relay carrier, `connections.ts` persists one, and every daemon-bound
request goes through the router, which attempts direct first and falls back automatically.
`packages/pwa/tests/integration/relay-carrier-end-to-end.test.ts` wires the browser client, the real
`RendezvousDurableObject` and the daemon's real `RelayLink` together and asserts the rendezvous saw
neither a payload nor the device token.

Four properties of that client are worth stating here because they are contract, not implementation:

- **The carrier is chosen by trying it, not by a health check.** The first request is attempted over
  direct, and only a TRANSPORT failure moves on. A daemon that answered `503` is reachable and saying
  so, and is not demoted to a relay.
- **Discovery is re-read every load and never restored from storage.** A hosted address kept in
  browser storage would be a browser `relayUrl: null` does not reach. An address its owner supplied
  themselves has no runtime source and is persisted; Ferretry's hosted one is not.
- **A refused carrier says why, and `0` is never a close code.** A browser withholds the cause of a
  WebSocket failure, but not whether the HANDSHAKE COMPLETED — and that distinction is the whole
  answer, because this Worker deliberately accepts an upgrade it means to refuse so it can state a
  reason in a close frame (`refusalUpgrade`). A socket that failed BEFORE opening therefore did not
  reach a conforming rendezvous at all, and is reported as `1006` with that said in words and the
  rendezvous origin named. The daemon fingerprint is not named: it addresses the rendezvous and
  belongs on a pairing screen, not in text a reader may paste into an issue.
- **A round of carrier failures belongs to the request that made it.** The carrier that WON is
  remembered for the life of the connection, so a browser on the network the relay exists for does
  not pay a failed direct connection per call. A round in which NOTHING worked is not remembered:
  it served no request, so there is no answer to keep, and a later request re-probes. Accumulating
  refusals on shared per-daemon state instead both duplicated the disclosure under the concurrent
  requests of an ordinary page load and made a transient failure permanent until a re-pair.

Five named pieces. PR #202 provides the first two, the third is now built on both ends with the
declared gaps below, the fourth is on screen, and the fifth is outstanding:

1. **A build-time discovery origin in the PWA** — provided by #202. The relay lives on its own
   hostname, so the
   browser cannot resolve the advertisement from its own origin. A **relative `/v1/default-relay` is
   wrong**, and Cloudflare Pages stays a static bundle — no Function, no proxy — so the origin is
   compiled into the PWA build as `FY_RELAY_DIRECTORY_ORIGIN`, supplied by the Pages workflow from
   the same repository variable the relay's own deploy uses, and shipping no directory rather than
   guessing when unset. It is a _service_ address, not a user address: it identifies the relay,
   never a daemon or a person, and is unrelated to the daemon URLs a pairing hands over.
2. **A fetch-and-parse step** — also provided by #202 — that reads the advertisement through
   `HostedRelayAdvertisementSchema` and turns it into a carrier with `hostedRelayConnection`,
   treating `relayUrl: null` and any failure as "no hosted carrier".
3. **A relay-capable transport on both ends** — **built.** `packages/daemon/src/lib/relay` dials out,
   signs its claim with the identity pairing minted (the same key, deliberately: a second one would
   carry a fingerprint no paired browser has pinned), runs a session per client and dispatches §14
   requests into the daemon's own route table; the `relay` block of the daemon configuration document
   points it at an address. `packages/pwa/src/lib/relay-session.ts` and `relay-carrier.ts` are the
   browser end. **What is still missing around it:**
   - A `fy` verb to write the daemon's `relay` block — an operator edits
     `<state home>/config/daemon.json` today.
   - **The two shapes this tunnel does not carry** (see §14): `/v1/events` and terminal streams. The
     browser now REFUSES these on a relay carrier rather than opening a socket at an address the relay
     exists because it cannot reach, so a relayed connection is a working request/response surface
     with no live updates and says so. (This list used to name a third shape, the byte-shaped
     dictation routes. Recognition moved into the browser and those routes were deleted, so the
     exclusion list got **shorter**, not longer.)
   - **The pairing exchange itself cannot be relayed, by construction.** A relayed session is opened
     with the device grant `POST /v1/pair` has not issued yet, so the first contact with a daemon is
     always direct. A phone that can never reach a daemon directly therefore cannot pair with it at
     all. Closing that needs an out-of-band enrolment path this protocol does not have, and inventing
     one under the tunnel would mean a rendezvous carrying an unauthenticated exchange.
   - **Not every browser call site is routed yet.** The composition root hands the carrier-aware
     fetcher to everything it already injects one into — the projects, usage and push ports, and now
     the TYPED API CLIENT, whose transport used to dial the daemon's own address itself. That last
     one was not only unrouted, it was actively misleading: the Settings reachability probe is a
     typed-client call, so a green `Reachable` pill could sit beside a Carrier panel saying nothing
     worked, and a daemon reachable only through the relay was reported down by a probe that never
     tried the relay. The feature modules that default their `fetcher` parameter to `browserFetch`
     — the direct network — (`learning-api.ts`, `attention-client.ts`, `pin-client.ts`,
     `web-terminals.ts`, `remote-browser.ts`, `skills-api.ts`, `files-api.ts`,
     `attachment-source.ts`, `runtime-models.ts`, `stt/*`, `analytics-api.ts`) are still
     direct-only. They FAIL rather than mislead — a request to an unreachable daemon address is a
     visible error, not a blank screen — but until the fetcher is threaded to them those surfaces
     are unavailable over a relay. `stt/*` stays on this list on purpose and for the ordinary reason:
     it is now a single text-only route, `POST /v1/stt/enhance`, and
     `packages/pwa/src/lib/stt/remote-enhancement.ts` still defaults its `fetchImpl` to the global
     `fetch`. Threading the carrier-aware fetcher to it is a small, self-contained change and the only
     thing standing between a relayed connection and remote transcript correction.
4. **Active-carrier disclosure on screen** — DONE. `ActiveCarrierCard` renders
   `chooseConnection().reason` and the `describeConnectionMethod` observer list for whichever
   carrier a live session won on, from `DaemonCarrierRouter.choice`, in Settings › Daemons. A
   carrier nothing has measured yet says so rather than defaulting to "direct".
5. **Removal of the interim carrier chooser and self-hosting setup route.** The current PWA still
   renders `onboarding-connection-chooser.tsx`, offers `own-relay`, and routes it through
   `SELF_HOSTED_RELAY_STEPS`. The conforming flow uses the automatic order above and leaves
   self-hosting to the expert runbook.

PR #202 also surfaced the live advertisement state in onboarding, and that screen's own text still
says a relay is not dialled by anything — which was true when it was written and is not now. Piece 5
is where it is corrected.

**Deploying a relay now gets you a remote connection**, for everything the tunnel carries: any
request/response route, on any daemon whose fingerprint a browser pinned by pairing with it directly
at least once. It does not get you live updates, terminal streams, first-time pairing over the relay,
or the feature surfaces listed in piece 3 above.
The kill switch does not wait for them: `relayUrl: null` is enforced by this Worker at admission and
on the live sweep, so disabling the hosted relay stops traffic regardless of what any client believes.

---

## 14. The tunnel above the channel

§7 stops at "the plaintext". This section says what the plaintext **is**, because two endpoints that
key a channel and then disagree about what to put in it have built a tunnel to nowhere. It is stated
here rather than left to an implementation for the reason §1 gives: an invisible difference between
two implementations is the expensive kind.

One record carries exactly one JSON object, UTF-8, with a `t` discriminator. Every message is parsed
rather than inspected, and a message that does not parse — bad UTF-8, bad JSON, an unknown `t`, an
unexpected field — **ends the session** with `4400`. That is the same discipline §3 applies to
frames, for the same reason: a party that could not read what it was sent does not know what it just
failed to understand.

### Client → daemon

The record at sequence `1` is the client authentication §6 requires, and it is this:

```json
{ "t": "auth", "protocol": "ferretry-relay/1", "deviceToken": "…" }
```

Any other message at sequence `1` ends the session with `4400`. A token the daemon does not
recognise ends it with `4403`. Both refusals happen inside the encrypted channel, so a relay sees a
session close and never learns which of the two it was.

Afterwards, any number of requests:

```json
{
  "t": "req",
  "id": 1,
  "method": "GET",
  "path": "/v1/sessions",
  "query": [["sessionId", "fy_…"]],
  "headers": { "content-type": "application/json" },
  "body": "…"
}
```

`query`, `headers` and `body` are optional; `id`, `method` and `path` are not.

- **`id`** identifies the answer, and must be unique within the session. A repeat is `4400` rather
  than an overwrite: an answer that could belong to either of two requests is worse than a closed
  session.
- **`path`** is the daemon's own raw pathname and must begin with a single `/`. Nothing normalises
  it. A relayed request reaches exactly the route table a direct one reaches, and the authorization
  boundary inspects the same string the handler is given.
- **`query`** is a list of pairs, not an object, because `?sessionId=a&sessionId=b` is meaningful and
  an object cannot hold it.
- **`headers`** are lowercased and single-valued. **`authorization` is refused** with `4400`: the
  credential for a relayed request is the device token that opened the session and nothing else, so a
  request cannot promote itself past the grant it arrived under.
- A relayed request is **never a loopback peer**. Everything a daemon grants a loopback caller — a
  token in a query parameter, a host-scoped route — is unreachable through a relay by construction,
  not by a check somebody has to remember.

### Daemon → client

```json
{ "t": "authenticated", "protocol": "ferretry-relay/1" }
{ "t": "res", "id": 1, "status": 200, "headers": { "content-type": "application/json" }, "body": "…" }
{ "t": "oversize", "id": 1, "status": 200, "byteLength": 402641 }
```

`oversize` is the honest answer when an answer does not fit one record — §7 caps plaintext at 65492
bytes, and the envelope is inside that. It is a typed refusal naming the size rather than a truncated
body or an invented status, because a client that received half a session list and rendered it would
show a fleet that does not exist. Paging or a chunked reply is unbuilt work, and this is what says so
on the wire.

Answers carry an `id` because the daemon replies in whatever order its own handlers finish. Sequence
numbers order the wire; they do not order the work.

### What this tunnel does not carry

The daemon's **protocol-switching** surfaces — `/v1/events` and terminal streams. One request and one
answer is the wrong shape for a stream that keeps talking, so each needs an envelope of its own. §13
records that gap rather than leaving a client to discover it as a socket that never opens.

**A conforming client must refuse these on a relayed carrier rather than fall back to the daemon's own
address.** That address is precisely the one the relay exists because the browser cannot reach, so a
socket opened there is a subscribed viewer receiving nothing, forever — the failure this document
spends §7 and §9 avoiding, arriving through the front door instead. The browser's
`packages/pwa/src/lib/event-transport.ts` refuses, and refuses BEFORE it spends a single-use event
ticket the daemon would otherwise have burned for nothing.

**This list no longer excludes dictation.** The daemon's byte-shaped speech routes — an audio upload
and a multi-megabyte model download — are deleted, because recognition now happens in the browser.
The only speech-to-text request a daemon answers is `POST /v1/stt/enhance`: an already-transcribed
transcript in, a repaired transcript out, ordinary JSON both ways, which this tunnel carries like any
other request/response route. No microphone audio crosses this tunnel, and none crosses the daemon
boundary at all. What keeps that route unreachable over a relay today is not its shape but an
unthreaded fetcher, which §13 piece 3 records.

It also does not carry the **pairing exchange** — `POST /v1/pair` — and cannot: the session is opened
with the device grant that exchange issues. §13 states the consequence.
