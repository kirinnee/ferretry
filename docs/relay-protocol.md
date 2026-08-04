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

There are **two** carriers, and one security model across both.

| Carrier            | What it is                                                                          | When to use it                                         |
| ------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **Direct**         | The browser opens a WebSocket straight at the daemon.                               | Whenever the daemon is reachable. This is the default. |
| **Your own relay** | A Cloudflare Worker + Durable Object **in your account**, forwarding opaque frames. | The daemon is behind NAT and you want remote access.   |

**There is no hosted relay, and there is no relay address compiled into anything Ferretry ships.**
Section 9 explains why that is a design decision rather than an unfinished feature.

Direct is preferred whenever it is configured and reachable. It has fewer hops, fewer parties and
less to go wrong, and it is strictly better on every axis when it works. An implementation must not
make somebody opt out of a relay to get the simple thing, and must not fall back to a relay
silently: if direct was configured and failed, the surface says so, and says why.

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

The token's own format belongs to the daemon's pairing API, not to this protocol.

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

**Refusals cost the caller more than the relay.** An unknown daemon fingerprint is refused by the
stateless Worker before any Durable Object exists. Beyond that: at most 4 unproved daemon sockets, at
most 30 socket arrivals per rendezvous per minute, and every limit above.

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

What the operator cannot see: any frame payload, the device token, session content, command output,
daemon or device names, or anything about what the fleet is doing.

A **direct** carrier removes all of the above except what the networks in between can see anyway.
That is the main reason to prefer it.

---

## 11. Running your own relay

```
1. Put your daemon fingerprint in packages/relay/wrangler.jsonc → vars.RELAY_DAEMON_IDS
2. task relay:deploy
```

`RELAY_DAEMON_IDS` is a space- or comma-separated list of `fy_daemon_…` fingerprints. A fingerprint
is public — it is printed in the pairing QR — so this is configuration, not a secret. **An empty
list serves nobody**, which is the only safe reading of a relay whose operator never said who it is
for.

Then point both ends at it: the daemon's relay address and the browser's must be the same string,
because it is the `host` the claim signature covers.

### What you are taking on

Read this before you deploy, so you learn it here rather than from a bill.

**You are operating a relay.** Durable Objects bill per request, per duration and per instance. Every
session your daemons hold costs your account, for as long as it is held. Hibernation makes an idle
rendezvous close to free, but a busy one is not free.

**A relay cannot police what it carries, and that is by design.** This deployment is structurally
incapable of reading what it forwards. That property is what makes it safe for _you_; it is also
what would make an open one an ideal anonymous tunnel. That is precisely why this deployment serves
only the fingerprints you list, and why there is no shared instance anyone can point at.

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
