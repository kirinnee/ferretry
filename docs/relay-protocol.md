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

There are two **kinds** of carrier and one security model across both. A daemon may hold several of
the second kind, and which ones exist is the daemon's answer rather than the browser's.

| Carrier    | What it is                                                                    | Where it belongs                                                              |
| ---------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Direct** | The browser opens a WebSocket straight at the daemon.                         | Attempted first, automatically, whenever the daemon is reachable.             |
| **Relay**  | A Cloudflare Worker + Durable Object forwarding opaque frames it cannot read. | The automatic fallback when direct is not. Up to four; Ferretry operates one. |

**Neither is a question a conforming product asks.** The required behaviour is: try every direct
carrier the daemon published first, because direct has fewer hops and fewer observers; then each
rendezvous it published, in the daemon's own order; and always say which carrier is live and why the
others were passed over. No carrier chooser, nothing to opt into, and no silent degradation — a
surface that shows a connection without naming its carrier is not conforming. The current PWA still
contains an interim three-way chooser and self-hosting setup route; §13 lists their removal as
unbuilt work rather than pretending otherwise.

The decision layer for that behaviour is in this package today: `connectionPreferenceOrder` in
`packages/relay/src/lib/connection.ts` orders direct before relay, and `chooseConnection` returns the
which-carrier-and-why sentence a surface can show verbatim. **What the set contains is published by
the daemon** — handed to a device when it redeems a pairing code, and refreshable afterwards from
`GET /v1/carriers`; §13 is that contract. Discovery — learning the hosted relay's address and reading
its kill switch — is provided by [PR #202](https://github.com/kirinnee/ferretry/pull/202); a daemon
resolves its `{ kind: 'relay', source: 'discovery' }` entry from that advertisement, and a browser now
reads it only to say whose rendezvous a published address is.
**The transport exists on both sides** — `fyd` dials a rendezvous and carries a session, and the
browser arrives at one, attempting direct first and falling back automatically. What a session can
carry is not only request/response: §14 defines three session shapes — requests, live streams, and
first pairing — and all three are built on both ends, so a device with no route to a daemon can
pair with it and then watch it work. §13 records what is still outstanding around them.

Three addresses are involved and they are deliberately not the same thing:

| Address              | Where it comes from                                                                                                                                          | Compiled in? |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| **Discovery origin** | Where the relay advertisement is read from. The relay has its own hostname, and the PWA is a static bundle, so the browser build carries this one.           | **Yes**      |
| **Relay endpoint**   | A rendezvous a daemon dials: written in its `carriers` list, or served at runtime to a discovery entry as `relayUrl` — or `null`, meaning no hosted carrier. | No           |
| **Daemon URL**       | Where one daemon lives. Handed to the browser by pairing, per user.                                                                                          | No           |

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
because it is standard and reviewed, not because it is clever. Nothing here is invented. A device
that holds no token yet may instead redeem a pairing code inside the same keyed channel — after the
fingerprint check, never before it — and §14 bounds that exchange to exactly one attempt per
session.

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

### The credential record

Immediately after the handshake, at sequence `1`, the client sends a `data` record whose plaintext
is its credential: the device token pairing already gave it, or — for a device that has none yet —
the pairing code itself, redeemed once. The daemon accepts or sends `{"t":"closed", …}` for the
session. Neither credential ever appears outside the encrypted channel, so a relay sees neither —
this is the reason the credential travels after keying rather than during, and the fingerprint check
above is why sending a live pairing code here is safe: a daemon that could receive it has already
been proved to be the one the QR named.

The token's and the code's own formats belong to the daemon's pairing API, not to this protocol. The
exact records that carry them, and the session mode each one commits to, are §14.

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

| Code   | Meaning                                                                                        |
| ------ | ---------------------------------------------------------------------------------------------- |
| `4400` | protocol error: unparseable, or right message in the wrong state                               |
| `4401` | claim rejected: fingerprint mismatch or bad signature                                          |
| `4402` | claim deadline expired                                                                         |
| `4403` | the daemon refused the client's credentials inside the encrypted channel                       |
| `4404` | no daemon holds this rendezvous                                                                |
| `4408` | heartbeat timeout                                                                              |
| `4409` | a daemon already holds this rendezvous                                                         |
| `4413` | frame too large                                                                                |
| `4420` | sequence broken: a frame was dropped, duplicated or reordered                                  |
| `4421` | a record failed authentication                                                                 |
| `4426` | unsupported version or protocol identifier                                                     |
| `4429` | rendezvous busy: session, socket or rate limit reached                                         |
| `4430` | flow violation: the sender exceeded its credit window                                          |
| `4431` | the hosted relay is disabled by its runtime kill switch                                        |
| `4432` | a per-daemon or global hosted connection ceiling was reached                                   |
| `4433` | a per-daemon or global hosted bandwidth ceiling was reached                                    |
| `4440` | the session concluded; code and public reason are constant, while the outcome was sealed first |
| `4500` | the rendezvous itself failed                                                                   |

---

## 10. What a relay operator can see

An honest list. Everything here is metadata this design cannot hide, and claiming otherwise would be
worse than disclosing it.

- **The daemon fingerprint.** It is in the URL; it is what addresses the rendezvous. It is a stable
  pseudonymous identifier for one machine.
- **The daemon's Ed25519 public key**, presented in the claim.
- **Both IP addresses**, when each side connected, and how long each stayed.
- **Frame counts, frame sizes and exact timings**, in both directions. There is no padding and no
  cover traffic in this version, so an observer can tell a burst of typing from a screenshot. For a
  relayed **terminal stream** that deserves its own sentence rather than a clause: frame timing is
  keystroke timing, which is a stronger disclosure than the request/response case — an observer who
  cannot read a single keystroke can still watch the rhythm of somebody typing.
- **How many clients** are connected to a daemon, and when each arrived and left.
- **That a first pairing happened, and — from one record's size — how it ended**, when the exchange
  crosses a relay (§14): a pre-auth session opened for fingerprint X at time T from IP Y and ended
  seconds later. Success and refusal each send exactly one sealed record and then the same close, so
  the exchange is uniform in **frame count** and in close code. It is **not** uniform in **size**,
  and this document used to claim the outcome could not be inferred at all. It can. There is no
  padding (above), so a record's length is its plaintext's length: a `paired` record embeds the
  pairing API's whole redemption response — the minted device token and the published carrier set
  included — while a `pair-refused` record is one short machine reason. The two differ by hundreds of
  bytes, which is not a subtle side channel but a shape an operator can read directly, and it is
  disclosed here rather than left to be discovered. What the size does not give up is any of the
  content: the code, the token, the device name and every other byte of plaintext stay opaque, and a
  refusal's own cause stays uniform — "no code is active" and "wrong guess" produce the identical
  record, so the anti-oracle property §14 argues for is untouched. Today this event happens on a LAN
  and is invisible to everybody; over a relay it is a new metadata class.

The hosted deployment makes a bounded subset of that metadata durable for its operator: per-daemon
and global request counts, encoded bytes actually forwarded, accepted/refused connection counts,
current and peak concurrent connections, first/last activity timestamps, and the current minute/day
byte windows. It does **not** store source IP addresses in that meter, although Cloudflare and its
request logs can observe them as described above. Metrics are behind the operator bearer; the public
advertisement exposes only `version` and `relayUrl`.

What the operator cannot see: any frame payload, the device token, the pairing code, session content,
stream content — events, keystrokes, terminal output — command output, daemon or device names, or
anything about what the fleet is doing. A pairing exchange's **outcome** is deliberately not on this
list any more: nothing about it is readable, and its record size infers it anyway, per the bullet
above.

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
configured entirely at runtime — an ordinary entry in a daemon's carrier list rather than a branch in
its code, which is why an operator can hold it _and_ their own. Its address is seeded on the first
deploy into an untouched control object, from that Worker's own Cloudflare origin — so even the
default address is a deployment fact rather than a compiled constant. Both halves of that now exist,
and "What is not built yet" below says exactly what remains.

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
duration, encoded frame counts and sizes, traffic timing, and concurrent connections. When a first
pairing crosses this relay, that includes the fact that a pre-auth session opened for a fingerprint
and when, from which IP — never the code, the token or the device name, and never the outcome as
anything readable, but the outcome IS inferable from the size of the one sealed answer, because
`paired` carries a whole redemption response and `pair-refused` carries one word (§10).
When a terminal stream crosses it, frame timing is keystroke timing. The operator meter persists the
counts, sizes and timing fields described above. Neither party can observe frame payloads, device
tokens, pairing codes, session content, stream content, commands, output, daemon names or device
names. The same X25519/Ed25519/AES-256-GCM channel described in §§2, 6 and 7 terminates only at the
daemon and browser. The relay is incapable of decrypting content, including when a cap is hit.

### The carrier set a daemon publishes

**The daemon is authoritative and a client's carriers are a cache.** A daemon knows every way it can
be reached; a browser only knows what it was last told. So the daemon publishes the set, in its own
order, and where the two disagree the daemon is right by definition — including about a rendezvous the
browser still remembers and the daemon has dropped.

That replaces an arrangement in which each end discovered a rendezvous **independently**, from its own
build-time discovery origin, and the two met only by coincidence of picking the same service. A daemon
dialling one rendezvous and a browser holding another never meet, and the failure has the worst shape
there is: both halves are healthy and the room is simply empty. Publishing the set is what puts an
answer where the coincidence was.

#### What a daemon may hold

The daemon configuration document carries one `carriers` list. It is a discriminated union rather than
uniform rows, because the two kinds are not the same kind of thing and the `kind` carries the
consequence:

```jsonc
"carriers": [
  { "kind": "bind",  "host": "127.0.0.1", "port": 7431 },  // LISTENS — inbound surface
  { "kind": "relay", "source": "discovery" },              // the hosted default, resolved at runtime
  { "kind": "relay", "url": "wss://my-relay.example" }     // one this operator supplied
]
```

- A **bind** listens, and widening it is how a machine gets reached by somebody who was never invited.
  A **relay** dials out and adds no inbound surface at all, because nothing can connect to a socket a
  daemon opened from behind its own NAT. That asymmetry is why the bounds differ: **at most one bind,
  at most four relays.** One bind because a daemon has one listening socket and more is a different
  feature; four relays because each costs a socket and nothing else — generous on purpose, bounded
  anyway, so "expose it somewhere else too" is never free.
- A list that declares five rendezvous, or two binds, or the same rendezvous twice, **refuses the
  boot**. An operator who wrote a fifth meant something by it, and quietly serving four is a daemon
  lying about its own reach.
- `{ "kind": "relay", "source": "discovery" }` makes the hosted carrier an ordinary entry instead of a
  branch: there is no longer a rule about when the directory is asked, only a member of a list that
  says to ask it. An operator who wants the hosted rendezvous **and** their own writes both, which a
  single `relay` block could not express. Saying "no rendezvous, and I mean it" is that entry with
  `"enabled": false` — a decision, which is the one thing an omission can never be.
- `host`, `port` and the `relay` block remain readable as the **legacy spelling** of a one-bind,
  one-relay list, superseded **per kind** rather than wholesale, so a half-finished migration does not
  silently move where the daemon listens. A legacy key that a `carriers` entry supersedes is **named
  at boot**: a key an operator edited with no error, no message and no change in behaviour is the
  defect this whole shape exists to prevent.
- **Nothing derived is persisted.** The effective list is re-derived on every read from the document
  plus whatever this boot has since decided — a first boot that had to take a different port, a
  `--port` claimed for one run — exactly like `bindUrl` and `publicUrl`. A `carriers` array written
  back to disk with yesterday's port is the same defect as a frozen `publicUrl`.

#### What it publishes, and when

The set crosses to the device at the one moment every device has: **redemption**. That used to read
"the one moment guaranteed to be direct", and §14 retired the guarantee without weakening the
argument — see the rest of this paragraph. The pairing
response carries `carriers`, at most **eight** entries, each one `{ kind: 'direct' | 'relay', url }`,
in the daemon's own order. It is on the redemption response rather than the mint response because the
two are read by different parties — the mint response is read by the **host's** own UI, which has the
daemon in front of it, and this one is read by the **device**, which is who has to know where to look
next time. No rendezvous has an opportunity to edit this answer on any carrier: a direct redemption
never crosses one, and a relayed redemption (§14) carries the same object inside the sealed `paired`
record, under the channel keyed to the identity the QR fingerprint pinned. The argument used to be
"no relay was present"; it is now "a relay cannot alter a sealed record"; the conclusion did not
move.

The wire ceiling of eight sits above what configuration allows — one bind and four relays — so the set
can grow a little without a protocol change. A bound exists at all because every entry is an address
some browser will dial in turn, and an unbounded list is an unbounded walk.

A paired device refreshes without pairing again:

```
GET /v1/carriers        authenticated with the device token pairing issued, fetched no-store

{ "carriers": [ { "kind": "direct", "url": "https://workstation.example:7431" },
                { "kind": "relay",  "url": "wss://relay.example" } ] }
```

It is `authenticated` rather than host-scoped on purpose: a paired device asking where its own daemon
can be reached is exactly the caller this answer exists for, and it discloses nothing that device was
not already told at redemption.

A client **replaces** its stored set with that answer after a successful connection. Replace, never
merge: a merge can learn an address the daemon added and can never forget one the daemon withdrew, so
it fixes exactly half of a disagreement. The response is an object rather than a bare array because a
JSON array has nowhere to put the next fact anybody needs.

The two URL rules differ on purpose. A **relay** address must be `wss:`/`https:` anywhere, and may be
`ws:`/`http:` only against loopback — the same line the published site's content-security-policy
draws, so drawing it differently here would make one of the two a lie. It carries a third party on the
path, and a stranger's service carrying a session in plaintext is not a carrier this protocol will
dial. A **direct** address is the same spelling pairing has always handed over, because a daemon on a
private network address commonly serves plain HTTP, and refusing that here would publish an empty set
for the most ordinary deployment there is. A published relay address that does not pass the rule is
**dropped rather than dialled**: the two ends disagree about what is dialable, and dialling anyway is
how a client ends up trusting a carrier its own protocol refuses.

**Neither address is a secret**, which is why publishing them discloses nothing: a rendezvous address
is already known to the rendezvous, and a daemon address is already known to whoever was authorised to
pair with it. The daemon **fingerprint** is a different matter. It is not on this list and is not
named in any carrier diagnostic — it addresses the rendezvous, it travels in the pairing fragment, and
it stays out of anything a reader might paste into an issue.

**No entry says whether it is privileged, and no such field may ever be added.** Privilege is binary
and carrier-derived: it is answered by the carrier that **accepted** an arrival, per connection, on the
daemon. A relay arrival answers `false` unconditionally — the rendezvous terminates on the host it
serves, so a check reading a peer address, a `Host` header or a URL would hand a remote phone full
control — and a bound socket answers per connection. A field here saying "this one is local" would be
a client's claim about its own authority, which is the one thing a daemon may never take from a
client. Multiple relays do not weaken that rule; they instantiate it N times. See
[`grants.md`](grants.md).

**Adding `carriers` to the redemption response was a breaking change, not an additive one.** Every
device-facing response in `@ferretry/protocol` is a strict object and refuses an unknown key rather
than ignoring it, so an older client parsing a newer daemon's answer fails outright — totally, for
that exchange, and it looks like the daemon refusing the client. The rule, recorded in
`packages/protocol/src/lib/version-skew.ts`: **a key added to a device-facing strict object ships in
the same release as the client that reads it.** The other direction needs no ceremony — a newer client
reading an older daemon sees no `carriers` and degrades to direct-only, which is exactly what an older
daemon offers.

The wire shape is `packages/protocol/src/lib/carriers.ts` — one owner for both ends, since the
configuration list and the published set are the same fact seen from two sides. The operator's list is
`packages/daemon/src/lib/runtime/carriers.ts`, and the browser's cache and walk are
`packages/pwa/src/lib/connections.ts` and `relay-carrier.ts`.

#### The walk

The existing contract is unchanged, and is now stated for a set rather than a pair: **the carrier is
chosen by trying it, not by a health check.**

1. every `direct` carrier, in the order the daemon published them;
2. then every `relay`, in the order the daemon published them;
3. **only a TRANSPORT failure from a replay-safe `GET` or `HEAD` advances.** Any HTTP response is an
   answer — `503` included — and stops the walk: the daemon is reachable and saying so. A failed
   mutation is also reported rather than sent to another carrier, because a lost response does not
   prove the daemon did not apply it. Advancing on a status would send the client to another address
   for the same daemon to arrive at the answer it already had, and report "nothing was reachable" about
   a daemon that replied every time;
4. the winner is remembered **for the life of that connection**, so a browser on the network a
   rendezvous exists for does not pay a failed direct attempt per call. **A round in which nothing
   worked is not remembered** — it served no request, so there is no answer to keep, and a later
   request re-probes. When a remembered winner's transport later fails, that choice is forgotten and
   the next request starts the walk again from the top.

Direct before relay is the protocol's rule. **Within a kind, the daemon's order is the operator's
preference**, which is the right authority, and a client that re-sorted it would be substituting its
own. There is **no latency race and no scoring**: a race makes the winner nondeterministic, and a
surface that reports which carrier is live has to be able to say _why_ that one won.

#### When the two disagree

| Disagreement                                      | Behaviour                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the daemon dropped a relay the client still holds | the handshake finds no daemon at that rendezvous. A **replay-safe** request advances, per rule 3 — not an error, a miss. A mutation is **reported instead**, because the walk has no discriminator between a rendezvous that never carried the request and one that carried it and lost the answer. The stale entry is pruned by the refresh after the next successful connection. |
| the daemon added a relay the client lacks         | the client never tries it, until that same refresh **replaces** the stored set. Nobody has to re-pair.                                                                                                                                                                                                                                                                             |
| nothing published is reachable                    | every attempt is reported with its cause and the rendezvous origins are named; the daemon fingerprint is not. `0` is never a close code. Existing contract, preserved.                                                                                                                                                                                                             |

A carrier the client discovered **for itself** under the previous model is not promoted into this
cache. It was a guess about where a daemon might be, not something the daemon said, and the whole
point of the set is that those are different claims.

#### What several rendezvous buy, honestly

A self-hosted rendezvous for a LAN and the hosted one for everywhere else, at the same time — and
redundancy, which was never available while each end picked a service independently. The strongest
reason is quieter: the published set carries a **direct** address alongside the relays, so the
carrier pairing prefers is a first-class member of the list rather than a special case sitting
outside it. Pairing attempts direct first, like everything else — but it no longer **requires**
direct: §14's pairing session is what makes a daemon pairable by a phone that can never reach its
address, and the published relays are what that phone navigates by afterwards.

### What is built, and what is not

The relay, the control plane, the caps and the disclosure text are implemented and tested. **All
three §14 session modes are now built on both ends** — requests, live streams, and first pairing —
so a phone that can never reach a daemon's address can pair with it and then watch it work. What
remains is listed exactly below and is narrower than it was: an operator still edits the carrier
list by hand, a fresh device can discover only the hosted rendezvous, several browser call sites still
dial direct only, no surface renders the session-ceiling refusal §14 requires it to, and one onboarding
screen has not caught up with §1.

**What proved it, and what that proof does not cover.** A real Google Chrome, holding the link a
compiled `fy pair` printed, redeems a first-pairing code across a real rendezvous process against a
freshly compiled standalone `fyd` — after opening a connection to the advertised direct address and
having it fail at transport — then reconnects as an ordinary authenticated session over the same
rendezvous and renders a live event the daemon appended. The code, the minted token, the device name
and the event payload appear in none of the frames the rendezvous handled.
`tests/e2e/relay-browser-pairing.e2e.test.ts` is that journey. Its honest limits are the ones
`tests/e2e/README.md` records and §12 already draws: real Chrome, real compiled binaries, real
WebSockets and the **real** rendezvous state machine, with Cloudflare's own runtime substituted —
hibernation, the auto-responder, durable storage and alarms are ports, not `workerd`. So it proves
this protocol's behaviour end to end and still proves nothing about Cloudflare. **That
compiled-browser tier is local and does not run in CI.** A separate PWA lane is adding a focused CI
guard for the Vite directory override, and the existing unit and integration tiers guard the protocol
behaviour; neither turns the full Chrome journey itself into a CI guard.

Discovery is supplied by [PR #202](https://github.com/kirinnee/ferretry/pull/202): the PWA reads and
parses this advertisement from the directory origin Vite compiles into the bundle, whose default is
`@ferretry/relay`'s `HOSTED_RELAY_DIRECTORY_ORIGIN`. That browser read does three jobs: it supplies the
last-resort hosted carrier after the daemon's published set fails, supplies the **only** relayed
first-pairing candidate after direct fails, and lets a surface disclose whether an address is
Ferretry's rendezvous or somebody's own. A failed, malformed or switched-off read guesses nothing.
For first pairing the result is a direct-only walk with no relayed first contact; for an already
paired device it removes the last-resort hosted carrier but leaves direct and the daemon-published set.

**Both ends discover it now, and that asymmetry was a shipped defect.** A session crosses a relay
only if BOTH ends are on it, and until `packages/daemon/src/lib/relay/discovery.ts` existed only the
browser half read this advertisement: `decideRelayCarrier` answered "no relay is configured" whenever
the daemon document had no `relay` block, and **nothing has ever written one**. So a fresh install
bound loopback, dialled nowhere, and was reachable from no device but its own host — which is
indistinguishable, from the owner's side, from pairing being broken. The daemon now reads this same
document, from the same path, and dials whatever it names. Both ends import the same default origin
from `@ferretry/relay`, so Nix, GoReleaser, local Bun builds and forks agree unless somebody explicitly
overrides them. Those escape hatches are independent: `FY_RELAY_DIRECTORY_ORIGIN` is read at runtime
by the daemon and at build time by the PWA's `vite.config.ts`, so setting only one can point the two
ends at different directories. It is an ORIGIN, never a carrier: no relay address is compiled into
either end.

That divergence fails closed. A directory can advertise a rendezvous the daemon does not hold, but
the resulting client arrival ends at `4404`; §6 pins the daemon identity from the pairing link before
the device sends the pairing code, device token or any payload, so neither a divergent directory nor
the wrong rendezvous learns those secrets. The costs are availability and metadata: relayed first
pairing silently disappears, the directory sees the requesting device's IP and timing, and a
rendezvous it names sees the device IP, daemon fingerprint and connection timing even when its
operator is not the one the owner intended.

A rendezvous an operator wrote down **wins and is never overwritten** — the directory is asked only
for an enabled `source: 'discovery'` entry, so a carrier switched off stays off rather than being
helpfully re-enabled, and an entry carrying a `url` is already complete. The same holds for the legacy
`relay` block, which is read as a one-relay list when `carriers` declares no rendezvous of its own.
Every failure to discover narrows that entry to nothing rather than guessing an address, and the boot
trail plus `fyd --check` state the consequence and the remedy rather than one bare clause; `--check`
names the posture in one line: direct-only, hosted, or self-hosted, and which.

**`fyd` now dials and carries a session.** `packages/daemon/src/lib/relay` is the daemon half of this
protocol — the claim signed with the key pairing already minted, the per-session handshake, the record
layer, the credit window, and the §14 tunnel that turns a relayed request into the same `ApiRequest`
the bound address serves. `packages/daemon/src/adapters/relay` is the outbound socket, its liveness,
and the one HTTP read of the advertisement above; the `carriers` list of the daemon configuration
document — legacy `relay` block included — is where an operator overrides all of it.

**The browser now can.** `packages/pwa/src/lib/relay-session.ts` is the client half of §6, §7, §8 and
§14 — the handshake against the fingerprint pairing pinned, the record layer, the credit window and the
tunnel — and `packages/pwa/src/lib/relay-carrier.ts` is what decides and dials.
`DaemonConnection` carries the daemon's published set, `connections.ts` persists it as a cache, and
every daemon-bound request goes through the router, which walks that set in the order above.
`packages/pwa/tests/integration/relay-carrier-end-to-end.test.ts` wires the browser client, the real
`RendezvousDurableObject` and the daemon's real `RelayLink` together and asserts the rendezvous saw
neither a payload nor the device token.

Four properties of that client are worth stating here because they are contract, not implementation:

- **The carrier is chosen by trying it, not by a health check.** The walk above is the whole rule:
  every direct address, then every rendezvous, in the daemon's published order, and only a TRANSPORT
  failure moves on. A daemon that answered `503` is reachable and saying so, and is not demoted to a
  relay.
- **The stored set is a cache of what the daemon said, not a browser's own discovery.** It is seeded
  by redemption, replaced wholesale after a successful connection, and never merged into. A hosted
  address the browser discovered for itself is not written into it, and one carried over from the
  previous single-relay model is dropped rather than promoted. The kill switch does not depend on any
  of that: `relayUrl: null` is enforced by the Worker at admission and on the live sweep, and a
  withdrawn address also leaves the daemon's published set at the next refresh, so a remembered
  address carries nothing.
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

Five named pieces. PR #202 provides the first two, the third is now built on both ends in all three
session modes with the narrower gaps declared below, the fourth is on screen, and the fifth is
outstanding:

1. **One default discovery origin, with an explicit override on EACH end** — imported from the one
   `@ferretry/relay` source constant. The relay lives on its own hostname, so the
   browser cannot resolve the advertisement from its own origin. A **relative `/v1/default-relay` is
   wrong**, and Cloudflare Pages stays a static bundle — no Function, no proxy — so the origin is
   supplied to both ends by `HOSTED_RELAY_DIRECTORY_ORIGIN`. It is a _service_ address, not a user
   address: it identifies the directory, never a daemon, person, or carrier. This temporary default
   is Ferretry's personal `workers.dev` subdomain and forks use it too; moving to a product domain
   changes one source constant. `FY_RELAY_DIRECTORY_ORIGIN` overrides it at daemon runtime and at PWA
   build time in `vite.config.ts`; an explicit daemon relay block still wins before discovery. Setting
   only one override can make the two ends disagree, which has the fail-closed and metadata costs
   stated above. `scripts/validate/relay-config.sh` pins both shared-default imports, while the focused
   PWA build-contract guard covers the Vite override in CI.
2. **A fetch-and-parse step on BOTH ends** — the PWA's from #202, the daemon's in
   `packages/daemon/src/lib/relay/discovery.ts` and `src/adapters/relay/hosted-relay-directory.ts` —
   that reads the advertisement through `HostedRelayAdvertisementSchema`, treating `relayUrl: null`
   and any failure as "no hosted carrier". On the daemon the advertised address resolves whichever
   `source: 'discovery'` entry the carrier list holds, through the same schema an operator's own entry
   uses, so a discovered rendezvous and a configured one cannot acquire different redial cadences; an
   entry that already carries a `url` never reads it, and one boot performs one read no matter how
   many entries there are. In the browser the same read supplies the last-resort hosted carrier and
   the only relayed first-pairing candidate, as well as labelling a published address as Ferretry's
   hosted rendezvous or somebody's own.
3. **A relay-capable transport on both ends** — **built.** `packages/daemon/src/lib/relay` dials out,
   signs its claim with the identity pairing minted (the same key, deliberately: a second one would
   carry a fingerprint no paired browser has pinned), runs a session per client and dispatches §14
   requests into the daemon's own route table; the `carriers` list of the daemon configuration document
   points it at up to four addresses. `packages/pwa/src/lib/relay-session.ts` and `relay-carrier.ts`
   are the browser end. **What is still missing around it:**
   - A `fy` verb to read and write the daemon's `carriers` list — an operator edits
     `<state home>/config/daemon.json` today. Those entries are an OVERRIDE rather than the only way
     to get a carrier: a document that declares no rendezvous takes whichever relay this section
     advertises, as the discovery entry it means.
   - **Stream sessions — built.** §14's envelope carries `/v1/events` and terminal streams over a
     relay: one session per stream, dispatched through the daemon's own socket route table, so a
     relayed viewer passes the same authorization boundary and per-capability guard a direct upgrade
     does. The browser no longer refuses these on a relay carrier — the refusal that used to say "no
     envelope exists" is gone with the gap it described. (This list used to name a third shape, the
     byte-shaped dictation routes. Recognition moved into the browser and those routes were deleted,
     so the exclusion list got **shorter**, not longer.)
   - **A fresh device cannot DISCOVER a rendezvous an operator runs, and naming one to it is
     deferred.** What a device that has never paired can find for itself is exactly one address: the
     hosted advertisement above. So the relayed first contact this branch ships is direct-first plus
     the hosted fallback, and **a daemon whose only carrier is a rendezvous of its own is pairable only
     from a device that can already reach its direct address** — no link names one, so there is no
     off-LAN path to it at all. Three surfaces state that consequence rather than paper over it:
     `PAIRING_REACH_NOTICE` names the hosted relay instead of "the relay this daemon dials", and both
     `fy pair` and `fyd --check` draw no QR and print the plain local-only sentence for such a daemon.
     That is the CORRECT answer for it, not an under-report: nothing off its network could reach the
     address either. What was an under-report — and is fixed — is the **hosted default**: a
     loopback-bound daemon dialling the discovered hosted relay is redeemable from a phone, and
     `fyd --check` used to pass no address to `localOnlyNotice` and say "no QR is drawn" about it. Both
     surfaces now read one derivation (`discoverableRelayUrl`) keyed on relay **provenance**, so they
     cannot disagree about the same daemon. Closing the self-hosted half needs a link that can name a
     rendezvous, which is deferred rather than shipped half-generalised.
   - **The session-ceiling refusal is not rendered, and one stream does not even retry it.** §14
     requires a `4429` to be told to the reader in words — "this daemon already has as many relayed
     sessions as the rendezvous carries" — because somebody with three tabs open did nothing wrong.
     No surface says it. `DaemonCarrierRouter.openStream` does its half: a rendezvous refusal is
     thrown with its close code intact rather than treated as a carrier to replace. Above that,
     `web-terminals.ts` rethrows anything that is not a daemon `stream-refused`, and the deck's
     `.catch` sends it to the ordinary backoff — so a relayed TERMINAL retries, correctly, but shows
     `reconnecting` rather than the sentence. The LIVE EVENT stream is worse and is the actual defect
     in this pair: `App.tsx` subscribes with `.catch(() => undefined)`, so a `4429` there is
     swallowed whole — no retry, no reason, a feed that silently never opens. Nothing in either
     endpoint dispatches on `4429` at all; what retries today retries because it treats every
     non-final failure alike, which is the right behaviour reached without ever reading the code.
     Until a surface names the ceiling and the event subscription retries it, §14's two sentences
     about this refusal state the obligation, not the behaviour, and say so where they are written.
   - **Pairing sessions — built.** This document used to state the opposite: that the pairing
     exchange cannot be relayed, because a relayed session is opened with the device grant
     `POST /v1/pair` has not issued yet, and that closing the gap "needs an out-of-band enrolment
     path this protocol does not have". That last clause was the error, and §14 retires it with the
     reasoning stated rather than deleted: the out-of-band enrolment path has existed all along —
     the **QR**, which hands the device the daemon's fingerprint before any carrier is dialled, so
     the daemon is proved end-to-end through the rendezvous before a pairing record could exist.
     What was actually missing was a session mode, not a proof. A phone that cannot reach a daemon's
     address now pairs with it: the sealed pre-auth exchange mints the grant, the session closes,
     and the browser reconnects as an ordinary authenticated request session.
   - **The v2 pairing link — built and WITHDRAWN, with no version spent.** A `#v2` fragment naming the
     first published relay was built here, and the reasoning is recorded rather than deleted because
     the conclusion moved while the problem did not. The problem is real: a device that cannot reach
     the daemon's address cannot ask that daemon where else to look. What changed is where it is
     solved — under the shared default, or matching explicit overrides, the scanning device reads the
     **same hosted directory advertisement the daemon read**, so it finds the rendezvous itself and the
     QR does not have to carry one. Naming an ARBITRARY
     rendezvous in a link is a strictly larger question (which addresses may a QR send a fresh device
     to?) and is deferred with the self-hosted gap above; shipping a fragment format that neither
     works for self-hosting nor stays simple would have been worse than declaring it. So the fragment
     is `#v1;url=…;code=…;fp=…` again, byte-identical to every shipped link, **no reader was ever asked
     to learn a second form, and the version escape hatch is unspent** — a future `v2` may land its
     pattern and its parser together. What survives is the discipline: readers ask the protocol which
     version exists instead of spelling one, and `scripts/validate/cli-contracts.sh` still pins that
     agreement to the WRITER plus the new negative — the writer's output contains no `relay=`. That
     gate exists because a reader did spell a version, and for one commit `fy pair` refused the
     daemon's own link; a shape defect outlives the version that exposed it. The rendezvous a fresh
     device can find is instead disclosed on the mint as `discoveredRelayUrl`, read only by the HOST's
     own screens, and it reaches no fragment.
   - **The relayed rate-limit identity — fixed.** A relayed request used to reach the daemon's route
     table with no client address, so every fixed-window limiter keying by peer collapsed every
     relayed caller on earth into one shared anonymous bucket. A relayed caller is now keyed by its
     rendezvous session, stamped inside the ONE constructor that builds a relayed request, so the
     repair covers every rate-limited relayed route rather than the pairing one alone.
   - **Not every browser call site is routed yet.** The composition root hands the carrier-aware
     fetcher to everything it already injects one into — the projects, usage and push ports, and now
     the TYPED API CLIENT, whose transport used to dial the daemon's own address itself. That last
     one was not only unrouted, it was actively misleading: the Settings reachability probe is a
     typed-client call, so a green `Reachable` pill could sit beside a Carrier panel saying nothing
     worked, and a daemon reachable only through the relay was reported down by a probe that never
     tried the relay. The feature modules that default their `fetcher` parameter to `browserFetch`
     — the direct network — (`learning-api.ts`, `attention-client.ts`, `pin-client.ts`,
     `remote-browser.ts`, `skills-api.ts`, `files-api.ts`,
     `attachment-source.ts`, `runtime-models.ts`, `stt/*`) are still
     direct-only. They FAIL rather than mislead — a request to an unreachable daemon address is a
     visible error, not a blank screen — but until the fetcher is threaded to them those surfaces
     are unavailable over a relay. **`web-terminals.ts` is off this list**, and naming it here was
     the stale item this list carried longest: the terminal deck is handed the carrier-aware fetcher
     by the composition root and its live half is a §14 stream session, so a relayed terminal opens,
     paints and takes keystrokes. What is left of it is narrower and belongs beside the modules above
     rather than as a claim about the file: two OTHER callers of `listSessionTerminals` — the
     composer's `%terminal:` autocomplete and the session surface-references panel — still pass no
     fetcher, so those two READ-ONLY lists are direct-only while the deck beside them is not.
     `stt/*` stays on this list on purpose and for the ordinary reason:
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

**Deploying a relay now gets you the whole journey**: first pairing for a device that has never
reached the daemon directly, every request/response route afterwards, and the live event and
terminal streams that make the phone worth opening twice. What it does not get you is the feature
surfaces listed in piece 3 above — which fail visibly rather than misleading, with one stated
exception: a live event feed refused `4429` is swallowed, and that one fails silently until the gap
above is closed — and a carrier list an operator can edit with a command.
The kill switch does not wait on any of it: `relayUrl: null` is enforced by this Worker at admission
and on the live sweep, so disabling the hosted relay stops traffic regardless of what any client
believes.

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

### One session, one job

The record at sequence `1` is the client's credential, and it is a **strict union of three**. Each
one commits the session to a mode, the mode is decided by that record's own shape rather than by any
later negotiation, and each mode's terminal state is unreachable from the others:

| sequence-1 record | the session is        | what follows                                                           |
| ----------------- | --------------------- | ---------------------------------------------------------------------- |
| `auth`            | a **request session** | any number of `req`, each answered by `res` or `oversize`              |
| `stream`          | a **stream session**  | exactly one protocol-switching stream, in `data` frames, until it ends |
| `pair`            | a **pairing session** | one redemption attempt, one sealed outcome, then the session closes    |

Any other message at sequence `1` ends the session with `4400`. So does any message a mode does not
list: a `req` on a stream session, a second credential record anywhere, a `data` record on a request
session. The mode is enforced by the union, not by convention — a session that "should not" send
requests is a rule nothing checks, while a session whose message schema has no request in it is a
rule nothing can break.

**Why one job per session, rather than one session multiplexing everything.** The alternative was
specified and rejected, and the reasoning is contract because it explains what implementers must not
reinvent. A session has one credit window (§8) and one sequence space (§3), so streams and requests
sharing a session share both: thirty-two outstanding terminal frames would starve — and, under the
window discipline, then kill — the fleet requests underneath them. Repairing that inside one session
means per-stream windows, a stream-id space, fair-scheduling rules and close-race rules: four pieces
of invented machinery, where §5 through §9 already are that machinery. One session per job reuses
the session layer whole — its window is the stream's window, its teardown is the stream's teardown,
its close is the stream's cancellation — and the relay carries **more sessions** instead of new
frame kinds, which is one of the reasons nothing in this section changes the rendezvous state
machine. What the extra sessions cost is stated under "What a stream session costs", because the
ceilings are real.

Two bounds apply from the instant every session opens until its first credential record, because that
whole window is one an internet stranger can hold open against a public fingerprint. A session that
has not completed its client hello and supplied that credential within **10 seconds of open** is
ended (`4400`). At most **6** sessions per link may be pre-credential at once, counting both
`awaiting-hello` and `awaiting-credential`; a further arrival is refused (`4429`) until a slot frees.
Six admits two ordinary three-session device bursts. Keeping all six slots occupied continuously
would cost 36 arrivals per minute against the rendezvous's sliding 30-per-minute admission cap, but
that is a cost rather than a proof against a maximal attacker. The cap is shared by the daemon and
every client; an attacker spending all 30 arrivals can hold five slots and deny honest arrivals at
the rendezvous instead of at this link. The pre-credential bound prices a squat and does not prevent
one. A client that opens several sessions at once must therefore treat `4429` as retryable rather
than fatal. **That is a requirement, and the reference client meets it only by accident**: nothing
in it reads `4429`, and what recovers does so because it retries every
failure that is not a daemon's own final verdict — so the pairing walk advances and a terminal
reattaches, while the live event subscription swallows the refusal and never opens. §13 records that
gap; do not read this paragraph as a description of shipped behaviour. Both numbers are initial
configuration, not protocol constants, in the same spirit as §13's ceilings.

One ordering rule holds across every mode: **nothing follows the credential record until the
daemon's sealed acceptance has arrived.** The credential record already carries everything its mode
needs to start — a stream session's open request included — so there is nothing useful to pipeline
behind it, and a `req` before `authenticated` or a `data` before `stream-opened` is `4400`: it was
sent at a session that had not accepted anything to receive it with. After acceptance, a request
session's answers may arrive in any order — they carry an `id` because the daemon's handlers finish
in their own order — while a stream's `data` records are meaningful only in sequence order, which
§3 already guarantees.

### Request sessions

The credential record:

```json
{ "t": "auth", "protocol": "ferretry-relay/1", "deviceToken": "…" }
```

A token the daemon does not recognise ends the session with `4403`. The daemon accepts by answering,
inside the channel:

```json
{ "t": "authenticated", "protocol": "ferretry-relay/1" }
```

Both refusals and acceptance happen inside the encrypted channel, so a relay sees a session close and
never learns which it was. The daemon resolves the token against its **device** grants only: a host
admin token is not resolvable here, deliberately — it is a host-local secret, and a daemon that
honoured it over the internet would turn a leaked file into remote authority.

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
  token in a query parameter, a `privilegedOnly` route — is unreachable through a relay by construction,
  not by a check somebody has to remember.
- A relayed caller's **rate-limit identity is derived from its rendezvous session** — a value the
  daemon holds and the client cannot choose. It is never a shared placeholder: a daemon that keys
  every relayed caller as one anonymous "remote" peer hands the whole internet a single fixed
  window, and honest devices are refused because a stranger was busy.

The daemon answers each request with one of:

```json
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

### Stream sessions

The daemon's protocol-switching surfaces — `/v1/events` and
`/v1/sessions/:sessionId/terminals/:terminalId/stream` — are sockets that keep talking, which one
request and one answer cannot carry. A stream session carries **exactly one of them**: the socket is
the session, so the session layer already owns the stream's ordering, its flow control, its teardown
and its cancellation, and nothing below this heading invents a second version of any of those.

The credential record opens the stream in the same breath:

```json
{
  "t": "stream",
  "protocol": "ferretry-relay/1",
  "deviceToken": "…",
  "path": "/v1/events",
  "query": [
    ["sessionId", "fy_…"],
    ["after", "0"]
  ]
}
```

`path` and `query` follow the same rules as a `req`'s. An unrecognised token is `4403` before any
route is consulted — outside the channel, indistinguishable from a request session's refusal. A
recognised one is dispatched as a protocol switch against **the daemon's own socket route table**:
the same routes, the same authorization boundary and the same per-capability guard a direct upgrade
passes through, with this session's device token as the credential and never as a loopback peer. A
stream a direct viewer may not open, a relayed viewer may not open either, refused by the same code
in the same place.

**No tickets.** Single-use socket tickets exist because a browser cannot attach a header to a
WebSocket; here the credential is the record, so there is nothing for a ticket to do. `ticket` or
`token` in a stream's `query` is refused with `4400`, for the reason `authorization` is refused on a
`req`: a relayed stream carries exactly one credential, the one its session was opened with. A
client must also not **buy** a ticket it means to spend here — a single-use ticket minted for a
surface that refuses it is a credential the daemon burned for nothing, so the refusal happens before
the purchase, not after.

The daemon answers with exactly one of, inside the channel:

```json
{ "t": "stream-opened", "protocol": "ferretry-relay/1" }
{ "t": "stream-refused", "protocol": "ferretry-relay/1", "status": 404, "body": "…" }
```

`stream-refused` carries the same status and error body the direct surface would put on the refused
upgrade — a 404 for a terminal that was never opened, a 403 the capability guard decided, a 400 for
a query the route cannot read — because everything a status can say must be said **before** the
protocol switches; a stream that opened and then instantly died cannot tell "it is gone" from "the
daemon broke". After `stream-refused` the daemon ends the session with `4440`.

#### Data

After `stream-opened`, both directions speak frames:

```json
{ "t": "data", "text": "…" }
{ "t": "data", "bytes": "<base64url>" }
```

Exactly one of `text` or `bytes`, never both and never neither. The two exist because the direct
socket's frames are typed — terminal input and output are raw bytes, the resize control and every
event are text — and an envelope that collapsed them would leave the receiving end guessing which
one it was handed. Binary travels as unpadded base64url, like every other binary value in this
protocol. What a stream means by its frames is the route's own contract, directionality included:
the event stream is server-to-client and refuses client data itself, the terminal stream carries
bytes both ways and a JSON resize control from the client.

The two value shapes carry **different delivery semantics**, and the difference is what makes an
envelope smaller than the direct socket's frames honest rather than lossy:

- a `text` record carries exactly **one complete text frame** — one event, one resize control —
  because a text frame is a message and half a message is corruption;
- a `bytes` record carries **a run of an ordered byte stream**, delivered to the stream the moment
  it arrives. Byte streams have no frame boundaries worth preserving — a terminal neither knows nor
  cares whether a paste arrived as one write or three — so there is no reassembly, no fragment
  marker, and no buffer waiting for a frame to complete.

**The record is smaller than a direct frame, and the consequences are per stream.** §7 caps a
record's plaintext at 65492 bytes; a record's raw byte budget is what remains after the JSON
envelope around the `bytes` value is subtracted and base64url's four-thirds inflation is divided
back out — a derived number, roughly 48 KiB, not a constant to hard-code, because it moves if the
envelope does. What happens when a producer's frame exceeds it is decided by what the frame means:

- **terminal input** (client → daemon) is a byte stream, so a client splits an oversized write —
  a 64 KiB paste — into ordered `bytes` records and nothing is lost or delayed;
- **terminal output** (daemon → client) arrives from the pane as complete redraws, each superseded
  by the next, so a redraw that exceeds the budget is **dropped** exactly as a backpressured one is
  (below). The residual is disclosed rather than hidden: a pane whose every redraw exceeds the
  budget stays stale for a relayed viewer until it draws something smaller;
- an **event** frame is a unique record that may be neither dropped nor split, so an event that
  cannot fit one record **closes the stream** with `1009` — the honest refusal, like `oversize` on
  a request session, rather than a truncated event a client would parse and believe.

#### Backpressure, and what a full buffer does

A stream's flow control **is** the session's credit window (§8). There is no second layer: a viewer
that stops returning credit stops the daemon's sending, and the daemon's un-credited backlog is the
number its overflow policy reads — the same buffered-bytes figure the direct transport reports, and
it must be reported honestly, because a stream layer that answered `0` would make every existing
backpressure policy vacuous over a relay. What a full buffer means is the stream's own contract, and
the two that exist differ on purpose:

- a **terminal** frame is a complete redraw that the next one supersedes, so an overflowing frame is
  **dropped**, never queued without bound and never fatal;
- an **event** frame is a unique journal record whose loss is silent data corruption, so the stream
  refuses to drop and instead **closes with `1013`**, exactly as it does on a direct socket.

A slow stream must never end for **slowness** by any rule other than its own policy — and under
one-session-per-stream it cannot take anything else down with it, because the window it exhausts is
its own. What per-session windows do **not** buy is stated so nobody claims it: the link is still
one socket, records from every session interleave on it, and sealing is serialised link-wide because
a record's nonce is its sequence number — so a busy stream still adds latency to its neighbours.
What it can no longer do is consume their credit, occupy their window, or end their session.

#### Ending a stream

The daemon ends a stream by sealing the **same close taxonomy the direct socket carries**, then
ending the session:

```json
{ "t": "stream-close", "protocol": "ferretry-relay/1", "code": 1013, "reason": "event stream reader fell behind" }
```

followed by `4440`. `1000 terminal viewer disconnected`, `1008 event stream is server-only`, `1009`
for an oversized frame, `1011` for evidence the daemon could not produce, `1013` for a reader that
fell behind — a relayed viewer reads the same codes a direct one does, and the code travels inside
the channel because it is content: a relay that could read close reasons could read why viewers
leave. The client latches the sealed close first; the `4440` that follows is expected teardown, and
a `4440` with **no** sealed close having crossed in either direction is a protocol violation
reported as one, never reinterpreted as a quiet end. Every conclusion exposes the same unsealed
pair — code `4440`, reason `the session concluded` — regardless of who ended the stream or why. The
actual stream code and reason exist only in the sealed `stream-close`; interpolating either into the
public `closed.reason` would disclose the content the inner record exists to protect.

The client ends a stream the same way: a sealed `stream-close` with the code and reason a direct
close frame would carry — `1000` for a viewer that is simply done — after which the daemon tears the
handler down and ends the session with `4440`. Cancellation is an explicit record rather than a
dropped socket so that the taxonomy survives in both directions and a deliberate leave is never
spelled the same as a network failure; a socket that drops anyway still ends the session the way §9
says, and the daemon treats that as the viewer leaving. There is no half-close and no
EOF-but-still-listening: either side ending the stream ends the session, and anything in flight is
known-lost.

A stream dies with its session, and §9's rule is unchanged: reconnection is a **new** session, never
a resumption. Re-opening is the route's own repair — the event stream's `after` cursor picks up a
session-scoped feed where it left off, a fresh terminal attach paints the current screen — and a
client re-requests rather than assuming, exactly as it must after a direct socket drops.

#### What a stream session costs

Each live stream is one rendezvous session and one client socket, and the ceilings in §5, §9 and §13
now bound product behaviour, so the arithmetic is stated rather than discovered. A tab showing a
fleet holds a request session, an event stream, and one attached terminal — the reference client
attaches only the active terminal in a deck — which is **3 of the 8 sessions** a rendezvous serves;
a third tab on the same daemon exceeds the ceiling and is refused `4429`. That refusal must be
**rendered with its reason** — "this daemon already has as many relayed sessions as the rendezvous
carries" — rather than surfacing as a stream that never opens, because a person with three tabs open
did nothing wrong and can act on the sentence. **No surface renders it yet**, and this sentence is
therefore the obligation rather than a report: the client half that exists is `openStream` throwing
the close code intact instead of demoting the carrier, and §13 carries the rest as an outstanding
gap, including the live event feed that swallows the refusal entirely. Every session open is also a
socket arrival against
§9's 30-per-minute admission (shared with the daemon's own redial), and a hosted daemon holds at
most 16 concurrent sockets (§13); a reconnect loop backing off to a 15-second cap costs about four
arrivals a minute per stream, so the budgets hold — but they are budgets, not slack.

One conformance rule for clients, because it is a credential-lifetime hazard and not a style point:
**every session a client holds for a daemon — request, stream or pairing — must be owned by the same
structure that unpairing and carrier-set replacement tear down.** A stream session outside that
structure is a live socket presenting a device grant that revoking the pairing can no longer reach
from the device's side.

### Pairing sessions

First contact through the tunnel. This document used to forbid it, and the old reasoning is retired
here with its error named rather than deleted.

**What the old reasoning overlooked.** The prohibition said first contact is always direct, that a
relayed session is opened with the device grant `POST /v1/pair` has not issued yet, and that closing
the circularity "needs an out-of-band enrolment path this protocol does not have, and inventing one
under the tunnel would mean a rendezvous carrying an unauthenticated exchange". The last sentence
reads one true clause about the **client** as if it were about the exchange. The out-of-band
enrolment path has existed as long as pairing has: **the QR**. It hands the device the daemon's
fingerprint before any carrier is dialled, and §6 has the client refuse to derive keys — or reveal
anything at all — until the presented identity hashes to that pinned fingerprint. So by the time a
pairing record could exist, the daemon is already proved to the device, end to end, **through** the
untrusted rendezvous. The client side carries no proof, by design and on every carrier: a device
redeeming a code has no credential yet, because the code **is** the credential for that one
exchange — which is exactly as true of the direct path. And the comparison lands the other way
around from where the prohibition pointed: the permitted direct redemption is a plain-HTTP POST to
an address nothing has authenticated, which hands the live code to whatever answers at it, while the
relayed exchange seals the code to a pinned identity before one byte of plaintext leaves the device.
The forbidden path authenticated the daemon; the permitted one never has. What was actually missing
was a session mode — an ordering rule in §6 remembered as a security property — and a session mode
is what this section adds.

**The exchange.** The credential record:

```json
{ "t": "pair", "protocol": "ferretry-relay/1", "code": "XXXX-XXXX", "deviceName": "Ferretry PWA" }
```

`code` and `deviceName` carry the same values, bounds and meaning as the body of `POST /v1/pair`;
their formats belong to the pairing API, not to this protocol. The record is domain-separated from
`auth` and from every other tunnel message by the one strict union — nothing can read it as
anything else — and it is legal **only** as the record at sequence `1`. The daemon answers with
exactly one sealed outcome:

```json
{ "t": "paired", "protocol": "ferretry-relay/1", "response": { "…": "…" } }
{ "t": "pair-refused", "protocol": "ferretry-relay/1", "reason": "pairing_refused" }
```

and then ends the session with `4440`. One attempt per session, success or failure; there is no
second record, no retry on the same channel, and **no edge from a pairing session to serving**. A
device that paired reconnects as an ordinary request session with the token it was just issued.

- **`paired.response` is the redemption response of the pairing API, verbatim** — the exact JSON
  object a direct `POST /v1/pair` answers 200 with, `carriers` included. It is embedded whole rather
  than re-listed field by field, so the next field the pairing API adds crosses the relay the day it
  ships instead of being silently dropped by a copy of the list; and `carriers` crossing inside the
  sealed record is what a relay-paired device navigates by, so an envelope that lost it would mint a
  device that can reach its daemon by nothing at all, with no error anywhere.
- **The client latches the outcome before the close.** The `4440` after `paired` is expected
  teardown, not a failure that overwrites a pairing that succeeded; a `4440` with no sealed outcome
  before it is a protocol violation. Same rule as a stream's close, same reason.
- **Refusal is uniform on purpose.** One machine reason, `pairing_refused`, for every cause — no
  active code, a wrong code, an expired one, a spent budget, a body the schema refused — matching
  the public route's own single refusal. A pre-auth surface the whole internet can reach must not be
  an oracle, which also forbids the cheaper oracle one layer down: a daemon must **not** refuse the
  session early when no code is active. It accepts, keys the channel, runs the same constant-time
  comparison the direct route runs against a dummy code, and refuses identically. An observer —
  relay operator included — cannot distinguish "no code exists" from "wrong guess", and success and
  refusal have the **same frame count**: one sealed record, then the same close.
- **Uniform is not indistinguishable, and the difference is stated rather than glossed.** The frame
  count, the close code and the refusal's own wording are uniform; the record **size** is not, and
  §3 pads nothing. `paired` embeds a whole redemption response and `pair-refused` embeds one machine
  reason, so a relay operator reading one length infers the outcome — not the code, not the token,
  not the device name, and not which refusal it was, but the outcome. §10 owns that disclosure. The
  uniformity above is what denies the **guesser** an oracle, which is the property this exchange
  needs; denying the **carrier** the outcome would take padding this version does not have.

**How it stays closed.** Three rules carry the security argument, and they are contract:

1. **It is a record, not a routed request.** The pairing branch invokes the daemon's pairing state
   machine directly and never constructs an `ApiRequest`: a pre-auth session issues no requests at
   all, so §14's invariant — a relayed request carries exactly one credential, the one its session
   was opened with — stays literally true, and no route is reachable pre-auth, `minimum: 'none'`
   routes and `POST /v1/pair` itself included. The alternative — dispatching an anonymous relayed
   request at the public route — would create the credential-less request path whose absence is the
   whole reason §14's invariant is easy to defend.
2. **Host credentials remain impossible.** The pairing branch reads no `authorization`, resolves no
   token, and never reaches the request path that attaches one; the session holds no credential,
   mints exactly one, and dies. A host admin token is not accepted here for the same reason it is
   not accepted at `auth`.
3. **Replay is already closed by §7.** The `pair` record is sealed under this session's keys with
   its sequence number as the nonce, and a fresh session has fresh keys — a captured record cannot
   be replayed into any other session. The code itself is single-use and consumed before any
   suspension point, so two concurrent redemptions cannot both win, and the minted token crosses
   once, sealed, in a record no relay can read.

**Where the device learns the rendezvous.** A pairing link names the daemon's direct address,
fingerprint and code, and **nothing else**. A device that cannot reach that address still needs a
rendezvous to dial and still cannot ask the daemon it cannot reach — the circularity is real — and it
is broken on the DEVICE's side rather than in the link: the app's build carries
`HOSTED_RELAY_DIRECTORY_ORIGIN`, reads that no-store advertisement once per document, and dials the
address it names. By default that is the **same advertisement the daemon read** when it chose its own
fallback carrier, so both ends arrive at one rendezvous without anything travelling out of band
beyond the fingerprint. An operator using the explicit overrides must point the daemon's runtime
setting and the PWA's build-time setting at the same directory; a mismatch fails closed as described
above. The address obeys the ordinary published-relay URL rule — `wss:`/`https:` anywhere,
plaintext only against loopback — and an advertisement that fails it yields no candidate at all. The
walk for a redemption is the ordinary one, and §1's rule does not bend for pairing: **direct first,
always**; then that one discovered rendezvous.

A **v2 fragment carrying `relay=<percent-encoded wss URL>`** was specified and built here, so a daemon
published only on a self-hosted rendezvous would have been pairable off-LAN. It is withdrawn: which
addresses a QR may send a fresh device to is a larger question than the hosted default needs, and §13
declares the consequence — such a daemon is pairable only from a device that can already reach its
direct address. Readers keep ignoring an unrecognised field name, so a stray `relay=` on a link is
dropped rather than honoured; a reader that dialled one would let whoever composed a URL choose where a
pre-auth socket opens.

The rendezvous is for **this one redemption** and is never stored: what a device navigates by
afterwards is `paired.response.carriers`, the daemon's own published set. **The client refuses a
relayed pairing whose published set does not name the rendezvous the exchange itself crossed** — the
set always names it or the pairing fails, so the client never has to choose between keeping an
address the daemon did not publish and discarding the only address that works, and the stored set
stays purely what the daemon said. The refusal has a cost stated plainly: the daemon has already
minted the grant, so the operator sees a device the device itself discarded, revocable like any
other. Reaching that state takes the operator changing the carrier configuration inside the code's
own two minutes.

Compatibility is normative, not advice, and this narrowing is what makes it easy: **the fragment stays
the three-field `v1` form, so no reader anywhere is asked to learn anything.** A reader older than this
change accepts exactly what a daemon after it emits, in both directions, which is why the narrowing was
safe to land late. A reader keeps rejecting a duplicated field name while ignoring an unrecognised one
— a duplicate is a real ambiguity, an unknown name is the next version arriving — and the recogniser
`PAIRING_FRAGMENT_PATTERN` admits exactly the version the parser understands, because a gate that
admitted more would turn a loud `unreadable` into a silent cold screen for somebody who just scanned a
QR.

The one ordering obligation left is the ordinary `strictObject` rule in `version-skew.ts`, and it is
about the MINT rather than the link: `discoveredRelayUrl` is a new key on `PairingCodeMintResponse`,
whose readers are `fy pair` (released with `fyd`) and the hosted Add-a-device panel (deployed ahead of
the binary). Both directions are satisfied by the same release discipline `PairingResponse.carriers`
already used.

**Two attempt budgets, because two carriers.** The direct path's budget is unchanged: five attempts
per code, and exhausting them expires the code. A relayed attempt spends a **separate relay budget**
of five per code and can never spend the direct one; exhausting the relay budget closes the **relay
path** for that code and leaves the code alive for a device on the LAN. The separation is the point:
redemption used to be reachable only from the daemon's own network, and this section makes it
reachable by anyone on the internet who knows a public fingerprint — what such an attacker can buy
is not the code (the space is 32⁸ ≈ 1.1 × 10¹², the TTL two minutes, the comparison constant-time)
but the code's **availability**, and a shared budget would let five junk guesses from anywhere kill
a code sitting on somebody's desk. With the split, an active relayed guesser degrades relayed
redemption for that code and nothing else. That residual is the priced cost of this feature; it is
bounded further by every attempt costing a full rendezvous session — a socket arrival against §9's
30-per-minute admission, a pre-credential slot from the bound above, a handshake — and it is
disclosed here rather than discovered.

A transport failure spends nothing from either budget: a rendezvous nobody holds (`4404`), a busy
one (`4429`), a disabled one (`4431`), a fingerprint that fails the pin — none of these reached the
daemon's comparison, so the walk may continue to the next carrier. A sealed `pair-refused` is the
opposite: the exchange happened, the answer is final for that attempt, and the remedy is the direct
route's own sentence — the code is wrong, expired or spent; mint a fresh one. A client must keep the
two apart, and it can do so structurally: one arrives as a close outside the channel, the other as a
record inside it.

Minting is governed exactly as before: the `pairing` capability governs who may **mint**, redemption
is credentialed by the code itself on every carrier, and an operator who switches `pairing` off has
stopped new codes from existing — with nothing minted there is nothing to redeem, relayed or not.

**What a relay operator sees of a pairing** is §10's list, with the parts specific to this exchange
restated once: a pre-auth session for fingerprint X at time T from IP Y, a handshake, one sealed
record each way, a `4440` close — never the code, the token or the device name, and never the outcome
as anything it can read, but the sealed answer's SIZE infers the outcome and this document says so
rather than claiming the exchange is outcome-blind. "Fingerprint X
gained its first device at T, from Y" is a new operator-visible event that used to happen invisibly
on a LAN; this design accepts that disclosure as the price of a phone that can pair from anywhere,
and says so.

### What this tunnel does not carry

**A second credential, on any session.** `authorization` on a request, `ticket` or `token` on a
stream, a host admin token anywhere — every path by which a caller could present authority beyond
the credential that opened its session is refused by schema, and the pairing session carries the
inverse guarantee: it presents no stored credential at all and can never reach a route.

**A loopback peer.** A relayed arrival is never local, whatever address the socket appears to come
from — the rendezvous terminates on the host it serves, and everything a daemon grants a loopback
caller is unreachable through a relay by construction.

**This list no longer excludes dictation.** The daemon's byte-shaped speech routes — an audio upload
and a multi-megabyte model download — are deleted, because recognition now happens in the browser.
The only speech-to-text request a daemon answers is `POST /v1/stt/enhance`: an already-transcribed
transcript in, a repaired transcript out, ordinary JSON both ways, which this tunnel carries like any
other request/response route. No microphone audio crosses this tunnel, and none crosses the daemon
boundary at all. What keeps that route unreachable over a relay today is not its shape but an
unthreaded fetcher, which §13 piece 3 records.

**And nothing else is excluded by shape any more.** Requests, live events, terminal streams and
first pairing each have a session mode above, and each is built on both ends; §13 names what is
still outstanding around them, none of it a shape this tunnel cannot carry. None of it changes the
rendezvous: every message this section added is sealed record plaintext the relay cannot read, and
the one novelty visible outside the channel — the `4440` close — is an ordinary code inside the
range §5's `closed` message already carries, which a deployed rendezvous forwards today without
modification. Where that code LIVES is decided here rather than improvised at a compile error:
`4440` is **application-tunnel vocabulary, not rendezvous vocabulary** — the rendezvous neither
emits it nor dispatches on it — so it is owned and exported by the endpoint-shared protocol package
as `RELAY_SESSION_CONCLUDED_CLOSE_CODE`, which the relay package already depends on, and
`packages/relay` changes **zero** code and zero behaviour for anything in this section. One export,
consumed by both endpoints, keeps the vocabulary from forking across the daemon link and the browser
session — the invisible kind of difference §1 calls the expensive kind — without adding a member to
the rendezvous's own close-code constants for a close the rendezvous never sends. The derived `data`
byte budget above is owned the same way, as that package's `relayDataByteBudget`: both ends take the
number from one derivation, each passing in the record ceiling, so a split write and the seal that
receives it cannot disagree by arithmetic.
