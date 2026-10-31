# The Ferretry rendezvous protocol

Rendezvous control plane: `ferretry-relay/1` · end-to-end session: **`ferretry-relay/2`**

Two identifiers, deliberately. Everything a relay parses — frames, §5's control messages, its
Durable Object naming — is still `/1`, so no relay was redeployed when sessions changed. Everything
inside the channel — §6's handshake and every §14 record — is `/2`, which is where device keys
(§6, "The credential record") replaced the device token. A `/1` session peer meets a `/2` one with
`4426` at the handshake and a sentence naming which side to update (§9); there is no negotiation and
nothing to downgrade to.

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

There are four **kinds** of carrier and one security model across all of them. This section and §§2–14
describe the first two; §15 adds WebRTC and the hosted Cloudflare tunnel, and the per-device choice
among them. Which carriers a daemon holds is the daemon's answer rather than the browser's.

| Carrier    | What it is                                                                      | Where it belongs                                                  |
| ---------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **Direct** | The browser opens a WebSocket straight at the daemon, and runs a session on it. | Attempted first under **Auto** (§15), and in first contact (§14). |
| **Relay**  | A Cloudflare Worker + Durable Object forwarding opaque frames it cannot read.   | The **default** carrier (§15). Up to four; Ferretry operates one. |

**The default asks nothing; a choice exists for whoever wants one.** The owner decided on 2026-10-21
that a person may choose a carrier per device and machine — Auto, WebRTC only, tunnel only or relay
only (§15) — and a later decision the same day made **Relay the default**, with no Auto mode unless it
is chosen: a device and machine nobody chose for goes through the relay (each rendezvous the daemon
published, in its own order, then the hosted fallback). Auto stays an explicit option — direct first,
because direct has fewer hops and fewer observers; then WebRTC; then a tunnel when the daemon published
one; then the relays. This retires the earlier rule that a conforming product has no carrier
chooser. What it does not retire: nothing has to be chosen to work, a carrier is still chosen by
trying it, there is no silent degradation, and a surface that shows a connection without naming its
carrier and why the others were passed over is not conforming. The interim three-way chooser that was
removed (§13 piece 5) chose a relay's OPERATOR during onboarding; the §15 choice is a preference over
carriers the daemon already publishes, and onboarding still asks no carrier question.

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
it out of onboarding and ordinary setup rather than offering a third thing to decide about.

---

## 2. The security model, in one paragraph

Encryption terminates at `fyd` and at the browser. Never at the edge.

The daemon holds a long-term **Ed25519** identity created at install; its SHA-256 fingerprint is the
`daemonId`, and the pairing QR already carries that fingerprint out of band. Every session runs an
ephemeral **X25519** key agreement, authenticated by an Ed25519 signature from the daemon over the
whole handshake transcript, and every byte after that is **AES-256-GCM** with the frame header as
associated data. The client authenticates itself afterwards, inside the encrypted channel, by signing
that same transcript with the **non-extractable device key** it registered at pairing — so what it
presents proves possession for exactly one session and replays into nothing.

That is the TLS 1.3 arrangement — ephemeral agreement for forward secrecy, a signature over the
transcript for identity, the client's own signature over the transcript only after the channel is
keyed (TLS 1.3's `CertificateVerify`) — and it is chosen because it is standard and reviewed, not
because it is clever. Nothing here is invented. A device that holds no grant yet may instead redeem a
pairing code inside the same keyed channel — after the fingerprint check, never before it — and §14
bounds that exchange to exactly one attempt per session.

**Both carriers run this.** A direct carrier is not plain HTTP with a header: the browser opens a
session on the daemon's own listener and everything above is identical, so the LAN is encrypted end to
end too and nothing on it is worth replaying.

The result: a relay operator, including a hostile one, can drop your traffic, delay it or refuse to
carry it. They cannot read it, alter it, or insert into it, and they cannot introduce your browser
to a daemon that is not yours.

**What a relay operator can still see** is in §10. It is more than nothing, and pretending otherwise
would be worse than disclosing it.

---

## 3. Wire format: frames

Everything on the wire is one binary WebSocket message carrying one frame. The framing is identical
on both carriers — a relayed conversation and a direct one are byte-for-byte the same above the
socket — with two exceptions: the heartbeat in §8, and that a direct socket carries exactly one
control frame, the daemon's own `ready` (§5).

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
| `0x01` | `control`   | hop-by-hop | UTF-8 JSON, §5. Direct: only the daemon's `ready`. |
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

**The direct carrier, exactly.** `fyd` serves `GET /v1/rendezvous/<its own daemonId>/client` as a
WebSocket upgrade on its own listener. **One socket is one session**: on upgrade the daemon mints the
16-byte `sessionId` and sends the client the same `ready` a rendezvous sends (`limits` included), and
that is the only control frame on the socket — the daemon never sends `challenge`, accepts no
`claim`, and refuses with `4400` a client that sends any control frame at all. The session's end is
the socket's close, with the code the session ended with. A wrong `daemonId` is `404`. An upgrade is
ADMITTED before any public-key work is done for it. At most 30 admitted upgrades a minute from one
peer address (a refused upgrade spends none of them) and at most 2 unproven sockets per remote
address — the host's own loopback address is exempt, because every tab on it shares one — each answer
`429`. At most 16 sockets may be unproven and 64 open in all; when either is full the OLDEST unproven
socket is closed `4429` to make room, rather than the newcomer refused, so squatting needs to out-race
honest arrivals rather than merely arrive first. With all 64 proven, the next upgrade is `429`. The
slot is reserved at admission rather than at attach, so concurrent upgrades cannot all pass the check
before one is counted, and a reservation whose socket never attaches is released after ten seconds. Where the session ARRIVED —
loopback, the privileged bind, the peer address — is the listener's classification of the upgrade,
exactly as for an HTTP request on the same listener, and nothing inside the session can move it.

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

Both frames use the all-zero `sessionId`. Each has one optional field, present only once a feature
(below) has been negotiated: `claim` may carry `replaces`, and `claimed` may carry `features` and
`handover`.

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

### Features, and the claim probe

Every control message is a strict shape (an unknown `t` or key is refused, and the socket closes), so
nothing beyond the messages above is ever **assumed** of a peer. A feature is asked for and echoed:

1. The daemon names the features it speaks in its route's query string:
   `…/v1/rendezvous/<daemonId>/daemon?features=claim-probe,claim-handover`. A rendezvous that does not
   know the parameter ignores it — the route is the path, and only the path.
2. A rendezvous that speaks one echoes it in `claimed`, and adds the key **only** for a daemon that asked:
   `{ "t":"claimed", "protocol":"ferretry-relay/1", "limits":{ … }, "features":["claim-probe"] }`.
   `features` is never empty and never names a feature the daemon did not ask for, so an older daemon's
   strict parse never meets it. Unknown names in the query are ignored, not refused.
3. Neither side uses a feature the other did not name. An old daemon on a new rendezvous, and a new
   daemon on an old one, both stay on exactly the messages above.

None of this changes `ferretry-relay/1`: an endpoint that never asks sees byte-for-byte the protocol it
always saw, which is why it is a feature and not a version.

There are two features so far, `claim-probe` and `claim-handover`.

**`claim-probe`**:

```
daemon → relay    { "t":"probe" }     sessionId = all zero
relay  → daemon   { "t":"held" }      sessionId = all zero — this socket still holds the claim
```

The rendezvous answers from its own state, never from the edge, so `held` proves what `fy-pong` (§8)
cannot: that the rendezvous still names this socket as the daemon. There is no "not held" message. A
probe from a socket the rendezvous does not name is refused `4410` — the socket is plainly alive, it
just spoke, so the slot is what was lost — and the daemon claims again on a new socket at once. A probe
is hop-by-hop: it is never forwarded and never metered (§13).

**`claim-handover`** lets a daemon take its OWN rendezvous back the moment it knows its socket is gone,
instead of being refused `4409` until the sweep (§9) evicts a socket the rendezvous never heard close:

```
relay  → daemon   { "t":"claimed", …, "features":[…,"claim-handover"], "handover": <32 bytes b64url> }
daemon → relay    { "t":"claim",   …, "replaces": <32 bytes b64url> }       on a LATER socket
```

- `handover` is a random token the rendezvous mints for the socket that has just been accepted as the
  daemon, and sends in `claimed` — **only** to a daemon that asked for `claim-handover`. It is never sent
  to anyone else, so `claimed` for a daemon that did not ask is byte-for-byte what it always was.
- A daemon that holds one and whose socket has ENDED puts it in `replaces` in its next claim. It does
  not send `replaces` while the socket that was issued the token is still the holder, and it forgets the
  token once it has been used, and when a claim is refused for any reason except `4409`. A refusal of
  `4409` leaves it, because the same daemon may well have another try coming.
- `replaces` is a field of `claim` only when the claim socket asked for `claim-handover`; on any other
  socket it is a protocol error (`4400`), because a peer that did not negotiate the feature gets the
  strict shape it always had.
- The token is single-purpose. Each accepted claim is issued a NEW one, and the old one stops working at
  the moment it supersedes — see §9 for exactly what a matching `replaces` does.

The token is a bearer secret, and it is safe because of where it goes: `claimed` travels only over the
holder's own TLS socket, and the daemon keeps it only in memory. A second copy of the daemon's key —
someone who has the key but not that socket — can pass every check in the claim and still not hold it.

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
client whose device proof it does not accept.

### Limits

`limits` is published so no endpoint has to guess what will be refused:

```json
{ "maxFrameBytes": 65536, "creditWindowFrames": 32, "maxSessions": 8, "heartbeatSeconds": 30 }
```

---

## 6. The handshake (`kind = 0x02`)

Two frames, one each way, both at sequence `0`.

```
client → daemon   { "t":"hs1", "protocol":"ferretry-relay/2",
                    "epk": <32-byte X25519 public key b64url>,
                    "nonce": <32 bytes b64url>,
                    "daemonId": "fy_daemon_…" }

daemon → client   { "t":"hs2", "protocol":"ferretry-relay/2",
                    "epk": <32-byte X25519 public key b64url>,
                    "nonce": <32 bytes b64url>,
                    "spki": <44-byte SPKI b64url>,
                    "sig":  <64 bytes b64url> }
```

The daemon refuses an `hs1` whose `daemonId` is not its own. On a correct carrier that cannot
happen, which is exactly why it is checked: on an incorrect one it is a misrouted session, and
answering would key a channel to a peer that thinks it reached somebody else.

**Version skew is answered, not guessed.** A daemon that receives an `hs1` naming `ferretry-relay/1`
ends the session with `4426` and the sentence that says the APP is older and how to update it. A
client that receives an `hs2` naming `/1` — or, while it awaits `hs2`, a `closed` `4400` with the
reason `unparseable client hello`, which is what a `/1` daemon says to a `/2` hello — reports that
the DAEMON is older, naming the update commands. On the direct carrier an older daemon has no session
route at all, so after a direct failure the client reads `GET /healthz`: an `ok` answer whose
`sessionProtocol` is not `ferretry-relay/2` is an older daemon, said in that same sentence, and no
further carrier is tried.

### Transcript

```
TH = SHA-256(
       "ferretry-relay-handshake-v2"
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
sig = Ed25519-Sign( daemon identity key, "ferretry-relay-daemon-auth-v2" ‖ 0x00 ‖ TH )
```

### Client checks, in this order

1. `SHA-256(hs2.spki)` matches the pinned fingerprint. **If it does not, abort** — no signature
   check, no key derivation, and above all no device proof.
2. `sig` verifies over `"ferretry-relay-daemon-auth-v2" ‖ 0x00 ‖ TH`.
3. Key agreement (below) yields a usable secret.

### Key schedule

```
IKM = X25519(own ephemeral private, peer ephemeral public)     -- abort if all-zero
k_c2d = HKDF-SHA256(IKM, salt = TH, info = "ferretry-relay-c2d-v2", 32 bytes)
k_d2c = HKDF-SHA256(IKM, salt = TH, info = "ferretry-relay-d2c-v2", 32 bytes)
```

`HKDF-SHA256(ikm, salt, info, L)` is extract-then-expand, RFC 5869. Separate keys per direction mean
a record cannot be reflected at its sender and accepted.

### The credential record

Immediately after the handshake, at sequence `1`, the client sends a `data` record whose plaintext
is its credential. There is no bearer value in it. A paired device names its grant and **signs this
session's transcript** with its device key:

```
proof = Ed25519-Sign( device key, "ferretry-device-auth-v2" ‖ 0x00 ‖ TH ‖ LP(t) ‖ LP(deviceId) ‖ LP(appSession) )
```

`t` is the record's own mode (`auth` or `stream`), so a proof for one mode opens no other;
`appSession` is 16 random bytes the page draws once per load and signs in, naming "this running copy
of the app". A device with no grant yet instead redeems a pairing code once, registering the public
half of a freshly generated key and proving it holds the private half:

```
proof = Ed25519-Sign( new device key, "ferretry-device-pair-v2" ‖ 0x00 ‖ TH ‖ LP(deviceKey) )
```

The daemon verifies the proof against the SPKI it stored at pairing, or sends `{"t":"closed",…}`
for the session — unknown device, idle-expired device and bad proof are ONE refusal, `4403`, so the
answer is not an oracle for which ids exist. None of it appears outside the encrypted channel, so a
relay sees neither the device id nor the code; this is why the credential travels after keying rather
than during, and the fingerprint check above is why sending a live pairing code here is safe. Because
`TH` binds both ephemeral keys, both nonces, the daemon's identity and the session id, a captured
proof verifies for no other session.

The device id's and the code's own formats belong to the daemon's pairing API, not to this protocol.
The exact records that carry them, the lease that follows, and the session mode each commits to are
§14.

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

#### Endpoint keepalive (non-normative)

"At least every `heartbeatSeconds`" is a floor, not a cadence, and the reference endpoints ping more
often. Both the daemon and the browser send `fy-ping` every **20 seconds** and treat a socket that has
delivered nothing — no pong, no frame — within **10 seconds** of a ping as dead: they close it with
`4408` and dial again. Two reasons. Mobile carriers and NAT devices can forget an idle mapping in well under
a minute, and a mapping that is forgotten never sends a close, so an endpoint waiting for the
rendezvous's own `× 1.5` eviction would sit on a dead socket for most of a minute. And because the
auto-responder answers `fy-ping` without waking the Durable Object, the faster cadence costs the
rendezvous nothing. A browser also runs an immediate check — one ping, a **4-second** deadline — on
every held session when the page comes back to the foreground, the device comes back online, or the
network type changes, so a phone that wakes with a dead socket learns so in seconds. None of this
changes the wire: a peer that pings only every thirty seconds is still conforming, and the
rendezvous's eviction rule is unchanged.

**A deadline that fired late measured the browser, not the carrier.** A phone that hides an installed
app freezes the page or throttles its timers to about once a minute, and on the way back every overdue
timer and every queued message is delivered in an order the browser does not promise — so a `fy-pong`
that arrived during the freeze can be queued behind the deadline it answers. A browser deadline that
fires more than **2 seconds** past its time is therefore forgiven **once**: instead of closing, the
browser pings again with the 4-second liveness-check deadline on the now-running page. Answered, the
session lives; silent again, it is closed `4408` exactly as before. Any evidence of life re-arms the
forgiveness.

**A drop is recovered before it is said.** A held session that ends under a browser is redialled on the
same carrier at once: the connection model's first retry, a live feed's first reopen and a terminal's
first reopen all wait **under 300 ms** (equal jitter where there is a schedule), and nothing tells the
person "reconnecting" until the outage has lasted **1.5 seconds** (2 for a session's live chip). Every
drop is still recorded on the device — the carrier, the close code, how long the session had lived and
since it last heard anything, whether the page was hidden and for how long, the network type where the
browser says, and how long the next session took to open — and shown with a Copy button under Settings ›
Machine › Performance, so "it keeps reconnecting" arrives with evidence. Nothing in that record is a
credential or an address, and it is never sent anywhere.

#### What `fy-pong` cannot prove

`fy-pong` is answered by the runtime holding the socket, not by the rendezvous: the auto-responder
consults neither the stored state nor the object's code. So it proves the **socket** is alive and
nothing about the **claim**. On 2026-10-19 the hosted rendezvous stopped naming a daemon's socket as
the holder while the runtime kept that socket open; the daemon's pings kept passing for sixteen
minutes, and every phone was told `4404` until the daemon was restarted. A daemon whose rendezvous
offered `claim-probe` (§5) therefore sends one `probe` with each keepalive ping and expects `held`
within the same 10-second deadline. A socket that answers `fy-pong` but not `probe` is dropped with
`4408` and the daemon claims again; a `4410` is the rendezvous saying the same thing first. The probe
does wake the Durable Object, which the rendezvous's own 30-second sweep (§9) already does while a
daemon holds the slot, so the marginal cost is small.

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

**The one exception: a handover.** A claim from a socket that asked for `claim-handover` (§5) which
names the incumbent's token supersedes it. The rendezvous decides this only AFTER the claim is
verified (the fingerprint matches and the signature holds — §5), and only when ALL of these are true:

1. a daemon holds the rendezvous, and its slot carries a token (it was accepted as a daemon that asked
   for `claim-handover`);
2. the new claim's `replaces` is present and equals that token, compared in constant time;
3. the claim socket itself asked for `claim-handover`.

Then, in this order: the old socket is closed `4410` with the reason "replaced by a fresh claim from the
same daemon" (nothing is sent first — it is probably dead); every session on it ends exactly as if the
daemon had dropped, so each client is told `closed` (`4404`) and reconnects as it would after any
daemon drop; and the new socket becomes the daemon and is sent `claimed` carrying a NEW `handover`.
The old token is gone with the slot it lived in.

Everything else is unchanged. A claim with no `replaces`, a wrong one, or one to a rendezvous whose
holder has no token is refused `4409` after its verdict, exactly as before — the incumbent wins. The
reason another holder of the daemon's key cannot do this is that the token is not derived from the key:
it is random, travels only over the incumbent's own socket, and exists only in the rendezvous's storage
and the daemon's memory, so a claim that is perfectly signed still has nothing to put in `replaces`.
The cost of a handover is what a dropped daemon already costs, and no more: its sessions end and
reconnect. A socket that did not ask for the feature is still refused `4409` the moment it arrives,
before it is challenged.

**Many clients, each in its own session.** Up to `maxSessions` (8) clients may be connected at once —
a phone and a laptop, say. There is no shared "the client" slot to be ambiguous about. Each session
is an independent end-to-end conversation with its own keys, and one client can never address
another's session.

**No daemon, no session.** A client arriving at a rendezvous no daemon holds is closed with `4404`
rather than parked. There is nothing to wait for that the client cannot retry.

**The sockets are the truth; the stored state is corrected against them.** A rendezvous keeps its
state in storage and its sockets in the runtime, and a reset, a lost close event or a defect can make
the two disagree. Before every arrival, frame and sweep the reference rendezvous reconciles them:

- a slot, unproved socket or session whose socket the runtime no longer holds is gone, exactly as if
  its close had arrived — so a reset that swallowed the closes cannot leave the slot "held" and turn
  every redial into `4409`;
- each proved claim is also written **on the socket that holds it** (a WebSocket attachment, which
  survives hibernation with the socket), and erased before the rendezvous closes that socket or hears
  it has gone. If the state names no daemon but a socket still carries a claim, the claim is restored
  to it — a phone is never told `4404` while the daemon's claimed socket is attached. What the daemon
  was carrying is not restored: a frame it sends for a session from before is answered with that
  session's `closed` (`4500`, "the rendezvous lost this session") instead of ending its socket;
- any other socket carrying a claim is refused `4410`, so its daemon claims again rather than waiting
  on a socket nobody can reach it through.

**Forwarding does not wait for the write.** Every forwarded frame moves its session's credit window
(§8), the window is part of the rendezvous's stored state, and so the reference rendezvous writes that
state on every frame. On Cloudflare a Durable Object's outgoing messages are held until its storage
writes are confirmed durable — the runtime's _output gate_ — so every relayed keystroke and every
redraw used to leave the rendezvous only after a durable write. A step that changed nothing but a
window is therefore written with `allowUnconfirmed`: the frame leaves at once and the counter is
persisted behind it. A step that changed nothing at all — a claim probe's `held` — is not written,
and every step that admits, ends or reshapes a session is still written and confirmed before anything
it sends. What that gives up is bounded and stated: should the runtime fail to confirm such a write it
resets the object, and a session that outlives the reset holding counters older than its traffic is
ended (`4430`) by the first frame its restored window disagrees with, after at most the frames
forwarded since the last confirmed write. Nothing about the end-to-end channel depends on the
counters. How long Cloudflare takes to confirm a write is not measurable from this repository; the
local benchmark models it (§14, "What a keystroke costs").

**Reconnection is normal, and it is not resumption.** A session is bound to its sockets. When either
socket drops, the session ends and both sides are told. Frames in flight are lost — and _known_ to be
lost, because the sequence discipline in §7 turns a gap into a torn-down session rather than a quiet
hole. Reconnecting creates a **new** session with new keys and a new session identifier. The
application above must re-request whatever it had in flight. There is no resume, no replay buffer,
and no "probably fine".

**Redial at once, then back off, forever (non-normative).** A rendezvous that restarts — a relay
deploy, an edge migration — drops every socket on both sides at the same moment. The reference daemon
redials immediately, then with equal-jitter exponential backoff (500 ms doubling, capped at the
configured `reconnectSeconds`, itself clamped to 1–10 s) for as long as it runs, and logs every
disconnect, attempt and reconnection; the jitter keeps a fleet of daemons from arriving in the same
millisecond, and a redial that meets the incumbent's not-yet-evicted socket (`4409`) simply backs off
again. The reference browser does the same with a 10 s cap and retries at once on the triggers above.
What it re-requests is the application's business: reads are re-sent transparently on the new
session, a live stream reopens from its own cursor, and a write whose session died after it left is
never re-sent blind — the send ledger decides, from evidence, whether it arrived.

**Self-hosted refusals cost the caller more than the relay.** An unknown daemon fingerprint is
refused by a self-hosted deployment's stateless Worker before any Durable Object exists. The hosted
deployment deliberately accepts any valid fingerprint, reserves account-wide capacity before
routing it, and explains a refusal over an accepted WebSocket before closing so a browser can show
the real reason. Beyond that: at most 4 unproved daemon sockets, at most 30 client socket arrivals per
rendezvous per minute, a separate 30 for the daemon, and every limit above. Refused arrivals count.
The two windows are separate so that clients retrying against an absent daemon — every phone after a
relay restart — can never spend the budget the returning daemon needs to end the outage; they once
shared one, and the daemon was refused `4429` for as long as the clients kept trying.

### Close codes

| Code   | Meaning                                                                                         |
| ------ | ----------------------------------------------------------------------------------------------- |
| `4400` | protocol error: unparseable, or right message in the wrong state                                |
| `4401` | claim rejected: fingerprint mismatch or bad signature                                           |
| `4402` | claim deadline expired                                                                          |
| `4403` | the daemon refused the client's device proof — unknown, idle-expired, revoked or bad signature  |
| `4404` | no daemon holds this rendezvous                                                                 |
| `4408` | heartbeat timeout                                                                               |
| `4409` | a daemon already holds this rendezvous (and the claim did not carry its handover token)         |
| `4410` | this daemon socket is live but no longer holds the claim — lost, or replaced by a handover (§9) |
| `4413` | frame too large                                                                                 |
| `4420` | sequence broken: a frame was dropped, duplicated or reordered                                   |
| `4421` | a record failed authentication                                                                  |
| `4426` | unsupported version or protocol identifier; a `/1` peer of a `/2` one is told which to update   |
| `4429` | rendezvous busy: session, socket or rate limit reached                                          |
| `4430` | flow violation: the sender exceeded its credit window                                           |
| `4431` | the hosted relay is disabled by its runtime kill switch                                         |
| `4432` | a per-daemon or global hosted connection ceiling was reached                                    |
| `4433` | a per-daemon or global hosted bandwidth ceiling was reached                                     |
| `4440` | the session concluded; code and public reason are constant, while the outcome was sealed first  |
| `4441` | the access lease ended (§14): open a new session — this is never a revocation                   |
| `4500` | the rendezvous itself failed                                                                    |

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
  cannot read a single keystroke can still watch the rhythm of somebody typing. And because a
  terminal's daemon-to-browser frames carry only what changed (§14, "What a keystroke costs"), their
  sizes track how much of the screen changed — one repainted row for a typed character, the scrolled
  lines for output — rather than how much is on it.
- **How many clients** are connected to a daemon, and when each arrived and left.
- **That a first pairing happened, and — from one record's size — how it ended**, when the exchange
  crosses a relay (§14): a pre-auth session opened for fingerprint X at time T from IP Y and ended
  seconds later. Success and refusal each send exactly one sealed record and then the same close, so
  the exchange is uniform in **frame count** and in close code. It is **not** uniform in **size**,
  and this document used to claim the outcome could not be inferred at all. It can. There is no
  padding (above), so a record's length is its plaintext's length: a `paired` record embeds the
  pairing API's whole redemption response — the minted device id and the published carrier set
  included — while a `pair-refused` record is one short machine reason. The two differ by hundreds of
  bytes, which is not a subtle side channel but a shape an operator can read directly, and it is
  disclosed here rather than left to be discovered. What the size does not give up is any of the
  content: the code, the device key, the device name and every other byte of plaintext stay opaque, and a
  refusal's own cause stays uniform — "no code is active" and "wrong guess" produce the identical
  record, so the anti-oracle property §14 argues for is untouched. On the direct carrier this event
  is invisible to everybody but the LAN; over a relay it is a new metadata class.
- **The rhythm of a session's access lease.** A renewal is one sealed record each way, about two
  minutes before each fifteen-minute lease ends, so an observer can count how long a session has been
  held. What it cannot see is which device holds it.

The hosted deployment makes a bounded subset of that metadata durable for its operator: per-daemon
and global request counts, encoded bytes actually forwarded, accepted/refused connection counts,
current and peak concurrent connections, first/last activity timestamps, and the current minute/day
byte windows. It does **not** store source IP addresses in that meter, although Cloudflare and its
request logs can observe them as described above. Metrics are behind the operator bearer; the public
advertisement exposes only `version` and `relayUrl`.

What the operator cannot see: any frame payload, the device id or key, the pairing code, session content,
stream content — events, keystrokes, terminal output — command output, daemon or device names, or
anything about what the fleet is doing. A pairing exchange's **outcome** is deliberately not on this
list any more: nothing about it is readable, and its record size infers it anyway, per the bullet
above.

A **direct** carrier removes all of the above except what the networks in between can see anyway.
That is the main reason to prefer it.

---

## 11. Running your own relay

This is an **expert opt-in path**. The required onboarding and ordinary setup do not ask anyone to do
it, because the hosted relay in §13 carries anyone who does not want to operate their own. It exists because someone should
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

Then point the daemon at it with a `relay` entry in its `carriers` list (§13). The browser is not
configured separately: it dials the address the daemon publishes, so both ends use the same string,
which matters because it is the `host` the claim signature covers. A device that has never paired
cannot discover a rendezvous you run — the declared gap in §13 — so the runbook says how such a
daemon gets its first device.

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
- **Eviction is simulated, not run.** The suite evicts a rendezvous by building a fresh object over
  the same storage and the same attached sockets — what Cloudflare documents an eviction to leave — and
  proves a phone is served afterwards, including when the stored state had lost the claim. It cannot
  prove which Cloudflare event made a real deployment's state and sockets disagree on 2026-10-19; that
  is why §9 reconciles them on every handler and §5's probe makes the daemon find out, rather than
  either relying on one cause having been fixed.
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
when its answer is missing or unusable.

#### Reservations are leases, and the counters are derived from them

**The concurrency counters are a cache of the reservation rows, never the other way round.** A counter
that only moved on admit and release drifted for good the first time a release was lost, and on
2026-10-19 that locked a daemon out of the hosted relay permanently: Cloudflare reset the rendezvous
object, its sockets went with it (`1006`, no close frame), no `webSocketClose` was ever delivered for
them, and their reservations stayed held. After a few such resets the daemon's row read 16 of 16, and
every dial for the rest of the day — about fourteen thousand, across daemon restarts — was refused
`4432` before it reached a rendezvous that could have said nothing was there. So:

- **The rendezvous's socket list is the evidence.** The runtime lists every socket a rendezvous
  accepted, hibernating ones included, and drops the ones it lost; each socket carries its reservation
  in its attachment. On its heartbeat sweep, at most once every **60 seconds**, a hosted rendezvous
  reports the reservations its live sockets carry (`/internal/reconcile`). The control object stamps
  those `confirmedAt` — a **renewal** — and reclaims at once any of that daemon's reservations no socket
  carries, except one younger than the **30-second handoff grace**: the Worker reserves before the
  rendezvous accepts, so a fresh reservation may not be in any report yet. A lost report costs a
  renewal, never a slot.
- **An unrenewed reservation expires.** A reservation whose last renewal (or, before any, its opening)
  is **10 minutes** old is reclaimed without anyone's word. That is ten renewal intervals and five
  control-outage graces, so neither a missed report nor a tolerated outage can expire a reservation a
  live socket holds, and it covers the case with nobody left to report: the rendezvous lost every
  socket and has no alarm, or the stateless Worker died between admission and handoff — the residual
  this section used to disclose as unrecoverable.
- **Recount before refusing.** An admission that a connection ceiling would refuse first audits every
  reservation: expired ones are reclaimed, then the daemon's counter and the global one are SET to the
  number of reservations that remain. It costs one listing, only on an admission that was about to be
  refused. A report from a rendezvous recounts the same way. A release whose counters disagree with
  its reservation — zero, or a daemon row that is gone — deletes the reservation and recounts, instead
  of refusing and keeping the reservation for ever, which made the one piece of evidence that could
  free the slot the thing that held it.
- **It fails closed on evidence it cannot read.** A reservation that will not parse stops the audit
  and nothing is deleted; the refusal it would have repaired stands. Audits change only
  `concurrentConnections`; peaks and cumulative totals are history and are never rewritten. Any audit
  that reclaimed or corrected something logs the counts (never a fingerprint), because it means a
  release was lost somewhere.

A stored lockout clears itself on the first admission after this rule deploys: the stranded rows are
older than the lease, so that admission reclaims them, recounts, and is served. The daemon, for its
part, treats `4432` as an answer rather than a dead path: it waits one to two minutes before redialling, and the window
doubles to ten minutes over a run of refusals (equal jitter, so never less than a minute) instead of
redialling every few seconds, saying so in one line per attempt.

Default limits are deliberately configuration, not protocol constants:

| Ceiling                   | Per daemon |  Global |
| ------------------------- | ---------: | ------: |
| Concurrent WebSockets     |         16 |     512 |
| Encoded bytes per minute  |    512 MiB |   4 GiB |
| Encoded bytes per UTC day |     20 GiB | 200 GiB |

At most 10,000 daemon metric rows are created. The operator can replace all limits through the same
runtime configuration endpoint.

**Why these numbers.** The byte ceilings bound a bill, and Cloudflare does not bill bytes: Workers
charge "no additional charges for data transfer (egress) or throughput (bandwidth)", and a Durable
Object is billed for requests (incoming WebSocket messages at 20:1, outgoing ones free), metering
round trips and wall-clock duration. What a relayed byte costs is the messages that carry it, and a
frame is at most 64 KiB, so 20 GiB is at least ~330,000 frames — even at a pessimistic 1 KiB average
it is ~21 million incoming messages, about $0.16 of Durable Object requests at $0.15 per million
billed (October 2026 list prices). The global day ceiling holds ten such daemons. The first-deployment
ceilings (64 MiB a minute, 1 GiB a day per daemon; 1 GiB and 16 GiB global) bounded a cost that was
never the risk and locked an owner out of their own machine in an afternoon of terminal and
transcript traffic.

**Raising a default reaches existing deployments.** A deploy seeds limits only into an untouched
control object, so a stored configuration keeps the defaults of the release that first wrote it.
Every read of the configuration therefore treats a stored limits document that equals a **former**
default set field for field (`SUPERSEDED_HOSTED_RELAY_LIMITS`) as the current defaults; a document
that differs in any field is the operator's choice and is kept exactly. Nothing is rewritten in
storage — the next operator write persists whatever it is sent — and because admission, metering and
inspection all read through that rule, a daemon refused `4433` under a superseded ceiling is admitted
on its first dial after the deploy. The one thing an operator cannot express is a limits document
identical to a superseded default set; changing any one value is enough. A connection ceiling is checked before routing. **A byte ceiling is
checked within one meter round trip of the bytes that crossed it, never on a frame's path.** A
rendezvous forwards a frame first and then counts it; it keeps at most one report to the control
object in flight, and every frame it forwards while that report travels goes into the next one, as
one batch of `events` and `bytes`. The bytes a report names were relayed, so they are counted even
when they cross a ceiling — the refusal stops what follows, not what already crossed. A refusal sends
a typed `error` control frame to every socket the rendezvous holds and then closes them with `4432`
or `4433`, including the reason (and, for bandwidth, a reset timestamp in the control-plane
decision). **A byte-ceiling refusal carries its reset in the reason** — one of four fixed sentences,
then `; resets <ISO-8601 UTC instant>` (`hostedBandwidthReason`; the longest is 91 bytes, inside a
WebSocket close reason) — rather than as a new `error` field, because `error` is a strict shape and an
older build would discard a frame with an extra field, explanation and all. A reason without the
suffix, from a relay deployed before it, is read by the same rule the windows follow: the next UTC
midnight for a day, a minute for a minute (`parseHostedBandwidthRefusal`). The daemon treats `4433`
as a date rather than a dead path: it redials at the reset, but never sooner than a minute and never
later than **30 minutes**, so an operator who raises the ceiling is picked up within half an hour,
with up to 30 seconds of jitter so refused daemons do not all redial at midnight. A browser shows it as
the allowance that ran out, when it resets in local time, and that direct connections still work; a
hosted-only refusal (`4431`–`4433`) also labels its carrier "Hosted relay" even on a device that has
not discovered the hosted address. **An unreachable control object is not a refusal.** A missing or unusable answer to a
meter report or to the periodic inspection is asked for once more, and then live sockets keep
carrying for up to 120 seconds from the first failure: the unreported bytes are folded into the next
report, the heartbeat sweep keeps running, and the next frame or sweep asks again. Before this, one
lost answer from the single global control object closed every socket on the rendezvous — the
daemon and every client — with no ceiling crossed. An outage that outlasts the window is `4500` and a
refusal, so nothing degrades into an unmetered path for longer than that window; a definitive answer
— the kill switch, a ceiling — still closes at once. A new arrival still needs a reservation, so
admission during an outage fails closed as before.

**Why not per frame, and what it costs.** The meter is one globally named object, placed wherever it
was first created, while a rendezvous is created near the daemon that first claimed it. Holding every
frame for a transactional round trip to it — the original design — put that distance on every frame,
serially, because a rendezvous handles its frames in order: a rendezvous in Tokyo with the meter in
North America paid a Pacific round trip per frame, a page load's hundred-odd frames took seconds, and a
terminal redrawing ten times a second produced frames faster than the queue could drain them. Batching
makes the meter cost one round trip per round trip instead. The price is a bounded overshoot: a
ceiling can be exceeded by what one rendezvous forwards during one meter round trip — a fraction of a
second of its traffic — before the refusal lands. The ceilings are cost guards, not
security boundaries, and the overshoot is counted, so the bill is never understated. A rendezvous
evicted while a report is in flight loses at most that one batch of counts.

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
effect throws, and a partial kill-switch sweep attempts every socket before reporting failure. A slot
stranded anyway — a socket the runtime lost without a close, a Worker that died between admission and
handoff — is reclaimed by the rule in "Reservations are leases" above: at once when the rendezvous
reports no socket holds it, and within ten minutes when nothing is left to report. That bound is what
keeps every such failure transient, and it is the rule that was missing on 2026-10-19.

What cannot be done about it is the point: **the relay cannot tell abuse from use.** Distinguishing
them means reading what is being carried, and it structurally cannot. Enrolment, quotas per identity
and abuse review are the service apparatus this design refuses. So the trade is stated rather than
solved: an open carrier, bounded by ceilings and a kill switch, in exchange for a carrier nobody has
to deploy.

### Honest hosted disclosure

Ferretry and Cloudflare can observe the daemon fingerprint, IP addresses, connection timing and
duration, encoded frame counts and sizes, traffic timing, and concurrent connections. When a first
pairing crosses this relay, that includes the fact that a pre-auth session opened for a fingerprint
and when, from which IP — never the code, the key or the device name, and never the outcome as
anything readable, but the outcome IS inferable from the size of the one sealed answer, because
`paired` carries a whole redemption response and `pair-refused` carries one word (§10).
When a terminal stream crosses it, frame timing is keystroke timing, and — because an unchanged redraw
is not sent again and a changed one carries only the change (§14) — the timing of daemon-to-browser
frames is when the screen changed, and their size is how much of it changed. The same
is true of a remote-browser view, whose frame sizes also track how much of the page is changing. The operator meter persists the
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
GET /v1/carriers        inside a session the paired device key opened, fetched no-store

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
   **a direct session not accepted within 4 seconds is a transport failure too.** A private direct
   address seen from a cellular network drops packets rather than refusing them, so a socket to it
   neither opens nor fails; waiting out the 45-second heartbeat grace for it put that wait in front of
   the relay on every page load away from home. A reachable daemon keys a session in three round trips.
   A rendezvous keeps the full grace, because it is the last resort;
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
list by hand, a fresh device can discover only the hosted rendezvous, no surface renders the session-ceiling refusal §14 requires it to, and one onboarding
screen has not caught up with §1.

**What proved it, and what that proof does not cover.** A real Google Chrome, holding the link a
compiled `fy pair` printed, redeems a first-pairing code across a real rendezvous process against a
freshly compiled standalone `fyd` — after opening a connection to the advertised direct address and
having it fail at transport — then reconnects as an ordinary authenticated session over the same
rendezvous and renders a live event the daemon appended. The code, the device key, the minted grant id, the device name
and the event payload appear in none of the frames the rendezvous handled.
`tests/e2e/relay-browser-pairing.e2e.test.ts` is that journey. Its honest limits are the ones
`tests/e2e/README.md` records and §12 already draws: real Chrome, real compiled binaries, real
WebSockets and the **real** rendezvous state machine, with Cloudflare's own runtime substituted —
hibernation, the auto-responder, durable storage and alarms are ports, not `workerd`. So it proves
this protocol's behaviour end to end and still proves nothing about Cloudflare. **That
compiled-browser tier is local and does not run in CI.** The focused PWA build-contract unit guard
covers the Vite directory override in CI, and the existing unit and integration tiers guard the
protocol behaviour; none turns the full Chrome journey itself into a CI guard.

Discovery is supplied by [PR #202](https://github.com/kirinnee/ferretry/pull/202): the PWA reads and
parses this advertisement from the directory origin Vite compiles into the bundle, whose default is
`@ferretry/relay`'s `HOSTED_RELAY_DIRECTORY_ORIGIN`. That browser read does three jobs: it supplies the
last-resort hosted carrier after the daemon's published set fails, supplies the **only** relayed
first-pairing candidate after direct fails, and lets a surface disclose whether an address is
Ferretry's rendezvous or somebody's own. A failed, malformed or switched-off read guesses nothing.
When that discovery read fails, first pairing has only the direct candidate and therefore no relayed
first contact; for an already paired device the failure removes the last-resort hosted carrier but
leaves direct and the daemon-published set.

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
the device sends the pairing code, its device key or any payload, so neither a divergent directory nor
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
neither a payload nor the device id or key.

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
   - **Every browser call site is routed — and has to be.** There is no plain-HTTP device path any
     more: a daemon answers a paired device only inside a session, so a module that reached a daemon
     with the bare network would fail on EVERY carrier, the daemon’s own LAN included. The composition
     root hands the session-routed fetcher to every port it builds, and every component that reaches a
     daemon reads it from `useDaemonFetch()`; an audit of each `fetcher = browserFetch` default found
     no production caller that omits it. The defaults remain only so a component rendered alone in a
     test reaches its stub. The **remote-browser viewer** was the last surface outside this, written
     against the deleted socket tickets; it is now a stream session on either carrier like the
     terminal (§14, "Stream sessions").
4. **Active-carrier disclosure on screen** — DONE. `ActiveCarrierCard` renders
   `chooseConnection().reason` and the `describeConnectionMethod` observer list for whichever
   carrier a live session won on, from `DaemonCarrierRouter.choice`, on the machine’s Machine tab in Settings
   (Connection). It leads with one status — direct, via relay (whose, and its host — never the daemon
   fingerprint), or reconnecting — and the third comes from the reconnect loop's state
   (`connection-health.ts`), not the router, because the router remembers the carrier that last WON
   and would otherwise go on naming a connection that is gone. A carrier nothing has measured yet says
   so rather than defaulting to "direct".
5. **Removal of the interim carrier chooser and self-hosting setup route** — DONE. First run asks
   no carrier question: the `connect` step, the `own-relay` answer and the four self-hosting steps
   are gone, and the daemon step carries a read-only note (`onboarding-connection-note.tsx`) saying
   direct is tried first and the hosted relay is the automatic fallback, with the live advertisement
   state and what the relay would see. Self-hosting is left to the expert runbook: the Connection
   panel links it, beside a sentence saying a relay of your own is configured on the daemon and the
   app only follows what the daemon publishes, so there is still no second place a carrier could be
   chosen. Nothing here has a setting, and a stored onboarding document from before the chooser was
   removed is read and its `connection` answer ignored rather than refused.

**Deploying a relay now gets you the whole journey**: first pairing for a device that has never
reached the daemon directly, every request/response route afterwards, and the live event and
terminal streams and the remote-browser live view that make the phone worth opening twice. What it
does not get you is a live event feed refused `4429` (swallowed,
so it fails silently until the gap above is closed), and a carrier list an operator can edit with a
command.
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

The record at sequence `1` is the client's credential, and it is a **strict union of three** today —
`auth`, `stream`, `pair` — and of **five** once catalogs phase 2b serves `join` and `member` (Member
sessions). Each
one commits the session to a mode, the mode is decided by that record's own shape rather than by any
later negotiation, and each mode's terminal state is unreachable from the others:

| sequence-1 record | the session is        | what follows                                                                             |
| ----------------- | --------------------- | ---------------------------------------------------------------------------------------- |
| `auth`            | a **request session** | any number of `req`, each answered by `res` (in parts when large)                        |
| `stream`          | a **stream session**  | exactly one protocol-switching stream, in `data` frames, until it ends                   |
| `pair`            | a **pairing session** | one redemption attempt, one sealed outcome, then the session closes                      |
| `join`            | a **join session**    | one share-code redemption, one sealed outcome, then the session closes (Member sessions) |
| `member`          | a **member session**  | requests on the member route table only (Member sessions)                                |

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
that is a cost rather than a proof against a maximal attacker. The client cap is shared by every client (the daemon has its own); an attacker spending all 30 client
arrivals can hold five slots and deny honest clients at the rendezvous instead of at this link. The pre-credential bound prices a squat and does not prevent
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
{
  "t": "auth",
  "protocol": "ferretry-relay/2",
  "deviceId": "fy_device_id_…",
  "appSession": "<16 bytes b64url>",
  "proof": "<64-byte Ed25519 signature b64url>"
}
```

`proof` is §6's device-auth signature with `t = "auth"`. A device the daemon does not hold, one that
is idle-expired, or a proof that does not verify against the stored key all end the session with the
same `4403`. The daemon accepts by answering, inside the channel:

```json
{
  "t": "authenticated",
  "protocol": "ferretry-relay/2",
  "accessExpiresAt": "<ISO-8601 instant>",
  "rotateBy": "<ISO-8601 instant>"
}
```

`rotateBy` is optional: present when the machine asks for device-key rotation, it is when this device's
key is due for replacement (see "Replacing the device key" below). A daemon that sends none asks for no
rotation, which is what an older one means.

The proof and the acceptance travel inside the encrypted channel; the refusal is a close, and a close
code is in the clear, so a relay sees `4403` (and later `4441`) and learns WHEN a session was refused
— never which device, and never why. An unknown device id is verified against a fixed dummy key, so
it costs what a known one does. The daemon resolves the claim against its **device** grants only: a host
admin token is not resolvable here, deliberately — it is a host-local secret, and a daemon that
honoured it over the internet would turn a leaked file into remote authority. Every request the
session carries is attributed to that device and that `appSession`, and the daemon re-asks at the
request boundary whether the device is still paired, so a request in flight on a session being torn
down by a revocation is refused rather than served.

#### The access lease

There is no bearer access token: the "access ticket" is a **lease the daemon holds against one
keyed session**, 15 minutes from the moment the proof verified (`accessExpiresAt`). Two minutes
before it ends, the daemon sends — on request and stream sessions alike —

```json
{ "t": "renew", "protocol": "ferretry-relay/2", "nonce": "<32 bytes b64url>", "expiresAt": "<ISO-8601>" }
```

and the client answers at once, with the same key, over the same transcript:

```
proof = Ed25519-Sign( device key, "ferretry-device-renew-v2" ‖ 0x00 ‖ TH ‖ LP(nonce) )
{ "t": "renewed", "protocol": "ferretry-relay/2", "proof": "…" }
```

An incoming record is what prompts the answer, so a background tab — whose timers a browser
throttles — still renews in time. A valid answer re-checks that the device is still paired and not
idle-expired and extends the lease 15 minutes from now — but never past **12 hours** from the
session's first proof, at which point the session ends `4441` and the client opens a fresh one; the nonce is
single-use, and a `renewed` with no outstanding `renew` is `4400`. A lease that runs out ends the
session with **`4441`**, which a client reads as "open a new session" and never as a revocation: a
**read** (`GET`, `HEAD`) is asked again once on a fresh session, silently; a write is not, for the
reason no write is replayed. `4403` stays the only code meaning "this device is no longer accepted".
The daemon also compares the clock with the lease on every record it serves, so a record that
arrives after the lease ended is never served even when the lease timer fires late, and it queues
`renew` ahead of any payload waiting for credit. What the lease buys is that authority on any one
channel needs a device signature at least every fifteen minutes and never outlives twelve hours, and
every renewal re-reads revocation and expiry from the daemon's own state. Neither an auth nor a
renewal counts as USE of the device: see `presence` below.

**For a test, and only shorter.** An end-to-end run cannot wait out fifteen minutes, twelve hours or
the shortest idle period (one day), so `fyd` reads `FYD_TEST_TIMINGS` once at boot — JSON naming any of
`leaseSeconds`, `renewLeadSeconds`, `maxSessionSeconds` and `idleDaySeconds`. Each may only be at most
the shipped value: a longer one refuses the boot rather than being clamped, because a longer lease
would keep a revoked device's channel open longer. Shortened timings in force are said once in the
boot log. Unset, the numbers above hold exactly.

#### Replacing the device key

A machine's owner sets how often a device's key is replaced (`deviceKeyRotationDays`,
[design/zero-trust.md](design/zero-trust.md) B6). Once `rotateBy` has passed, the device replaces its key
inside its next passkey ceremony — the unlock, or a step-up — with no separate record and no extra prompt. It mints a new
non-extractable key, keeps it as **pending** before anything is sent, and adds to the `POST /v1/unlock` or
`POST /v1/step-up` body, carried by a session the OLD key opened:

```
proof = Ed25519-Sign( NEW device key, "ferretry-device-rotate-v2" ‖ 0x00 ‖ TH ‖ LP(deviceId) ‖ LP(deviceKey) )
"rotation": { "deviceKey": "<new SPKI, b64url>", "proof": "…" }
```

`TH` is the carrying session's transcript hash and `deviceKey` is the new key's base64url text, so the
proof is good for one session and one device. An overdue unlock or step-up without a rotation is refused
`403 step_up_rotation_required` without spending its challenge. The daemon checks the proof, then the
passkey assertion, then rewrites the device's key, closes every OTHER session the device holds with
`4441` (each reopens with the new key), keeps the carrying one, records `device.key-rotated`, and answers
`keyRotated: true`; the browser then promotes the pending key. From then on the old key opens nothing
(`4403`). If the answer is lost, the browser's next session is refused on the old key and it tries the
pending key once — so a dropped response never strands the device.

#### The unlock

A machine unlocks on opening by default (`unlockOnOpen`, [design/zero-trust.md](design/zero-trust.md) B1).
A session still opens — the device key is proved as always — but every request and every stream open
answers `401 { "code": "unlock_required" }` until the device unlocks with a passkey through
`POST /v1/unlock/options` and `POST /v1/unlock`, which are served, as are `GET /v1/passkeys`,
`GET /v1/security` and passkey registration under its own rules. One unlock lasts `unlockValidityHours` for that device, across page loads, and is the
step-up for every act inside it unless the owner asks per act. A stream already open when the unlock lapses
ends with the sealed `1008` at its next lease renewal. This is a daemon response, not a session record:
nothing on the wire beside it changes.

Afterwards, any number of requests:

```json
{
  "t": "req",
  "id": 1,
  "method": "GET",
  "path": "/v1/sessions",
  "query": [["sessionId", "fy_…"]],
  "headers": { "content-type": "application/json" },
  "body": "…",
  "presence": true
}
```

`query`, `headers`, `body` and `presence` are optional; `id`, `method` and `path` are not.

- **`presence`** is `true` when a person is at the device: the page is visible and was touched,
  clicked or typed in within the last five minutes, by trusted input the browser raised. A page that only
  loaded (a restored tab, a launch at login, a reload) is not a person. It is the
  ONLY thing that advances the device's `lastSeenAt`, and therefore its 30-day idle clock — an auth,
  a renewal or an unmarked request never does, so a tab left open renews its session without keeping
  the device paired forever. It is the device's own word: it answers a forgotten device, not a
  hostile one.

- **`id`** identifies the answer, and must be unique within the session. A repeat is `4400` rather
  than an overwrite: an answer that could belong to either of two requests is worse than a closed
  session.
- **`path`** is the daemon's own raw pathname and must begin with a single `/`. Nothing normalises
  it. A relayed request reaches exactly the route table a direct one reaches, and the authorization
  boundary inspects the same string the handler is given.
- **`query`** is a list of pairs, not an object, because `?sessionId=a&sessionId=b` is meaningful and
  an object cannot hold it.
- **`headers`** are lowercased and single-valued. **`authorization` is refused** with `4400`: the
  credential for a session's request is the device proof that opened the session and nothing else, so
  a request cannot promote itself past the grant it arrived under. (A client strips the header before
  it builds the record.)
- A relayed request is **never a loopback peer**. Everything a daemon grants a loopback caller — a
  `privilegedOnly` route — is unreachable through a relay by construction,
  not by a check somebody has to remember. A **direct** session's requests carry the arrival the
  listener classified at the upgrade (§4) — so a browser on the host is host-local exactly when it
  would have been over plain HTTP — and nothing inside a record can change it.
- A relayed caller's **rate-limit identity is derived from its rendezvous session** — a value the
  daemon holds and the client cannot choose. It is never a shared placeholder: a daemon that keys
  every relayed caller as one anonymous "remote" peer hands the whole internet a single fixed
  window, and honest devices are refused because a stranger was busy.

The daemon answers each request with one of:

```json
{ "t": "res", "id": 1, "status": 200, "headers": { "content-type": "application/json" }, "body": "…" }
```

**A conditional read is an ordinary request and answer**, because every byte a session carries is
metered. `GET /v1/sessions/:id/logs` — the transcript tail the chat page re-reads every few seconds,
tens to hundreds of kilobytes — carries a strong `etag`, a digest of the text after redaction. A
request whose `if-none-match` names it is answered `304` with an empty body, and the client returns
the body it holds for that exact path. The client holds the last 16 paths in memory, per connection;
it sends a validator only for a path it holds, and treats any other `304` as an error, never as an
empty transcript. An unchanged transcript costs its headers, a few hundred bytes. The same headers
work on the direct path: `if-none-match` is an admitted CORS request header and `etag` an exposed one.

**Older history is paged, conditionally too.** The chat reads its tail as `GET /v1/sessions/:id/log-page`
(`{ v, sessionId, log, start, file }`: the `/logs` text plus the byte it begins at and an opaque file
token), and scrolling up reads `?before=<start>&file=<token>` for the page just older, until a page
starts at `0`. Each page is its own path, so the polled tail keeps its `304` while older pages are held.
Pages are whole records and meet exactly at `start`; a page asked of a file that is no longer the
session's transcript is `409 log_cursor_stale`. An older daemon answers `unknown_route` and the chat
keeps reading `/logs`.
Each page also carries `offsets`, one byte offset per line of `log`, so a row knows where it came from.
`GET /v1/sessions/:id/log-search?q=…&who=all|me|agent&tools=0|1` searches the whole transcript and
answers every match oldest first with that same offset and a scrubbed snippet; the chat loads pages back
to a match's offset and scrolls to the row that holds it. A search is asked once per query and is not
conditional.

**An image of a transcript is addressed, not embedded.** `/logs` prints `[fy-image <handle> <type>]`
where an image was, and `GET /v1/sessions/:id/transcript-images/:handle` answers one image as JSON
(`{ image: { handle, mediaType, byteLength }, base64 }`). The handle names a record by its offset and
length plus an ordinal, so it never changes for a transcript that is only appended to, and the answer
is `cache-control: private, max-age=31536000, immutable` with a strong `etag` over session, handle and
size; a request whose `if-none-match` names it is answered `304`. It is governed exactly like `/logs`.

`GET /v1/sessions` — the fleet list every open app re-reads on a beat, about 1.7 MB on a fleet with forty
running sessions — is conditional the same way. Its tag is a digest of the exact JSON served, so it moves when any field
of any session moves (a status, a name, a turn count, `journalSequence`), and is computed from the
body the route already built. The client holds the one last list per connection and answers a `304`
with a fresh copy of it. A daemon that predates the tag sends no `etag`, and the client holds
nothing and reads in full as before.

**A running session's view moves with its transcript** (its context-usage fields follow the last
turn), so on a fleet with many running sessions the list genuinely changes on most beats and most reads
are a `200`, not a `304`. That is the tag telling the truth, not a tag that never matches: the tag is
deterministic, it does not depend on when the list was read, and two reads with nothing changed between
them are a `304` on the second. It is deliberately NOT derived from a version counter. Building the
list reads each running session's transcript tail, so no version is cheaper than the body, and a tag
that skipped the build could answer `304` for a list that had moved. What a large, changing list costs
on the wire is what the next paragraph removes.

**A compressed answer** (`gzip`). Only a caller that sends `accept-encoding: gzip` in a `req`'s `headers`
may be answered with the gzip bytes of the body the route would have sent, as unpadded base64url in
`body`, under two response headers. **A request that names no `accept-encoding` — every app and every
relay client that predates this — is never answered compressed, by any route.** The framing:

```json
{
  "t": "res",
  "id": 7,
  "status": 200,
  "headers": {
    "content-type": "application/json",
    "etag": "\"…\"",
    "content-encoding": "gzip",
    "content-transfer-encoding": "base64url"
  },
  "body": "<base64url of the gzip bytes>"
}
```

The rules, each of which is a reason it can be trusted:

- **Nothing in the envelope changed.** `res` is a strict object, so a new key would be a breaking change
  (the version-skew rule). Negotiation rides in free-form `headers`, which makes the change additive on
  both sides: an older daemon ignores `accept-encoding` and answers plain, and an older app never sends
  it and is never answered compressed. Neither end can be sent something it cannot read. The names and
  values are `TUNNEL_*` in `@ferretry/protocol`, read by both ends.
- **A relayed answer is not a browser fetch**, so nothing decodes it for the app. `RelayClientSession.request`
  asks for gzip itself (where `DecompressionStream` exists), decodes before it returns, and removes the two
  headers, so every caller reads the plain text the route wrote. A body that claims compression and is
  unreadable rejects the request; it is never returned as if it were the answer.
- **Compression happens before sealing.** The daemon gzips once, in the dispatcher, and the tunnel seals
  the bytes it is handed, on the direct carrier and the relayed one alike. Plain HTTP (`curl`, `fy`) takes
  the same bytes as an ordinary `Content-Encoding: gzip` body that its client decodes.
- **The decoded bytes are the plain answer, and the tag does not change with the encoding.** The `etag` is
  the digest of the plain body, so a client that learned it over one encoding revalidates over the
  other, and a `304` is decided before anything is compressed. The 32 MiB bound is on the body as it
  travels, which is the base64url text.
- **Only an answer worth compressing is.** A route that opted in (below), `GET`, `200`,
  `application/json`, at least 8 KiB. An error, a `304`, a text answer and everything a `POST` returns are
  never compressed, and a route that cannot gain from compression sends the answer it always did. A
  response that varies by encoding carries `Vary: Accept-Encoding`.
- **Nothing is compressed unless its route was audited and opted in (BREACH).** Compress-then-encrypt
  makes a record's length depend on its content, so an answer that carries a secret, a token or the
  digest of one, a pairing code or input-request material beside text a caller can influence lets an
  observer of sizes recover it a byte at a time. A list of routes that must NOT be compressed is wrong
  the day someone adds a route and forgets it, so the default is off and the set that is on is the
  short, audited one: `GET /v1/sessions` (the fleet list: names, states, context counters and the
  hashes of launch-instruction sections, which authorise nothing) and `GET /v1/board` (the board list:
  work-item titles, states and the people's own work text). Every other route — passkeys, secrets, the
  security settings, pairing codes and devices, fleet credentials and MCP authorisation, the tunnel,
  push subscriptions, the browser sign-in window and state, file, diff and attachment bytes, session
  transcripts, messages, logs and any input request — answers plain, and so does any route added
  later. The route flag is `compress: true`; `tests/unit/runtime/mounts/surface.test.ts` pins the exact
  set, so enlarging it is a visible change that has to say what its body can hold. Every credential this
  daemon mints is also the answer to a `POST`, which is never compressed whatever the route says. A
  terminal or event stream is never compressed either: see below.

**A live feed starts where the reader already is**, to spend fewer bytes in the same way. A session view carries
`journalSequence`, the journal's last sequence read just before its documents, and a reader that has
the view opens `/v1/events?sessionId=…&after=<journalSequence>` rather than `after=0`: replaying a
long session's history was ~370 KB per 1000 events on every chat open, for events the page never
reads (its transcript and surfaces are read directly). A daemon that predates the field sends none,
and the reader replays as before. Alongside it, the reference client sends an identical read that is
already in flight once (`shared-reads.ts`): the answer is shared, never cached.

**A live feed says it is live at once.** As soon as its replay (and any append that overlapped it)
is delivered, `/v1/events` sends one `idle` frame — the ordinary proof, with the ordinary
`idleSeconds` and the scope's current `after` or `followedSessions` — and then one per quiet window
as before. A reader counts a feed as live once it has heard from it, and a quiet session used to say
nothing for the first 30 s, so every reader ran its fast fallback polls for 30 s on every open. The
frame also marks the edge: everything before it was replay, everything after it is live. It is the old
frame rather than a new kind because the frame schema is strict, and an older reader would refuse an
unknown kind or key, and with it the stream.

**A session feed may say when its transcript moves.** A reply's text blocks, its tool calls and their
results reach the agent's transcript with no journal event: nothing about the turn changed. So a reader
that re-read the transcript only on events showed each block when its poll came round — a second or
three while the turn read as working, and up to the relaxed poll once it did not. `?transcript=1` on a
per-session stream (`/v1/events?sessionId=…&transcript=1`) asks the daemon to send, after its replay,
one frame each time the session's proved transcript file is written:

```json
{ "kind": "transcript", "transcript": { "sessionId": "…", "at": "2026-10-28T17:00:00.000Z" } }
```

It carries no content — the reader re-reads through its ordinary conditional read, so the two can
never disagree — and, like `live`, it counts as traffic for the idle proof. The daemon hears the file
through its file-event hub and speaks only when the file's size or modification time actually moved,
and it looks for the file again whenever the session's journal moves (a first message binds one, a
`/clear` moves to another, which is itself a change). The flag on a fleet stream is refused
(`transcript_needs_session`). The frame schema is strict, so only a stream that asked ever carries
one. A daemon that predates the flag refuses it as an unknown parameter with `400` before any frame;
the reference client then reopens the stream at once without it, spends nothing from its retry budget,
and reads on events and its poll as before.

**A fleet feed may skip its replay.** With no cursor, `/v1/events` without a `sessionId` replays the
last 5000 events across the fleet on every connect — megabytes on a busy fleet. `?tail=N` (an integer
from 0 to 5000, default 5000) bounds that, and `tail=0` replays nothing: the reader opens the feed,
waits for its opening proof, reads `GET /v1/sessions` (conditionally), and from then on re-reads the
list only when an event says something moved. `tail` on a session stream is refused
(`tail_needs_fleet`); that stream resumes from `after`. A daemon that predates `tail` refuses it as
an unknown parameter, so a reader decides from the daemon's version (`x-fy-version`) whether to send it.

**A body larger than one record travels in ordered parts**, in both directions. §7 caps plaintext at
65492 bytes with the envelope inside it, so a sender cuts the body with the shared rule
(`partitionTunnelBody` in `@ferretry/protocol`: each part's JSON-escaped UTF-8 fits what the envelope
leaves, and no character is split) and marks every part but the last with `"more": true`:

```json
{ "t": "req", "id": 7, "method": "PUT", "path": "/v1/…", "body": "<part 1>", "more": true }
{ "t": "req-more", "id": 7, "body": "<part 2>", "more": true }
{ "t": "req-more", "id": 7, "body": "<last part>" }

{ "t": "res", "id": 7, "status": 200, "headers": { … }, "body": "<part 1>", "more": true }
{ "t": "res-more", "id": 7, "body": "<last part>" }
```

Parts of one body are consecutive in sequence order and are reassembled exactly; a `*-more` with no
open body, or a second start for an open one, is `4400`. A whole body is bounded at **32 MiB**: a
request over it is refused before any of it is sent (the client says so; a daemon receiving one
answers `413`), and an answer over it is the daemon's `502` with code `answer_too_large` — never a
truncated body, because a client that rendered half a session list would show a fleet that does not
exist. The daemon reassembles at most four request bodies per session at once. There is no
`oversize` record any more.

**A client's own queue never ends its session.** Everything waiting to leave a client is that
client's own: a surface that fires its reads in one tick queues them all before the first is even
sealed, so a queue deeper than one credit window says nothing about the daemon — the window has not
had a round trip to refill. The reference client used to end the session there, and every request on
it failed at once: first for a phone photo's eighty parts queued behind one another (the owner's batch
of 21 photos, 2026-10-29), then for a burst of whole reads — the inbox reading one agenda board per
session — reported to the owner as `4400` "too many records waiting on credit" and as a Cloudflare
tunnel that "was not reachable" (2026-10-30). So the reference client queues requests in order and
sends each as credit allows. What bounds the queue is admission: at most 256 whole requests wait
(`MAX_QUEUED_REQUESTS` in `packages/pwa/src/lib/relay-session.ts`), and the one past that is refused
**unsent** with a retryable error while every queued one keeps its place. A request whose caller gives
up before it leaves is withdrawn — parts and all — and is never sent; one that waits 30 s for credit is
withdrawn the same way. A daemon that has genuinely stopped returning credit is found by those
deadlines and by the callers' own, which retire the session; it is never inferred from depth. And
because one session is one queue, the reference client sends a body large enough to need parts on a
**second request session** of its own, so the reads every panel polls never wait behind an upload: a
poll that missed its deadline there would retire the session carrying the uploads. Nothing on the wire
changed; it is one more session per device.

**A daemon bounds its WHOLE answers, not their parts.** The reference daemon ends a session when more
than one credit window of whole answers is waiting for the browser's credit, because answers pile up
only behind a peer that has stopped reading. A large answer's later parts do not count: they were
bounded when the answer was cut, and counting them ended the session whenever any request finished
behind one answer of more parts than the window. A stream's payload is bounded by the stream's own
overflow policy (below), not by this rule.

Answers carry an `id` because the daemon replies in whatever order its own handlers finish. Sequence
numbers order the wire; they do not order the work.

**The daemon runs a session's requests side by side, at most 16 at once** (`MAX_CONCURRENT_REQUESTS`
in `packages/daemon/src/lib/relay/link.ts`). Records are still opened and parsed strictly in sequence
order — the receive counter advances inside that step — but a request's handler is not part of it, so
a slow route (a `git` call, a filesystem index) delays only its own answer, never the requests,
renewals and terminal keystrokes behind it on the same link. A whole request past the bound waits in
arrival order and **keeps the credit for its own record until it starts**: §8's credit is returned
for everything else as usual, so a client that keeps sending past the bound runs out of allowance
exactly as it would against a daemon that had stopped reading, while the other sessions on the link
keep moving. Parts of one answer still leave consecutively (above). A daemon that receives more
waiting requests than one window could have carried ends the session `4430`, which a rendezvous
would have done first; a direct socket has no rendezvous to count for it. Nothing on the wire
changed, so this is not a version: a client that sent one request at a time sees the same session.

### Stream sessions

The daemon's protocol-switching surfaces — `/v1/events`,
`/v1/sessions/:sessionId/terminals/:terminalId/stream` and `/v1/sessions/:sessionId/browser/stream`
(the remote-browser live view) — are sockets that keep talking, which one
request and one answer cannot carry. A stream session carries **exactly one of them**: the socket is
the session, so the session layer already owns the stream's ordering, its flow control, its teardown
and its cancellation, and nothing below this heading invents a second version of any of those.

The credential record opens the stream in the same breath:

```json
{
  "t": "stream",
  "protocol": "ferretry-relay/2",
  "deviceId": "fy_device_id_…",
  "appSession": "…",
  "proof": "<§6's device-auth signature with t = \"stream\">",
  "path": "/v1/events",
  "query": [
    ["sessionId", "fy_…"],
    ["after", "0"]
  ]
}
```

`path` and `query` follow the same rules as a `req`'s. A proof the daemon does not accept is `4403`
before any route is consulted — outside the channel, indistinguishable from a request session's
refusal. An accepted one is dispatched as a protocol switch against **the daemon's own socket route
table**: the same routes, the same authorization boundary and the same per-capability guard, with
this session's proven device as the caller. A stream one device may not open, it may not open on any
carrier, refused by the same code in the same place. Stream sessions hold a lease and renew it
exactly as request sessions do.

**There are no socket tickets, anywhere.** They existed so a browser — which cannot put a header on a
WebSocket — could authenticate an upgrade with a short-lived bearer value bought over HTTP. Every
stream is a session the device key opened now, on either carrier, so the daemon serves no ticket
route at all. `ticket` or `token` in a stream's `query` is refused with `4400`, for the reason
`authorization` is refused on a `req`: a stream carries exactly one credential, its session's proof.

The daemon answers with exactly one of, inside the channel:

```json
{ "t": "stream-opened", "protocol": "ferretry-relay/2", "accessExpiresAt": "<ISO-8601 instant>", "rotateBy": "<ISO-8601 instant>" }
{ "t": "stream-refused", "protocol": "ferretry-relay/2", "status": 404, "body": "…" }
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
bytes both ways and a JSON resize control from the client, and the browser stream carries frame
bytes from the daemon and one JSON input event per text record from the client.

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
- **terminal output** (daemon → client) is a picture of the pane rather than a byte stream from it —
  tmux offers a capture, not a delta feed — so the daemon sends the smallest frame that turns the
  viewer's screen into the latest capture: the rows that changed, or the lines that scrolled followed
  by the screen, and a **complete redraw** only when there is nothing it may safely be a delta against
  ("What a keystroke costs", below). A complete redraw keeps the newest history that fits the budget
  and leaves the oldest out, so it fits one record unless the visible screen alone does not; such a
  screen is **dropped** exactly as a backpressured redraw is (below). Before that cap, every redraw
  carried the capture limit's two thousand lines of history and was dropped whenever they were over
  the budget, so a terminal holding a few hundred lines of history was never painted again — over
  either carrier, since both carry the same session;
- a **browser frame** (daemon → client) is one JPEG with its page id in front, routinely larger than
  the budget, so the browser stream is a byte stream with its own framing: each frame is cut into
  self-delimiting `FYBC` chunks no larger than the budget — magic, version `1`, frame serial, whole
  length, offset, chunk length, then the bytes — defined once in `@ferretry/protocol`'s
  `browser-stream.ts` for both ends. A reader parses chunks out of the byte stream, never one per
  record, and reassembles a frame only from contiguous chunks of one serial. A chunk the stream dropped
  (below) leaves a hole at a chunk boundary: the reader discards that partial frame, and the daemon
  resends the newest picture whole under a new serial. A stream whose chunk headers stop making sense
  has lost its framing and is closed by the reader with `1003` — the route's repair is a fresh attach;
- **browser input** (client → daemon) is one JSON event per text record and never split; a client
  sends a long paste as several `insertText` events in order;
- an **event** frame is a unique record that may be neither dropped nor split, so an event that
  cannot fit one record **closes the stream** with `1009` — the honest refusal, like the `502` on
  a request session, rather than a truncated event a client would parse and believe.

#### Backpressure, and what a full buffer does

A stream's flow control **is** the session's credit window (§8). There is no second layer: a viewer
that stops returning credit stops the daemon's sending, and the daemon's un-credited backlog is the
number its overflow policy reads — the same buffered-bytes figure the direct transport reports, and
it must be reported honestly, because a stream layer that answered `0` would make every existing
backpressure policy vacuous over a relay. What a full buffer means is the stream's own contract, and
the two that exist differ on purpose:

- a **terminal** frame is a complete redraw or a delta against the picture the stream last
  **accepted**, and the next one supersedes it either way, so an overflowing frame is **dropped**, never
  queued without bound and never fatal. A pane unchanged since the last accepted frame sends nothing at
  all — an idle pane polled ten times a second used to cost ten identical records a second for as long
  as anyone watched — and a frame the stream dropped is followed by a complete redraw, because a delta
  is only ever computed against what the viewer was accepted to have. A stream reports a drop to its
  producer as `0` ("not taken"), the transport convention every producer in the daemon reads;
- a **browser** frame follows the same two rules — one identical to the last frame every chunk of
  which the stream accepted is not sent, and one with a dropped chunk is resent whole — and adds a
  third: a new frame starts only when the session has **no un-credited backlog at all**, so frames are
  paced by the credit the viewer returns and a slow link shows fewer, current frames rather than a
  queue of old ones. The daemon's screencast itself is JPEG at quality 50 at the page's viewport size,
  capped near 15 frames a second, so the credit window is the only throttle the relay path adds;
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
{ "t": "stream-close", "protocol": "ferretry-relay/2", "code": 1013, "reason": "event stream reader fell behind" }
```

followed by `4440`. `1000 terminal viewer disconnected`, `1008 event stream is server-only` (or `1008 this stream is no
longer allowed`, when a renewal or a grant change re-asks the socket table and it now refuses), `1009`
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

#### What a keystroke costs

A keystroke is one `bytes` record each way: the browser seals the key, the daemon writes it into the
pane, captures the pane and seals the change. Nothing here batches — the browser sends every key the
moment xterm hands it over and writes every arriving frame at once — so what a keystroke costs is the
carrier's round trip plus what the daemon spends between the two records. That second part is the
daemon's, and it is measured rather than estimated by `packages/pwa/harness/relay-terminal-bench.ts`:
the real `TerminalStreamBridge`, `ManagedTerminalService` and `TmuxTerminalRuntime` over a real tmux,
the real `BunRelayCarrier` and `DirectSession`, the real rendezvous (`scripts/test/rendezvous-process.ts`)
and the PWA's own `openRelaySession` and xterm.js in a real Chrome, timed from the key to the frame
that painted its echo. The network between them is a shaping proxy, and the numbers it is given are
printed with every result.

**What the daemon does with a keystroke.**

- **The echo is captured at once, not on a tick.** After the write reaches the pane the next captures
  follow at 0, 5, 15 and 40 ms, then the ordinary 100 ms poll resumes; a shell echoes within a
  millisecond, and a slower program (an editor repainting, a completion menu) is caught by a later
  rung. A single capture pulled forward to 15 ms used to spend those 15 ms waiting.
- **One tmux process per capture, and none per lookup.** A capture is `capture-pane` and
  `display-message` in ONE tmux invocation, and a stream's write and capture act on the terminal the
  service already knows instead of listing every tmux session first. Each of those was a process.
- **A poll reads 200 lines of history, not 2000.** Two hundred are enough to recognise what scrolled
  since the last frame; the whole capture limit is read only when a complete redraw is due.
- **Only the change is sent.** Against the last frame the stream ACCEPTED, the daemon sends the rows
  that changed — a typed character repaints one row, about 45 bytes — or, when output scrolled, the
  newly scrolled lines followed by the screen. A complete redraw is sent only when there is nothing to
  be a delta against: a fresh attach, a dropped frame, a resize to a size the viewer did not already
  have (a repeat of its current size leaves the picture it holds), a viewer whose emulator is not the
  pane's size (another viewer resized it), or a history that was cleared or rewritten rather than
  grown. Each row tmux captures sets its own colours and resets them at its end, which is what makes
  repainting one row alone correct. A delta's newly scrolled lines are trimmed to the record budget
  from the oldest, so the visible screen is always right and only the viewer's scrollback can show a
  gap where a burst of output scrolled further than one record holds.
- **A client holds a stream only while it is looking.** The PWA attaches a terminal only for the
  workspace tab on screen and only while the page is visible, and detaches (an explicit `stream-close`)
  otherwise; the remote-browser display does the same on page visibility. Scrollback stays in the
  emulator, and showing the tab again pays one complete redraw. A client also sends a resize only for a
  pane it can measure and never repeats the size it last sent on that stream.

**The rendezvous does not hold a frame behind a write** (§9, "Forwarding does not wait for the write").

**Measured,** on one machine, `bun harness/relay-terminal-bench.ts` from `packages/pwa`, 30 keystrokes
per case, p50 / p95 in milliseconds, before (`main` at `191a5634b`) and after this change. _WAN_ is
a phone away from home reaching a home daemon: a 60 ms round trip on both paths — direct is one 30 ms
leg, the relay a 20 ms leg (phone↔edge) and a 10 ms leg (edge↔home) — with a 10 Mbit/s home uplink.
_History_ is lines of about 125 bytes with their colours, the size of a log or a build's output.
_Gate_ is the modelled output gate: `--output-gate-ms 10` holds every send behind an ordinary write
for 10 ms; that number is a choice, not a measurement of Cloudflare.

| case                               |                             before |       after |
| ---------------------------------- | ---------------------------------: | ----------: |
| direct · loopback · fresh          |                        31.3 / 33.8 |  9.5 / 12.1 |
| direct · WAN · fresh               |                        92.9 / 96.0 | 72.2 / 75.0 |
| direct · WAN · 300 lines           |                      146.3 / 156.8 | 75.8 / 78.3 |
| relay · loopback · fresh · gate 10 |                        54.0 / 56.8 | 10.0 / 12.1 |
| relay · WAN · fresh · gate 0       |                       95.7 / 100.1 | 75.7 / 78.8 |
| relay · WAN · fresh · gate 10      |                      118.2 / 123.7 | 76.0 / 80.4 |
| relay · WAN · 300 lines · gate 10  |                      179.1 / 197.6 | 77.1 / 93.2 |
| relay · WAN · 1500 lines · gate 10 |                      never painted | 77.0 / 93.3 |
| bytes in one echo frame            | 103 B fresh, 36 949 B at 300 lines |     44–46 B |

So a relayed keystroke now comes back in the path's round trip plus about 16 ms, of which the
daemon's own part is under 10 ms (write 2.5, the first capture rung 1.1, the capture 2.3–4.0) and the
rest is two shaping proxies and the browser's paint. Before, a used terminal paid a whole history per
character — 37 KB at 300 lines, and at 1500 lines a redraw no record could carry, so nothing ever
reached the viewer, direct or relayed. The modelled 10 ms gate used to add 11 ms in each direction of
the relay hop; it now adds nothing measurable (the rendezvous's own forwarding is 0.2 ms each way).

**What was looked at and is not a cost:** per-keystroke round trips (input is one stream record, never
a request); Nagle-style buffering (no endpoint batches, and the loopback down-leg is 1 ms); the credit
window (one echo is one frame of thirty-two, and `seq 1 20000` paints its last line in two or three
frames); AES-GCM per record and the JSON-and-base64url envelope (both inside the 1–2 ms the loopback
up-leg measures, and the envelope's four-thirds is nothing on a 45-byte delta); heartbeat and claim
probes (one ping and one probe every 20 s); and duplicated subscriptions (the deck attaches only the
active terminal, as "What a stream session costs" says).

**What is not done, and why.**

- **No compression of a stream.** The relay sees every record's size, and compressing a terminal's output
  before sealing it would make those sizes depend on what is ON the screen — the compress-then-encrypt
  length side channel. Deltas get most of the byte saving without giving an observer that oracle. A
  request answer is a different case with a different answer: see "A compressed answer" in §14.
- **The capture is still a poll, and each write is still a tmux process** (about 2.3 ms each). A
  capture — like every other READ the daemon asks tmux — now travels over one long-lived control-mode
  client (`adapters/tmux/control-tmux-process.ts`), attached `ignore-size` so it takes no part in any
  window's size, and costs no process. A write keeps its own: a connection that drops mid-command
  cannot say whether tmux ran it, and a keystroke cannot be retried the way a read can. Reporting
  output as it happens needs more than that one client, because tmux sends `%output` only for panes
  in the session a client is attached to (measured on 3.6a) — a client per watched session. — GAP.
- **Cloudflare itself is not measured here.** The Workers runtime is substituted (`rendezvous-process.ts`
  says how), so how long Cloudflare takes to confirm a write, what a Durable Object waking from
  hibernation costs the first keystroke after a pause, and how far the object sits from both ends are
  not in these numbers. The object is placed where it was first created, which is near the daemon
  that claims it; a phone far from both pays that distance on every keystroke, and no code here can
  shorten it. — GAP.

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
The forbidden path authenticated the daemon; the permitted one never had. What was actually missing
was a session mode — an ordering rule in §6 remembered as a security property — and a session mode
is what this section adds.

**And it is now the ONLY redemption, on both carriers.** That comparison is why `POST /v1/pair` is
deleted rather than kept beside this: a direct redemption is the same `pair` record, in a pre-auth
session on the daemon's own address (§4), so the daemon is proved against the QR before the code
leaves the device on the LAN as well. A daemon receiving the old `POST /v1/pair` answers `426` with
the sentence that tells the app to update, never a `401` that reads as a wrong code.

**The exchange.** The credential record:

```json
{
  "t": "pair",
  "protocol": "ferretry-relay/2",
  "code": "XXXX-XXXX",
  "deviceName": "Ferretry PWA",
  "deviceKey": "<44-byte Ed25519 SPKI b64url>",
  "proof": "<§6's device-pair signature by that key>"
}
```

`code` and `deviceName` carry the pairing API's values, bounds and meaning; their formats belong to
that API, not to this protocol. `deviceKey` is the public half of a key the browser generated for
this daemon and cannot export, and `proof` shows it holds the private half for THIS session. A proof
that does not verify is treated exactly as a wrong code — it spends one attempt and is answered with
the same `pair-refused` — so the proof adds no oracle of its own. On `paired` the daemon stores the
SPKI under the grant it mints, and nothing else about the device's key. The record is domain-separated from
`auth` and from every other tunnel message by the one strict union — nothing can read it as
anything else — and it is legal **only** as the record at sequence `1`. The daemon answers with
exactly one sealed outcome:

```json
{ "t": "paired", "protocol": "ferretry-relay/2", "response": { "deviceId": "…", "daemonId": "…", "daemonName": "…", "capabilities": [], "carriers": [], "idleExpiryDays": 30 } }
{ "t": "pair-refused", "protocol": "ferretry-relay/2", "reason": "pairing_refused" }
```

and then ends the session with `4440`. One attempt per session, success or failure; there is no
second record, no retry on the same channel, and **no edge from a pairing session to serving**. A
device that paired reconnects as an ordinary request session, proving the key it just registered.

- **`paired.response` is the redemption response of the pairing API, verbatim** — validated by the
  pairing API's own `PairingResponseSchema`, `carriers` included. It is embedded whole rather
  than re-listed field by field, so the next field the pairing API adds crosses the relay the day it
  ships instead of being silently dropped by a copy of the list; and `carriers` crossing inside the
  sealed record is what a relay-paired device navigates by, so an envelope that lost it would mint a
  device that can reach its daemon by nothing at all, with no error anywhere.
- **The client latches the outcome before the close.** The `4440` after `paired` is expected
  teardown, not a failure that overwrites a pairing that succeeded; a `4440` with no sealed outcome
  before it is a protocol violation. Same rule as a stream's close, same reason.
- **Refusal is uniform on purpose.** One machine reason, `pairing_refused`, for every cause — no
  active code, a wrong code, an expired one, a spent budget, a body the schema refused, a proof that
  did not verify. A pre-auth surface the whole internet can reach must not be
  an oracle, which also forbids the cheaper oracle one layer down: a daemon must **not** refuse the
  session early when no code is active. It accepts, keys the channel, runs the same constant-time
  comparison against a dummy code, and refuses identically. An observer —
  relay operator included — cannot distinguish "no code exists" from "wrong guess", and success and
  refusal have the **same frame count**: one sealed record, then the same close.
- **Uniform is not indistinguishable, and the difference is stated rather than glossed.** The frame
  count, the close code and the refusal's own wording are uniform; the record **size** is not, and
  §3 pads nothing. `paired` embeds a whole redemption response and `pair-refused` embeds one machine
  reason, so a relay operator reading one length infers the outcome — not the code, not the key,
  not the device name, and not which refusal it was, but the outcome. §10 owns that disclosure. The
  uniformity above is what denies the **guesser** an oracle, which is the property this exchange
  needs; denying the **carrier** the outcome would take padding this version does not have.

**How it stays closed.** Three rules carry the security argument, and they are contract:

1. **It is a record, not a routed request.** The pairing branch invokes the daemon's pairing state
   machine directly and never constructs an `ApiRequest`: a pre-auth session issues no requests at
   all, so §14's invariant — a session's request carries exactly one credential, the proof its
   session was opened with — stays literally true, and no route is reachable pre-auth, `minimum:
'none'` routes included. The alternative — dispatching an anonymous request at a public route —
   would create the credential-less request path whose absence is the whole reason §14's invariant
   is easy to defend.
2. **Host credentials remain impossible.** The pairing branch reads no `authorization`, resolves no
   token, and never reaches the request path that attaches one; the session holds no credential,
   mints exactly one, and dies. A host admin token is not accepted here for the same reason it is
   not accepted at `auth`.
3. **Replay is already closed by §7.** The `pair` record is sealed under this session's keys with
   its sequence number as the nonce, and a fresh session has fresh keys — a captured record cannot
   be replayed into any other session. The code itself is single-use and consumed before any
   suspension point, so two concurrent redemptions cannot both win, and the minted grant id crosses
   once, sealed, in a record no relay can read. A captured `pair` record is worth nothing even to its
   author's peers: its proof is over THIS session's transcript.

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

**Two attempt budgets, because two carriers.** A direct pairing session's budget is the one the
deleted route had: five attempts per code, keyed by the listener's peer address for the fixed-window
limiter, and exhausting them expires the code. A relayed attempt spends a **separate relay budget**
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
opposite: the exchange happened, the answer is final for that attempt, and the remedy is one
sentence — the code is wrong, expired or spent; mint a fresh one. A client must keep the
two apart, and it can do so structurally: one arrives as a close outside the channel, the other as a
record inside it.

Minting is governed exactly as before: the `pairing` capability governs who may **mint**, redemption
is credentialed by the code itself on every carrier, and an operator who switches `pairing` off has
stopped new codes from existing — with nothing minted there is nothing to redeem, relayed or not.

**What a relay operator sees of a pairing** is §10's list, with the parts specific to this exchange
restated once: a pre-auth session for fingerprint X at time T from IP Y, a handshake, one sealed
record each way, a `4440` close — never the code, the key or the device name, and never the outcome
as anything it can read, but the sealed answer's SIZE infers the outcome and this document says so
rather than claiming the exchange is outcome-blind. "Fingerprint X
gained its first device at T, from Y" is a new operator-visible event that used to happen invisibly
on a LAN; this design accepts that disclosure as the price of a phone that can pair from anywhere,
and says so.

### Member sessions

**Status: served (catalogs phase 2b-2).** A daemon's sequence-1 union is `auth`, `stream`, `pair`,
`join` and `member`, on the direct carrier and the relay alike. The publisher half is built: the join
gate (`catalog-members/join.ts`), the member route table (`catalog-members/shared-routes.ts`, mounted
as `MemberDispatcher`), member passkeys and unlocks (`catalog-members/passkeys.ts`), and closing a revoked
member's live sessions. The browser half is phase 2c; the end-to-end test is 2d.

A catalog **member** is a person a publisher shared catalogs with ([catalogs.md](catalogs.md) § Members),
not a paired device. Their browser reaches the publisher through exactly the carriers a device uses —
direct first, then the discovered rendezvous — and proves itself the same way, by signing this session's
transcript with a key it made and cannot export. It adds two records to the sequence-1 union, each a
separate mode with its own terminal states, and **neither reaches a single route a device session
reaches**.

**The keys and their labels.** At join the browser makes a non-extractable Ed25519 **member key** for
this publisher, and an X25519 **box key** that phase 6 wraps artifact keys to. Every member signature
has a label of its own, so a member proof can never be presented as a device, pairing, handshake,
rendezvous or catalog signature, nor any of those as one:

```
join   = Ed25519(member key, "ferretry-member-join-v1"  ‖ 0x00 ‖ TH ‖ LP(memberKey) ‖ LP(boxKey))
member = Ed25519(member key, "ferretry-member-auth-v1"  ‖ 0x00 ‖ TH ‖ LP("member") ‖ LP(keyId) ‖ LP(appSession))
renew  = Ed25519(member key, "ferretry-member-renew-v1" ‖ 0x00 ‖ TH ‖ LP(nonce))
```

Fields enter as their base64url text, as §6's do. `@ferretry/relay`'s `member-session.ts` builds these
messages and parses both records; both ends use it.

**`join`: one redemption, then the session ends.**

```json
{
  "t": "join",
  "protocol": "ferretry-relay/2",
  "code": "fy_share_…",
  "clientName": "Firefox on a Mac",
  "memberKey": "<44-byte Ed25519 SPKI b64url>",
  "boxKey": "<32-byte X25519 public key b64url>",
  "proof": "<the join signature by memberKey>"
}
```

The publisher answers with exactly one sealed outcome and then `4440`, as a pairing session does:

```json
{ "t": "joined", "protocol": "ferretry-relay/2", "response": { "memberId": "mbr_…", "keyId": "mk_…", "label": "Alice", "daemonId": "fy_daemon_…", "daemonName": "kirin-box", "catalogCount": 1, "carriers": [], "passkeyWindowEndsAt": "…", "memberUnlockDays": 30 }, "pad": "   …" }
{ "t": "join-refused", "protocol": "ferretry-relay/2", "reason": "join_refused", "pad": "   …" }
```

- **Every rule of a pairing session holds, by name.** It is a record, never a routed request, so no
  route is reachable before a member key exists; it reads no host credential; one attempt per session,
  success or failure; **no edge to serving** — a browser that joined reconnects with `member`; the
  client latches the outcome before the close.
- **The outcome's SIZE says nothing; its timing and what follows still do.** Both outcomes are padded
  with spaces to exactly `MEMBER_JOIN_OUTCOME_BYTES` (24 KiB) of plaintext, which holds the largest `joined` a publisher
  can send (eight published carriers of 2 KiB addresses, a 100-character publisher name, an 80-character
  label) with room to spare, and fits one record. `padJoinOutcome` writes it; an outcome missing its `pad`
  field, or with anything but spaces in it, does not parse (the exact length is the sender's property, which a
  receiver may check on the record). That is also why `joined` names no catalog, only how
  many: the browser reads the names from `GET /v1/shared/me` once it has a passkey, and the publisher
  names the passkey itself. **The outcome is not hidden, and this document does not claim it is**: a
  successful join persists before it seals, so it answers later than most refusals, and a browser that
  joined opens a member session and registers a passkey over the same carrier seconds afterwards, while a
  refused one does not. A relay operator who watches can infer the outcome within seconds — never the
  code, the keys, the member's name or the catalogs. The pad removes the cheapest signal, the length of one
  record, and nothing more.
- **One refusal for every cause.** An unknown, spent, expired or ended code, a full publisher, the hourly
  count, a malformed field, a key that is not an Ed25519 SPKI, the all-zero box key and a proof that does
  not verify are all the same `join-refused`. A publisher with no live share still keys the channel and
  refuses identically, so no observer can tell "no code exists" from "wrong code".
- **The code.** 16 random bytes (128 bits of entropy), written as `fy_share_` and 22 base64url
  characters; the prefix lets a secret scanner recognise a leaked one. The publisher stores only the
  SHA-256 of the code's text, a fingerprint, never the code; a 128-bit value cannot be found from its
  hash by trying. It travels only inside this sealed record and in the link's fragment.
- **The order of the checks, which is contract:**
  1. **Everything that needs no state first**: every field against its schema, the member key, the box
     key, and the proof against this session's `TH`. These may suspend (a signature check is async); a
     failure here refuses and **spends nothing**, so a broken client never loses a code.
  2. Then **in one step with no suspension point**: find the share by the code's SHA-256 (compared in
     constant time against a dummy when nothing is live); check it is live; check room — the publisher's
     128 members and 512 keys, the member's own 200 keys, and this SHARE's hourly count of successful
     joins and redeems (60). **A refusal for room or the hourly count leaves the code live**, as a full pairing does.
     Then burn the code (single use) or count one use (multi use), and reserve the key's slot.
  3. Then **persist** the member and the key. Only after the write succeeds does the publisher seal
     `joined`. A write that fails refuses, and the code stays spent: the owner sees the share as used with
     no key behind it, and mints another.
     So two concurrent joins cannot both spend one code, and nothing a stranger sends can spend one at all.
- **`joined.response` is `MemberJoinedResponseSchema`, whole**, `carriers` included, for the reason
  `paired.response` is whole. It has no field for a key, a proof or a fingerprint.
- **As built.** The link seals the outcome through `padJoinOutcome`; an outcome that cannot be padded is the
  refusal, never an unpadded record. The session is `concluding` before the join is judged, so a second
  record is refused rather than racing a spent attempt, and the `4440` follows the sealed answer whatever
  it was. The per-peer budget counts FAILED joins only (10 a minute) and is keyed by the socket's client
  address on the direct carrier; a relayed or tunnelled join has no per-peer key. The publisher awaits the
  write of the burn before it seals ANY outcome, a refusal included, and commits or releases the
  reservation in a `finally`, so a failed write never leaves a slot held for its thirty-second lapse.
  A daemon whose member side is not bound yet refuses every join identically.
- **The browser keeps the key only after it reads `joined`.** An attempt whose answer never arrived is
  reported plainly; the owner's Members list shows the unused key, and it disappears on its own (below).
- **The passkey window.** A new key can do exactly one thing for ten minutes: register ONE passkey
  (zero-trust B2). More passkeys for that key are registered only from inside a member session that is
  already **unlocked** with an earlier one, never on the key alone. A key that registered no passkey when
  its window closes is **removed** — it could never do anything — so keys pressed through a leaked
  multi-use code drain on their own instead of filling the publisher.
- **Budgets stop floods; a stranger can at most delay the real recipient, never refuse them.** A code
  cannot be guessed, so unlike pairing's five-per-code budget, **no failed attempt is counted against a
  code or a share**: nothing a stranger sends can spend, expire or lock somebody else's code. The hourly
  count is of successful joins, which need a live code, and it is **per share**, so a leaked multi-use code
  spends only its own share's hour, never another invitee's. What a leaked code CAN fill is shared room:
  its member's 200 keys, and with three such leaks the publisher's 512. Keys that never register a passkey
  drain when their ten-minute windows close; keys that register a throwaway passkey stay until the owner
  ends that share and revokes its member, which is one press each. Until then a further join is refused
  for room and its code stays live. Failed attempts are bounded by the
  carrier alone: 10 a minute per peer address on the direct carrier. **On the relay there is no per-peer
  limit worth the name** — every relayed attempt is its own rendezvous session, one attempt each — so
  relayed attempts are priced only by the rendezvous admission (30 a minute) and this section's 6
  pre-credential slots. The residual is the one stated for every pre-credential session: a relayed flood
  can occupy the rendezvous's shared admission and slots and DELAY a relayed recipient (who retries
  `4429`), never refuse them, and the direct carrier is untouched. A transport failure spends nothing; a
  sealed `join-refused` is final for that attempt.

**`member`: a request session on the member route table.**

```json
{
  "t": "member",
  "protocol": "ferretry-relay/2",
  "keyId": "mk_…",
  "appSession": "<16 bytes b64url>",
  "proof": "<the member signature>"
}
```

- The publisher verifies the proof against the member key it filed at join. Unknown key, revoked key,
  idle-expired key and bad proof are **one** refusal, `4403`, as for a device. (Phase 5 adds a sealed
  `member-revoked` answered only to a holder whose proof verifies; until then a revoked key gets `4403`.)
- **`4403` is a cleartext close a relay can forge, so a browser never deletes a member key on it.** It
  marks the key refused, says so, and keeps it — exactly as a paired device keeps its key on `4403` —
  until the person chooses to join again or to forget it, or a SEALED `member-revoked` arrives (phase 5).
  Joining again with a new code makes a NEW key; the refused one is never discarded silently.
- **As built.** An unknown id is verified against a dummy key, so a bad id costs what a known one does. The
  session is registered with the publisher's live-member registry only after the proof holds, and
  registering re-reads the key, so a revoke landing between the proof and the registration still refuses
  it. A revoke, a removed browser, an ended member or a deleted catalog ends the member's live sessions
  with the same `4403` ("unknown device credential") an unknown key gets, so the carrier cannot tell a
  revoke from a wrong key. `lastSeenAt` is recorded when a session opens.
- Accepted, it answers `authenticated { accessExpiresAt }` and the session becomes a request session
  with a device session's lease, `renew` and close rules — the renew answered with the `member-renew`
  signature — on a **separate route table**: `/v1/shared/*` and nothing else. The dispatcher hands a
  member session to that table and to no other, so a route added tomorrow to the main table with a
  forgotten capability is still unreachable to a member. Its requests carry a member principal that
  meets **no** credential minimum of the main table (`authenticated`, `operator`, `admin-token`), and
  a test sweeps the main table to prove it.
- **The member route table, as built** (`/v1/shared/*`, nine routes, no other):

  | Route                                                          | Needs                                                       |
  | -------------------------------------------------------------- | ----------------------------------------------------------- |
  | `POST /v1/shared/passkeys/options`, `POST /v1/shared/passkeys` | the key; inside its window with no passkey yet, or unlocked |
  | `POST /v1/shared/unlock/options`, `POST /v1/shared/unlock`     | the key (and a registered passkey)                          |
  | `GET /v1/shared/me`                                            | unlocked                                                    |
  | `GET /v1/shared/catalogs/:catalogId/manifest`                  | unlocked; `ETag` is the revision, `304` on a match          |
  | `GET /v1/shared/catalogs/:catalogId/items/:itemId/:version`    | unlocked                                                    |
  | `POST /v1/shared/redeem`                                       | unlocked                                                    |
  | `DELETE /v1/shared/me/keys/self`                               | unlocked (a browser leaving)                                |

  Every request re-reads the member's current grants before its handler runs; a key that is gone, or whose
  member changed, is one `401`. A locked session asking for an unlocked route gets `403 member_locked`.
  A catalog the member is not granted is a `404 catalog_unknown`, identical to one that does not exist.
  Answers are `Cache-Control: no-store`. The main dispatcher refuses any request that carries a member
  principal with `403` before it looks at a route, and the sweep test (`surface.test.ts`) walks every
  route of the main table to prove a member is refused by each, and that no device credential is ever
  accepted by `/v1/shared/*`.

- A member session that has not unlocked with its member passkey reaches only `/v1/shared/unlock*` and,
  inside the key's window only, `/v1/shared/passkeys*` (the one-passkey rule above). Everything else —
  `GET /v1/shared/me` included, so a key-only holder never reads the member's name or catalogs — needs
  the unlock. One unlock lasts the member unlock period (30 days by default, 1 to 90), not the 8 hours of
  a device unlock, because a member only reads.
- **Every member request re-checks the member's catalog grants**, so a revoke is effective for the very
  next request, and revoking closes the member's live sessions at once — write first, then drop the
  grant, then close, as device revocation does.

**A browser already a member that opens another code** opens a `member` session and spends the code with
`POST /v1/shared/redeem` inside it (design §2.3), under the same order and the same hourly count as a
join. The rules, said once:

- A **single-use** code is burned whatever happens next, then compared: minted for this member, it adds
  any catalogs it grants; minted for a different member or for a new one, it is refused and the owner is
  told (owner decision Q5).
- A **multi-use** code counts a use only when the redeem succeeds and adds a catalog. Reopening a
  workshop link this browser already joined adds nothing and spends nothing; a browser of a different
  member is refused and spends nothing, because the code was never single use.
- **Q5 holds only for a browser that uses `redeem`.** A `join` carries a fresh key that links to no
  member, so a browser that chooses to join instead of redeem — or a person in a second browser profile —
  becomes whichever member the code names. That is not a leak (the code was a credential for that member
  either way), and the owner's Members list shows each browser under its member.

**Reserved, not part of this union yet:** `guest`, a session bound to one public catalog with no key at
all (design §2.8, phase 4), and the sealed `member-revoked` (phase 5). A record with either `t` today is
an unknown `t` and ends the session with `4400`.

**What a relay operator sees of a member** is §10's list: a pre-auth session for fingerprint X at time T
from IP Y, a handshake, sealed records, a close. It sees **that** a join or a member session happened,
because the pre-auth slot timing and the record sizes differ from a device's, and never the code, the
keys, the member's name, the catalogs or any content. Whether a join succeeded it can infer from timing
and the session that follows, as said above.

### What this tunnel does not carry

**A second credential, on any session.** `authorization` on a request, `ticket` or `token` on a
stream, a host admin token anywhere — every path by which a caller could present authority beyond
the credential that opened its session is refused by schema, and the pairing session carries the
inverse guarantee: it presents no stored credential at all and can never reach a route.

**A loopback peer, over a relay.** A relayed arrival is never local, whatever address the socket
appears to come from — the rendezvous terminates on the host it serves, and everything a daemon grants
a loopback caller is unreachable through a relay by construction. A direct session is local exactly
when its upgrade arrived on loopback, as the listener decided before any record was read.

**This list no longer excludes dictation.** The daemon's byte-shaped speech routes — an audio upload
and a multi-megabyte model download — are deleted, because recognition now happens in the browser.
The only speech-to-text request a daemon answers is `POST /v1/stt/enhance`: an already-transcribed
transcript in, a repaired transcript out, ordinary JSON both ways, which this tunnel carries like any
other request/response route. No microphone audio crosses this tunnel, and none crosses the daemon
boundary at all. The dictation hook hands it the session-routed fetcher, so it is reachable on
either carrier.

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

---

## 15. The tunnel carrier, and the carrier choice

Two owner decisions (2026-10-21) changed what §1 used to forbid: "can we choose between WebRTC,
relay and Cloudflare tunnel? make it a choice … make the default WebRTC … can I give multiple
Cloudflare accounts so multiple tunnels are possible?" This section is the contract for both the
**hosted tunnel carrier** and the **per-device choice** among carriers. The end-to-end session is
untouched by either: every carrier below runs §6's handshake against the fingerprint pairing pinned,
and §7's records, and nothing a carrier operator holds can read, alter or insert into it.

### The four carriers

| Carrier    | What carries the bytes                                                                                 | Who can observe metadata                                       |
| ---------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| **Direct** | A WebSocket straight to the daemon's own listener (§4).                                                | The networks in between.                                       |
| **WebRTC** | A peer-to-peer data channel, introduced over an authenticated session (§16).                           | The networks in between, and the STUN server learns both IPs.  |
| **Tunnel** | Cloudflare's edge, to a `cloudflared` connector the daemon runs, to a loopback listener on the daemon. | Ferretry (who provisioned it) and Cloudflare, as listed below. |
| **Relay**  | A rendezvous Durable Object passing opaque frames (§§5–9, §13).                                        | The relay operator and Cloudflare, as §10 lists.               |

### The choice

**A connection preference is per device and per machine**, chosen in the PWA's Settings › This
device and in the Connection status popover, and stored in that browser keyed by the daemon's
fingerprint. **Relay is the default**: a machine with no stored choice is walked as Relay only, and Auto is a value a person has to pick (so it is stored, where Relay is stored as nothing). A device that held the earlier Auto-by-absence default moves to Relay on its first read of the current storage key; a deliberate WebRTC-only or Tunnel-only choice is carried forward as it was. It is never sent to the daemon and the daemon never reads one: the daemon still
publishes the carriers it holds (§13), and the preference decides only which of them this browser
walks, and in what order.

| Preference      | Walk                                        | Notes                                                                                                                                                                                                                                                                                  |
| --------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Auto**        | direct → WebRTC → tunnel → relay            | Chosen, never the default. Direct stays first because it has the fewest parties; WebRTC is the first remote carrier. A tunnel is tried only when the daemon published one. A WebRTC attempt costs about 0.4 s when it works and is bounded by its ICE deadline when it does not (§16). |
| **WebRTC only** | WebRTC                                      | The relay (or direct) session is still used to **introduce** the two ends — signalling only, never the session's bytes.                                                                                                                                                                |
| **Tunnel only** | tunnel                                      | Dials the tunnel this device kept; when there is none, or it does not carry, asks the daemon where it is (below). Says "not set up by the operator" when the hosted service advertises `available: false`, and "this machine has no tunnel yet" when the daemon still names none.      |
| **Relay only**  | relay (published, then the hosted fallback) | **The default** for every device and machine that has not chosen — exactly the pre-choice relay behaviour.                                                                                                                                                                             |

The walk's rules from §13 are unchanged inside each preference: the carrier is chosen by **trying**
it, only a transport failure from a replay-safe request advances, a winner is remembered for the
life of the connection, and a surface always names the live carrier and why the others were passed
over. A preference that leaves nothing to try is a stated failure — "Tunnel only: this machine has no
tunnel yet" — never a silent fall back to a carrier the person excluded.

**Pairing ignores the preference.** First contact is direct, then the hosted relay (§14), whatever is
chosen: WebRTC needs a device key to signal and a tunnel is published only to a paired device.

**A tunnel is opt-in per machine, so choosing one offers it.** A daemon runs a tunnel only when its
operator or a paired device switched one on (`GET`/`PUT /v1/tunnel`, "The daemon end"). Choosing Tunnel
only — or Auto, which walks a tunnel too — for a machine whose switch is off asks, under the choice,
"Turn on a Cloudflare tunnel for this machine?"; the choice itself is kept either way, and Tunnel only's
note says "Off for this machine — tunnels are opt-in." — as does the walk's stated failure, "Tunnel only:
this machine's tunnel is off (opt-in)", ahead of the service's two reasons. The Connection status shows the daemon's own line
about its tunnel ("Tunnel: off (opt-in) — …"). **Switching is carrier control, not a walk**: `GET` and
`PUT /v1/tunnel` ride the daemon's direct address or a rendezvous — the introducers, with the hosted
relay when the daemon authored none — whatever the preference, and never the tunnel or WebRTC, because
under Tunnel only with the switch off nothing the preference allows could carry the request that turns
it on, and switching a tunnel off over itself would end the connection carrying the answer. It remembers
no winner, and a passkey it needs is asked for exactly as for any press. A daemon older than the switch
answers `404`, and its tunnel was never opt-in, so nothing is offered.

**A device keeps the tunnel it was told, and asks the daemon when that is not enough.** The tunnel is
learned the way every carrier is — from the daemon's published set, at pairing and on each
`GET /v1/carriers` refresh — and kept with the pairing in the device's own storage, so a reload or an
installed app the phone woke up dials it at once. Three rules make that safe under "Tunnel only", where
the tunnel is the only carrier the person allowed and so the only thing that could ever teach the
device a new one:

1. **A kept tunnel is dialled before anything is asked.** A connect never waits on a lookup while there
   is an address to try.
2. **A refresh that names no tunnel does not erase the kept one.** The daemon publishes its tunnel only
   while `cloudflared` holds an edge connection, so a set read during a reconnect means "not right now",
   not "gone". The kept hostname is replaced when the daemon publishes a different one; a read that
   fails changes nothing. What tells the two apart is the daemon's switch: a device holding a tunnel the
   set no longer names asks `GET /v1/tunnel`, and forgets the tunnel when the answer is `off` or
   `unavailable` (it keeps one that is `up`, and leaves one that is `provisioning` or `connecting`).
3. **When there is no tunnel to dial, or the kept one does not carry, the daemon is asked** — one
   `GET /v1/carriers` over its direct address or a rendezvous (the carriers that already introduce
   WebRTC, §16, with the hosted relay when the daemon authored none), inside an ordinary
   device-authenticated session. The answer is the daemon's own, end to end: no relay operator can put a
   hostname in it, which is why the device asks the daemon rather than a hosted lookup keyed by
   fingerprint (that lookup would also be the very link between hostname and daemon this section keeps
   out of DNS and certificate logs). A tunnel it names is dialled straight away and kept. The person's
   own requests never ride the introducer, exactly as WebRTC signalling does not carry a session's bytes,
   and a lookup's answer stands for 30 s, so an outage does not turn every panel's retry into a question
   over the relay. Only when the daemon names no tunnel either does the walk end with the stated
   failure.

### The hosted tunnel service

The hosted relay's Worker (§13) also serves a tunnel **provisioner**. It holds a **pool** of
Cloudflare accounts — operator configuration, never the repository — and gives each daemon that asks
one tunnel on one account with room, recorded in a control Durable Object (`TUNNEL_CONTROL`,
separate from the relay meter). The wire contract is `packages/relay/src/lib/tunnel.ts`.

**Discovery.** `GET <hosted origin>/v1/tunnel-service`, `Cache-Control: no-store`:

```
{ "version": 1, "available": true }
```

`available` is `true` when the pool parses and at least one account is accepting and has not failed
its zone check (below). Capacity is not consulted: a full pool is still set up, and says so at
provision time. `false` is "not set up by the operator", not an error, and a read that fails is
treated the same way — a deployment without the `TUNNEL_CONTROL` binding answers `false` too. The origin is the one the
relay advertisement is read from (§13 piece 1), so no tunnel address is compiled in either.

**Provisioning.** Two calls, both JSON over HTTPS from the daemon:

```
POST /v1/tunnel/challenge   { "daemonId": "fy_daemon_…" }
  → { "version": 1, "nonce": <32 bytes b64url>, "deadlineSeconds": 60 }

POST /v1/tunnel/provision   { "daemonId", "publicKey": <SPKI b64url>, "nonce", "signature", "originPort": 41234 }
  → { "version": 1, "tunnelUrl": "https://<label>.<zone>", "connectorToken": "…", "renewAfterSeconds": 86400 }
```

The signature is the daemon identity's Ed25519 signature over

```
"ferretry-tunnel-provision-v1" ‖ LP("ferretry-tunnel/1") ‖ LP(daemonId) ‖ LP(host) ‖ LP(nonce) ‖ LP(originPort as decimal)
```

with `LP` as in §5. The service accepts only when the key hashes to the fingerprint, the nonce is one
it issued for that fingerprint less than `deadlineSeconds` ago and has not been spent, and the
signature verifies over the transcript it rebuilds from **its own** host — the host of the URL the
Worker is serving, never a value the request supplies. A nonce is spent by its first use, accepted or
not. `POST /v1/tunnel/release` takes the same signed fields without `originPort`, under the label
`ferretry-tunnel-release-v1`, and deletes the daemon's tunnel — what a daemon does when its operator
switches the carrier off:

```
POST /v1/tunnel/release     { "daemonId", "publicKey", "nonce", "signature" }
  → { "version": 1, "released": true }      // false: this daemon held no tunnel — idempotent, not an error
```

The answer does not wait on Cloudflare. The tunnel is taken off the daemon at once and deleted
upstream in the same request when Cloudflare cooperates; a step that fails is left to the reclaim
below, so a daemon never retries a release. **A daemon refuses to sign a host it did not discover**,
exactly as for a rendezvous claim.

Challenges are bounded because hosted mode has no allowlist and asking for one proves nothing yet: at
most **3 unspent nonces per daemon**, **6 issued per daemon per minute** and **512 issued by the whole
service per minute**. Past any of them the answer is `tunnel_rate_limited`. A challenge is refused
`tunnel_unavailable` while the pool does not parse, so an unconfigured service stores nothing.

Provisioning is **idempotent**: a daemon that already has a tunnel gets the same hostname back, its
`lastSeenAt` is stamped (that is the renewal), and the ingress is rewritten only when the port
changed. A daemon renews every `renewAfterSeconds` while it runs and on every boot.

Refusals are `{ "error": { "code", "message" } }`: `tunnel_unavailable` (503, no accepting account),
`tunnel_capacity` (503, every accepting account is at `maxTunnels`), `tunnel_claim_rejected` (401),
`tunnel_challenge_expired` (401), `tunnel_rate_limited` (429), `tunnel_upstream_failed` (502, the
Cloudflare API failed — retried by the daemon with backoff), and `tunnel_bad_request` (400).

**What the service does on Cloudflare**, per account, with that account's API token (Account ›
Cloudflare Tunnel: Edit, Zone › DNS: Edit and Zone › Zone: Read on that zone):

1. `POST /accounts/{account}/cfd_tunnel` `{ name: "fy-<label>", config_src: "cloudflare" }` — a
   remotely managed tunnel; its `id` is kept. **The connector token is never stored**: every
   provision, new or renewal, reads it with `GET /accounts/{account}/cfd_tunnel/{id}/token` and hands
   it straight to the daemon, so the control object holds no credential a storage read could leak.
2. `PUT /accounts/{account}/cfd_tunnel/{id}/configurations` with the ingress `tunnelIngress` builds:
   the one rule `hostname: <label>.<zone>`, `path: ^/v1/rendezvous/<daemonId>/client$`,
   `service: http://127.0.0.1:<originPort>`, then `http_status:404` for everything else.
3. `POST /zones/{zone}/dns_records` `{ type: "CNAME", proxied: true, name: <label>.<zone>, content: <id>.cfargotunnel.com }`.

The hostname is **one random label** under the account's zone — never derived from the fingerprint,
so DNS and certificate logs do not link a hostname to a daemon — and one label deep because Universal
SSL's wildcard covers exactly that. The zone **must be in the same Cloudflare account as the tunnel**:
Cloudflare documents that `cfargotunnel.com` "only proxies traffic for DNS records in the same
Cloudflare account", which is why the pool is a list of (account, token, zone) triples rather than
accounts and zones chosen separately. The service checks `GET /zones/{zone}` answers that account and
that zone name before it places a tunnel there, and reports an account that does not as
misconfigured instead of using it. A verdict is cached against the (account, zone id, zone) triple it
checked: a pass for a day, a failure for an hour, so an operator who fixes a zone is not locked out
until the pool changes. A zone check that could not reach Cloudflare is no verdict — the walk moves on
to the next account, and answers `tunnel_upstream_failed` only if no account took the tunnel.

**A row before every call.** The control object writes the tunnel's row — daemon, account, label,
hostname, port — **before** it asks Cloudflare for anything, and writes each step's result (tunnel
id, ingress port, DNS record id) before it starts the next. A step that fails answers
`tunnel_upstream_failed` and leaves the row saying exactly what exists; the daemon's retry resumes from
it. A create whose answer was lost — committed upstream, never recorded — is found again by name:
before creating, the service looks for a live tunnel named `fy-<label>` and a CNAME named
`<label>.<zone>` and adopts what it finds. No sequence of failures leaves a tunnel nobody records.
Requests are served one at a time, so two racing provisions for one daemon make one tunnel.

**Capacity.** Cloudflare allows 1,000 `cloudflared` tunnels per account by default (raisable only on
Enterprise). An account's `maxTunnels` defaults to that and may be set lower, never higher. A new
tunnel goes to the **first accepting account, in the pool's declared order, with room** — the
operator's order is the preference, as a daemon's carrier order is (§13). An account with
`accepting: false` is **draining**: it takes no new tunnels and keeps renewing and reclaiming the ones
it holds, which is how an account is retired without stranding tunnels nobody can delete.

**Reclaim.** A tunnel whose `lastSeenAt` is older than `reclaimAfterDays` (default 30, operator
configuration) is deleted by the control object's daily alarm: its connections are cleaned up
(`DELETE …/cfd_tunnel/{id}/connections`), the tunnel is deleted, and its DNS record is deleted — a
tunnel's deletion does not remove its record. A step that fails is retried on the next alarm and the
row is kept until every step has succeeded, so a half-deleted tunnel never loses the evidence needed
to finish deleting it. A daemon that comes back after a reclaim provisions a new tunnel with a new
hostname, and its devices learn it from the next `GET /v1/carriers` refresh — a "Tunnel only" device
from the lookup its failed dial of the old hostname starts ("The choice", above).

A tunnel whose provisioning never finished is reclaimed after **one day**, not `reclaimAfterDays`:
it serves nobody and still counts against its account. A reclaimed or released tunnel is first
**retired** — taken off its daemon, kept as a row until its deletion finishes, still counted against
its account — so a daemon can get a new tunnel while the old one is deleted. One alarm pass attempts
at most 8 deletions (each is up to five Cloudflare calls, and an alarm on the Workers Free plan may
make fifty subrequests) and comes back a minute later when more remain. `reclaimAfterDays` (1–365) is
set with `PUT /v1/operator/tunnels` `{ "reclaimAfterDays": 7 }`, or the `tunnels` operation of the
hosted workflow.

**An account removed from the pool** leaves its rows behind with no token that could delete them.
They are reported as `orphaned` and never retried; a daemon whose tunnel was on it is given a new one
elsewhere at its next renewal, and its old row is retired. If the account comes back to the pool, its
rows are renewed or reclaimed like any other. A pool that does not parse orphans every row the same
way, so a broken secret can never trigger a deletion.

**The operator's view.** `GET /v1/operator/tunnels`, behind the same bearer as `/v1/operator/*`,
answers each account's name, zone, `accepting`, `maxTunnels`, live tunnel count and zone check
(`passed`, `failed` or `unchecked`); the pool's state (`absent`, `invalid` with the reason, or
`ready`); the settings; orphaned rows per removed account; deletions still pending; and rows that
would not parse — and never a token, an account's API token or a connector token.

### The pool is configuration, never the repository

The pool is the Worker secret `TUNNEL_ACCOUNTS`: a JSON array of `TunnelAccountSchema`
(`name`, `accountId`, `apiToken`, `zoneId`, `zone`, `maxTunnels`, `accepting`). Its source of truth
is the GitHub Actions secret `HOSTED_TUNNEL_ACCOUNTS`; a deploy that publishes installs it when it is
set, and the `tunnel-accounts` operation of `.github/workflows/relay-hosted.yaml` reinstalls it
without a deploy. A deploy's secrets are **additive** — an unset `HOSTED_TUNNEL_ACCOUNTS` leaves the
Worker's pool as it was — and installing a secret publishes a new Worker version, which drops live
sessions exactly as a deploy does. The value only ever travels through environment variables and
stdin: never an argument vector, a file in the repository or a log line, which
`scripts/validate/relay-config.sh` checks. A pool that does not parse is **no pool** — the service
advertises `available: false` and logs why, by issue path and code and never by value — rather than a
partial one. The operator runbook is
[`cloudflare-tunnel-pool.md`](cloudflare-tunnel-pool.md).

### The daemon end

- **The carrier entry, and the tunnel is opt-in.** The daemon's `carriers` list (§13) gains
  `{ "kind": "tunnel", "source": "discovery" }`. A list that declares no tunnel implies it **switched
  off** — unlike the hosted relay entry, because a tunnel puts a public hostname on a third party's edge
  in front of one machine, which is its owner's decision, never an update's. An explicit entry with no
  `enabled` key is on (writing it is the decision); `"enabled": false` is off, and a daemon that held a
  tunnel then releases it. At most one tunnel. **Migration:** a daemon updated from the implied-on
  release, whose document names no tunnel, releases the tunnel it holds on its first boot and says
  `tunnel carrier off (opt-in) — released <url>; turn on with fy daemon tunnel on`.
- **Switching it, live.** `GET /v1/tunnel` (`authenticated`, no capability) answers
  `TunnelStatusView` — `enabled`, `explicit`, `state` (`off` · `unavailable` · `provisioning` ·
  `connecting` · `up`), `tunnelUrl` and one `sentence`; off by default it is
  `Tunnel: off (opt-in) — turn on with fy daemon tunnel on or Settings › Connection`. `PUT /v1/tunnel`
  with `{ "enabled": true | false }` (`pairing.configure`, so a remote caller needs a step-up — see
  [grants.md](grants.md#turning-the-tunnel-on-or-off)) writes exactly that one entry into the document
  the daemon booted from, under the barrier grant and pricing writes hold, and applies it **without a
  restart**: on starts a new carrier; off withdraws the published tunnel, stops `cloudflared`, closes the
  dedicated listener and releases the tunnel, and answers only once the release has. Changes are
  serialised. A document with no `carriers` key gains one holding only the tunnel, which supersedes no
  legacy `host`, `port` or `relay` key. `fy daemon tunnel on|off|status` is the host's door to the
  same route, and `fy daemon status` prints its sentence. The contract is
  `packages/protocol/src/lib/tunnel.ts`.
- **`cloudflared` is a dependency, not a download.** The Nix package names the store's own binary
  through `FY_CLOUDFLARED` (a `--set-default` wrapper, so an operator's own value wins and agents'
  `PATH` is untouched); the Homebrew cask depends on the `cloudflared` formula; the deb and rpm
  packages _recommend_ it (neither distribution ships it by default); a standalone install requires it
  on `PATH` or at `FY_CLOUDFLARED`. `FY_CLOUDFLARED` wins and does not fall back to `PATH` when it
  names nothing runnable. Ferretry never fetches a binary itself. Without one the carrier is off, and
  `fyd --check` and the boot trail say so with the remedy, in one line. The service is asked only
  when there is a `cloudflared` to run, so a daemon without one makes no tunnel request at all.
- **The connector token stays in memory.** The daemon passes it to `cloudflared tunnel
--no-autoupdate run --protocol quic` through the child's `TUNNEL_TOKEN` environment variable — never
  an argument (argument vectors are world-readable in a process list), never a log line, never a
  file. `cloudflared` is supervised: restarted with backoff when it exits, stopped with the daemon.
- **A dedicated listener, and every arrival on it is remote.** `cloudflared` forwards from the
  daemon's own host, so an arrival through it comes from a loopback peer. The tunnel therefore never
  points at the daemon's API listener: the daemon binds a **second** listener on `127.0.0.1`, on an
  ephemeral port (the `originPort` it provisions with), that serves **only**
  `GET /v1/rendezvous/<its daemonId>/client` and answers `404` to everything else, and that stamps every
  arrival `loopback: false` and not privileged — the relay rule (§14, "What this tunnel does not
  carry"), for the same reason. The per-peer bounds of §4 key a tunnel arrival by its
  `CF-Connecting-IP` — an IPv4 address whole, an IPv6 address by its **/64**, because one subscriber is
  routinely given a whole /64 and per-address buckets would bound nobody — falling back to one shared
  key when it is absent or not an address. The route
  is its **own instance** of the direct carrier's, so tunnel arrivals are admitted against their own
  bounds rather than sharing a budget with the network's; any other method on that path is the same
  `404` as any other path, so the port does not reveal which path it serves. That `404` is answered
  before CORS is consulted, so a preflight or a foreign `Origin` on any other path is the same `404`
  too; only the session upgrade itself is held to the browser origins the API listener admits.
  **A pairing session is refused on the tunnel listener**: the session's arrival carries the tunnel
  marker, and its `pair` record gets the ordinary uniform `pair-refused` and close without the pairing
  service being asked — no guess is spent from the code's direct budget, and no grant can be recorded
  (or announced to the other devices) as paired on the local network.
- **Provisioning runs behind the boot, never in front of it.** The listener is bound and the first
  provision is made after the bind and the relays; a slow or absent service never holds a boot up,
  and nothing about the tunnel can fail one. A failure that may clear (`5xx`, `tunnel_unavailable`,
  `tunnel_capacity`, `tunnel_upstream_failed`, `tunnel_rate_limited`, `tunnel_challenge_expired`, no
  answer) is retried with equal-jitter backoff from 5 s to ten minutes, each retry stated with its wait;
  `tunnel_claim_rejected` and `tunnel_bad_request` turn the carrier off for the boot. Each attempt
  asks for exactly one challenge. Neither the advertisement read nor a provisioning call follows a
  redirect (`redirect: 'error'`): a redirect would hand the signed body, or the answer carrying the
  connector token, to a host the daemon never discovered. A renewal answers the token every time (the service re-fetches it);
  the connector is restarted only when it **changed**, and a changed hostname is withdrawn and
  republished once the new connector registers.
- **What is on disk is that a tunnel is held, never how to run one.** After a provision the daemon
  writes `state/tunnel.json` — `{ version, origin, tunnelUrl }`, owner-only — so a later boot whose
  operator switched the entry off knows there is a tunnel to release, signed by the identity key the
  token's boot shared. A release is asked once per boot and only of the origin the record names when
  that is the origin this build discovers; `{ released: false }` (nothing held any more) forgets the
  record exactly like `true`. A boot that could not get an answer keeps the record and asks once more
  on the next boot. Switching the entry off through `PUT /v1/tunnel` releases at once; an entry
  edited by hand in the file takes effect, and releases, on the next start.
- **What the daemon logs about each tunnel session.** A tunnel that stays registered while a phone
  "keeps reconnecting" is a per-session fact, so every session the tunnel listener carries logs one
  `tunnel session opened` line and one `tunnel session closed` line: who ended it (the browser side, or
  this daemon), the close code with what it means and the reason quoted on one line, how long it
  lived, how long before the end the last client frame arrived (a `fy-ping` counts), the bytes each
  way, and whether a device proved itself on it. A peer that vanished is `1006`; the reason a peer sends
  is cut to one printable line so it cannot forge a second log line. No address, device or key is in
  either line (`packages/daemon/src/lib/tunnel/session-log.ts`). Sessions on the direct listener are
  not logged.
- **`cloudflared` supervision.** Restarted 1 s after it exits, doubling to one minute with equal jitter,
  the backoff starting over once a connection registers; registration is the set of
  `Registered tunnel connection connIndex=N` lines minus `Unregistered …`, so one of four edge
  connections dropping is not a withdrawal. A child asked to stop gets `SIGTERM`, then `SIGKILL` after
  five seconds. A token change kills the old child and starts the new one only once the old has gone.
  The child inherits an **allowlist** of the daemon's environment — `PATH`, `HOME`, `TMPDIR`, `TZ`,
  `SSL_CERT_FILE`, `SSL_CERT_DIR`, `NIX_SSL_CERT_FILE` — plus `TUNNEL_TOKEN`, so no daemon secret
  reaches a third-party binary and no stray `TUNNEL_*` variable (which `cloudflared` reads as a flag)
  changes how it runs. **Declared GAP:** a daemon killed hard (`SIGKILL`, a crash) cannot stop its
  child, and an orphaned `cloudflared` keeps holding its edge connections and forwarding to the dead
  daemon's old port until something kills it. That costs availability only — a forwarded arrival meets
  a closed port, or a later daemon's listener once its provision rewrites the ingress — never the
  session: every byte is still §6/§7 under the pinned identity key. A process-group kill on the next
  boot is not attempted, because identifying "our" orphan by PID is unsafe across PID reuse.
- **What it publishes.** Once `cloudflared` reports a registered connection the daemon publishes
  `{ "kind": "tunnel", "url": "https://<label>.<zone>" }` in its carrier set (§13), and withdraws it
  when the connector is down or the tunnel was released, in the order direct → tunnel → relays. The
  published set's union **skips kinds a reader does not know** rather than refusing the set
  (`KNOWN_CARRIER_KINDS`), so this is the last carrier kind whose addition is a breaking change.
  **The published set is no longer constant for the life of the process.** §13's rule that pairing
  redemption and `GET /v1/carriers` give one answer is kept by ONE OWNER
  (`packages/daemon/src/lib/runtime/published-carriers.ts`) that both read, and every change replaces
  the whole parsed set; two reads differ only because the daemon's reach did.
- **Declared GAP.** The boot's "no relay carrier … NO other device can reach it" remedy is printed
  before the tunnel has provisioned, and does not yet account for a tunnel that will make the daemon
  reachable seconds later.

### What a tunnel operator can see, honestly

Ferretry, which provisioned the tunnel, and Cloudflare, which carries it, can see: the hostname and
which account holds it, and the mapping from it to the daemon fingerprint (in the control object);
both IP addresses; when sessions open and close; frame counts, sizes and timing (the §10 list, minus
nothing); and that the daemon renews. Cloudflare terminates the **outer** TLS at its edge, so it sees
the WebSocket upgrade's path and headers — but every byte above the upgrade is §6/§7 ciphertext under
a key agreed with the daemon's identity key, so it cannot read, alter or insert into a session.

**A stolen connector token** lets its holder run a connector for that hostname and receive some of
its traffic. What arrives is a handshake only the daemon's identity key can complete (§6), so the
holder can drop sessions, not impersonate the daemon. The daemon's next renewal does not rotate the
token in this version; an operator who suspects one deletes the tunnel (the daemon provisions a new
one). That is stated as a gap, not solved.

---

## 16. The WebRTC carrier

§15 is the carrier choice, where the owner first made WebRTC the preferred remote carrier and then made Relay the default. This section is the
WebRTC carrier itself: what crosses which wire, what it may and may not change, the native engine
that carries it on the daemon, and what has been measured. It is built in stacked steps, and "What is
built, and what is not" at the end of this section says which step this repository is at; every
other paragraph here is contract for the steps that follow, written down before they are built so
the daemon half and the browser half are implemented against one document.

### What it is, and what it buys

A browser and a daemon find a **direct UDP path** to each other through their NATs (ICE, with one
public STUN server telling each end its public address) and open SCTP data channels over DTLS on it.
Each data channel then carries **exactly what a direct WebSocket carries** (§4): one session, the same
frames (§3), the same handshake against the pinned fingerprint (§6), the same records (§7), the same
device proof, lease and §14 modes. Nothing above the channel knows which carrier it is on.

What that buys over the relay, and why it is the preferred remote carrier under Auto or WebRTC only:

- **One leg instead of two.** A relayed byte goes phone → edge → home; a peer-to-peer byte goes phone
  → home. The relay's Durable Object sits where it was first created, near the daemon, so a phone far
  from both used to pay that distance on every keystroke (§14, "What is not done") — and nothing on
  the relay side could shorten it. A peer-to-peer path is as short as the network allows.
- **No third party carries the session.** A rendezvous sees every frame's size and timing (§10). On
  this carrier the networks in between see the same encrypted UDP they would see of any video call,
  and the STUN server sees one binding request per end (below). Nobody operates anything in the path.
- **No meter and no ceiling.** §13's per-daemon byte and connection ceilings exist to bound a bill.
  A peer-to-peer session costs nobody anything, so a terminal or a remote-browser view on it is never
  refused `4432`/`4433`.

What it does **not** buy, stated so nobody claims it: it is not reachable without a rendezvous or a
direct address to signal through (below); it does not traverse every NAT (no TURN — below); and it
does not make a session survive a network change any more than any other carrier does (§9).

### Signalling travels inside an authenticated session, sealed

An offer and an answer have to cross somehow before there is a path. They cross **inside an ordinary
§14 request session** — over the relay when that is how the device reaches the daemon, or over a
direct session when it can (which is rarely worth it, since direct already won):

```
POST /v1/webrtc/offer      inside a session the paired device key opened
{ "sdp": "<the browser's offer>" }

200 { "sdp": "<the daemon's answer>" }
```

The route is `authenticated`, like `GET /v1/carriers`: a paired device asking for another way to reach
its own daemon is exactly the caller it exists for. It must be a **device inside its session** — a
host admin token is refused `403 webrtc_device_only`, because a peer connection belongs to one running
copy of the app and that caller has none. It is not capability-gated: a carrier is a pipe, not an act,
and every session on it meets the same guard. Both bodies are strict objects whose `sdp` is at most 32
KiB (`packages/protocol/src/lib/webrtc.ts`). Its refusals are ordinary answers a device reads and
states, each with a machine code: `404` from a daemon older than this carrier ("this daemon does not
offer WebRTC yet"); `503 webrtc_disabled` when the operator switched the carrier off and `503
webrtc_unavailable` when the daemon's engine would not start for this offer (the library would not load, or
a hand-back of its threads did not finish), each with the sentence; `429
webrtc_busy` at the peer bound below; `400 webrtc_offer_invalid` for an offer the engine could not
use. None demotes the session the request arrived on.

**The operator's switch** is a `webrtc` block in the daemon configuration document:
`{ "enabled": true, "iceServers": ["stun:stun.cloudflare.com:3478"] }` is the default, `enabled: false`
switches the carrier off (said in `fyd --check` and the boot trail), and `iceServers` takes at most
four `stun:`/`stuns:` addresses — a `turn:` address is refused, because it would need a credential the
document must never hold.

**Not as rendezvous control frames**, and the reasons are contract rather than taste:

1. **The relay never sees an SDP.** An offer carries both ends' candidate addresses — LAN addresses
   included, where a browser does not hide them — and the DTLS certificate fingerprint. Sealed in a
   record, a rendezvous learns that a record of some size crossed and nothing else; as a control frame
   it would learn every address each end has and could edit any of them.
2. **Only a paired device can make the daemon open a UDP port.** Answering an offer allocates sockets
   and starts ICE. Behind the session's device proof, that is a resource only a credential can spend;
   as a control frame it would be one anybody who knows the public fingerprint could spend.
3. **The rendezvous changes zero code**, which is the rule §14 already keeps: nothing new is visible
   outside the channel, so a deployed relay carries this carrier's signalling today.

The consequence is a dependency worth naming: **WebRTC is reachable only through another carrier
first.** A device that can reach neither the daemon's address nor a rendezvous cannot signal, and so
cannot reach it peer-to-peer either. A relay switched off by its kill switch (§13) therefore also
removes WebRTC for every device that needed the relay to introduce it.

**Pairing never crosses this carrier.** Signalling needs a session a device key opened, and a device
redeeming a code has no key yet. First contact stays direct, then relay (§14, "Pairing sessions").

#### Gathering is bounded, not "complete"

Signalling is **non-trickle**: one offer and one answer, each carrying every candidate its side
gathered — one round trip through the session, instead of a stream of candidate messages each paying
a relayed round trip of its own. But "every candidate" must be bounded. Measured against a public
STUN server, Chrome reports its server-reflexive candidate in under 10 ms and then holds its
gathering state short of `complete` for **about forty seconds**, until every STUN request on every
interface has timed out. So each side sends its description at the FIRST of:

- gathering `complete`;
- **250 ms** after its first server-reflexive candidate;
- **3 seconds** after gathering began.

#### No TURN, and a deadline instead

Version one uses **one STUN server and no TURN**. A path that needs a relay to exist at all —
symmetric NAT on both ends, a network that blocks UDP — therefore fails ICE, and the remedy is not a
second relay but the one this protocol already has: **a WebRTC attempt that has not delivered an open
channel within 8 seconds of the daemon's answer is abandoned, and the device carries on over the relay,
saying so**: the Connection status names the relay and, as the reason a faster carrier is not
carrying, "no direct path found in 8 s — this network may block peer-to-peer connections". The relay carries the requests that arrive meanwhile, so a failed
attempt delays nothing but the switch.

**The STUN server** is `stun:stun.cloudflare.com:3478`: no account and no credential, and Cloudflare
states that the service "is free and unlimited" (Cloudflare Realtime TURN FAQ, checked 2026-10-21).
It is configuration, like every other address here, not a protocol constant. What it learns: each
end's public IP address and port and when they asked — one binding request per end per attempt. It
never learns the daemon fingerprint, the session, or anything inside it.

### On the channel

- **One data channel is one session**, exactly as one direct socket is (§4). The browser opens a
  channel per session it would otherwise open — requests, the event stream, each attached terminal —
  on one peer connection, and SCTP gives each channel its own stream, so a busy terminal's
  retransmissions never hold up the request channel beside it.
- **Every channel is reliable and ordered.** §7 ends a session at the first sequence gap, so an
  unordered or lossy channel would turn every lost packet into a torn-down session, and a terminal
  frame is a delta against the frame before it (§14) — reordering one corrupts the picture. What an
  unordered channel would have bought, independence from another stream's loss, the per-session
  channel above already gives. So no channel is unordered.
- **The daemon plays the direct carrier's part:** on a new channel it mints the session identifier,
  sends `ready` with the same `limits`, and refuses a client control frame with `4400`. `fy-ping` and
  `fy-pong` are text messages on the channel, at the §8 keepalive cadence.
- **A close carries its code in a frame.** A data channel closes without a code, so before the daemon
  closes one it sends the session's `closed` control frame (§5), which carries the code and reason a
  WebSocket close would have. A channel that closes with no `closed` before it is a transport failure,
  never a quiet end.

### Authority: a WebRTC arrival is remote, always

**A session that arrived over WebRTC is never a loopback caller**, whatever address its UDP came from.
A browser on the daemon's own host that signals over the relay and connects peer-to-peer to its own
machine is still a remote, governed caller ([`grants.md`](grants.md)): privilege is the accepting
carrier's answer (§13), and this carrier answers `false` for every arrival, unconditionally, exactly
as a rendezvous does. A candidate address is something the peer chose to send, and reading locality
from it would hand a remote phone full control.

The DTLS layer is **not** what authenticates the daemon. Its certificate fingerprint travels in the
sealed SDP, so a relay cannot substitute it — but the identity this protocol trusts is still the one
§6 pins inside every channel, against the QR's fingerprint. A data channel whose DTLS was somehow
intercepted carries ciphertext the interceptor cannot read, and a forged daemon fails §6's first
check before the device proves anything.

A WebRTC caller's **rate-limit identity is its peer connection**, the value the daemon holds for the
whole association, never a shared placeholder (§14's rule for relayed callers, applied again).

**What the daemon bounds**, all initial configuration in the spirit of §13's ceilings: at most **8**
peer connections at once (counting offers still being answered, so a burst cannot overshoot), at most
**4** for one device — a further offer replaces that device's oldest — and **one per running copy of
the app**: the same device and `appSession` offering again replaces its own peer, which is exactly a
phone that changed networks abandoning the path it had. At most **8** channels on each peer, the §14
pre-credential deadline on every channel, and a peer connection with no open channel for **60
seconds** is closed, which also bounds one that never connected.

### When the network changes

libdatachannel — the daemon's engine, below — refuses an ICE restart: an offer whose ICE credentials
changed is rejected (`Invalid ICE settings from remote SDP`, measured against Chrome's `restartIce()`).
So a phone that moves from Wi-Fi to cellular does not renegotiate the path it had. Its sessions end the
way §9 already says sessions end — the keepalive or ICE consent freshness notices within seconds, the
browser's immediate check on `online` and a network type change notices sooner — and the device does
what it does on any carrier: re-sends reads, reopens streams from their cursors, never re-sends a
write blind. Meanwhile the relay carries, and a fresh offer on the new network brings the session
back to a peer-to-peer path. That is "resume without a full re-sync" in the only form §9 permits —
the application's own cursors, not a session that pretends nothing happened.

### What the browser shows

The active carrier is always named (§1): WebRTC when a channel carries the session, with the round
trip read from the nominated candidate pair's `currentRoundTripTime` — polled every 5 seconds while
the machine's Connection panel shows it, and never otherwise. When a slower carrier won AFTER WebRTC
was tried, the choice carries WebRTC's own sentence as the reason a faster carrier is not carrying
("no direct path found in 8 s — this network may block peer-to-peer connections", the daemon's
refusal, or "this machine does not offer WebRTC yet — updating Ferretry on it adds it"). A WebRTC that
was never tried — no `RTCPeerConnection` in this browser, or a preference (§15) that leaves it out — is
passed over as untried and is no fallback reason at all.

**How the browser holds it.** One `RTCPeerConnection` per daemon serves every session: the first dial
negotiates, every later one opens another channel on the same connection with no signalling. A
channel's first message can arrive in the same task as its `open` (measured in Chrome, on a peer that
is already connected), so a channel buffers from the moment it is created and the socket is announced
to the session only after the dial has resolved. A connection that `failed` or `closed`, or that
cannot open a new channel within 4 seconds, is dropped; so is every connection when the device comes
back online or its network type changes. The next dial negotiates afresh over the network the device
is on now — the renegotiation that stands in for the ICE restart libdatachannel refuses.

### The engine

Bun has no WebRTC, so the daemon carries one. Two were measured on 2026-10-21 (Bun 1.3.13, Linux x64,
two peers in one process over loopback, 64-byte echo round trips and 16 KB echo throughput):

| Engine                                                     | Channel open |     Echo p50 / p95 |   Throughput | Under Bun                                                                    |
| ---------------------------------------------------------- | -----------: | -----------------: | -----------: | ---------------------------------------------------------------------------- |
| **node-datachannel 0.33.4** (libdatachannel 0.24.5, N-API) |    **12 ms** | **0.21 / 0.70 ms** | **141 MB/s** | loads; embeds in a compiled `fyd` per target (below)                         |
| werift 0.25.1 (pure TypeScript)                            |       250 ms |     0.15 / 0.56 ms |     7.5 MB/s | **throws an uncaught `ECONNREFUSED` from `node:dgram` when its peers close** |

**node-datachannel**, because a process-killing exception on teardown is disqualifying for a daemon,
and a remote-browser view (§14) needs more than 7.5 MB/s. Its cost is that it is native code:

- **Every release target embeds its own prebuild.** The library chooses `@node-datachannel/<platform>`
  with a computed `require` a bundler cannot follow, so `scripts/release/compile-executable.ts`
  replaces that loader with one that imports the TARGET's `.node` as an embedded file — linux-x64,
  linux-arm64 and darwin-arm64 — and fails the build for a target with no mapping or no installed
  prebuild. `compile.sh` installs every target's prebuild first; the Nix build installs them all too,
  so its fixed-output dependency hash is the same on every builder. The Linux prebuild links nothing
  but the C library (OpenSSL and the C++ runtime are static), so it runs under Nix's glibc as well.
- **It is proved, not assumed.** `fyd --check` prints a `webrtc` line from a real self-test — two
  peers inside the binary, bound to loopback with no ICE server, open a channel and echo — and the
  release smoke (`scripts/release/smoke.sh`) fails a target whose compiled daemon does not report the
  engine ready. That runs on a Linux x64, a Linux arm64 and a macOS arm64 runner.
- **It is loaded lazily and fails soft.** A host where the addon will not load starts normally,
  `--check` says the engine is unavailable and why, and devices reach the daemon directly or through
  the relay as before.
- **It runs only while a peer needs it.** The serving daemon asks the engine nothing at boot: the
  first offer loads the library and starts its threads, and once the last peer has ended and no offer
  has arrived for 30 s (`WEBRTC_ENGINE_LINGER_MS`) the carrier hands it back and the library stops
  them (its `cleanup`). That is the difference between one thread per core plus two SCTP threads for
  the life of every daemon (33 + 2 on a 32-core host, measured) and none on a daemon no phone is using;
  it also takes the library load off the boot (0.4 s on a Mac). A start costs the first offer about
  20 ms on Linux (answered in 24 ms p50 against 6 ms with the engine already running, measured by
  `scripts/local/bench-daemon-shutdown.ts --peer`), plus the library load on a Mac — and the
  browser's 8-second deadline is counted from the answer, so none of it is spent from that budget.
  The hand-back runs only when no peer the engine made is open, because the library's cleanup closes
  every peer it holds; it blocks the daemon's thread while the library's threads join (2–8 ms
  measured), bounded by the library at 10 s. A cleanup that hit that bound is still running on the
  library's own thread holding the lock every new peer takes, so the engine is then marked broken
  and every later offer is refused `webrtc_unavailable` until a restart, rather than letting the next
  peer block the daemon for good. A stopping daemon closes its peers and does NOT hand the engine
  back: the threads end with the process, and the one call that waits on the library has nothing to
  give a stop. Proved by `packages/daemon/tests/realworld/runtime/shutdown-time.test.ts` (a real
  `fyd`: no library thread before an offer, a clean SIGTERM within 5 s idle and with a phone connected)
  and the engine's own suite (the threads gone after a release, a second answer starting them again).
- **Licence.** node-datachannel and libdatachannel are MPL-2.0: file-level copyleft that permits
  distributing them, unmodified, inside a differently licensed binary. Their source is public.

**Measured against a real Chrome** (Chrome 154, `packages/pwa/harness/webrtc-engine-bench.ts`,
loopback, the engine answering Chrome's offer, beside a Bun WebSocket in the same process):

| Measure                                    |                        WebRTC |        WebSocket |
| ------------------------------------------ | ----------------------------: | ---------------: |
| open, loopback only                        |                        195 ms |                — |
| open, with `stun.cloudflare.com` gathering | 380 ms (reflexive in 8–10 ms) |                — |
| 64-byte echo p50 / p95                     |          0.1–0.5 / 0.4–1.2 ms | 0.1 / 0.1–0.3 ms |
| 16 KB echo throughput                      |                    57–60 MB/s |     199–260 MB/s |

Loopback is the carrier's own overhead and nothing else: on a real path the round trip is the
network's, and a peer-to-peer path pays it once where a relay pays two legs. The bench does not run a
session above the channel, because the session is byte-for-byte the same on every carrier and costs the
same on each.

**A keystroke over it**, measured by §14's `packages/pwa/harness/relay-terminal-bench.ts` (real tmux,
the daemon's real `WebRtcCarrier` and direct session, the PWA's own dialer and session in a real
Chrome, xterm.js painting the echo; 30 keys per case, p50 / p95 ms, one machine, 2026-10-21). WebRTC
runs on loopback only: it is UDP, which the bench's shaping proxy (TCP) cannot touch.

| case                     |      direct |      WebRTC | relay (gate 0) |
| ------------------------ | ----------: | ----------: | -------------: |
| loopback · fresh         |  9.9 / 11.5 | 10.2 / 12.4 |    10.0 / 10.9 |
| loopback · 300 lines     | 11.9 / 26.6 | 14.6 / 26.7 |    13.6 / 26.6 |
| loopback · 1500 lines    | 11.8 / 26.7 | 12.4 / 26.7 |    12.8 / 26.9 |
| WAN (60 ms path) · fresh | 72.4 / 73.8 |           — |    75.7 / 77.7 |

So the carrier itself costs nothing measurable — a keystroke is the daemon's ~10 ms plus the path, on
every carrier. What WebRTC changes is the path: away from home it is the direct path's ONE leg, phone
to home, where the relay pays phone to edge to home and a phone far from both pays the Durable Object's
placement on every key (§14, "What is not done").

**What it costs to get there**, measured by the real-browser journey below on one machine: a session
page away from home named WebRTC as its carrier **5.6–13.1 s** after it was asked for — the 4-second
direct attempt, a relay session to introduce the two ends, the offer, ICE, DTLS and SCTP — and a page
with no peer-to-peer path fell back to the relay at **14.2–17.8 s**, the 8-second ICE deadline
included. An event the daemon appended after WebRTC won crossed with **zero** session frames on the
rendezvous.

### What is built, and what is not

- **Built — the engine.** `packages/daemon/src/adapters/webrtc` (the self-test and the loader the
  benchmark shares), the per-target embedding, the Nix and release installs, `fyd --check`'s `webrtc`
  line and the smoke that proves it on every target.
- **Built — the daemon carrier.** `POST /v1/webrtc/offer` (`packages/daemon/src/lib/runtime/mounts/webrtc.ts`),
  `WebRtcCarrier` (`packages/daemon/src/lib/webrtc/carrier.ts`: the bounds above, a data channel as a
  direct session with the fixed remote arrival, the close code carried as the session's `closed`), the
  engine's bounded non-trickle answer, and the `webrtc` configuration block. Proved by
  `packages/daemon/tests/integration/webrtc/webrtc-carrier.test.ts`: two libdatachannel peers in one
  process, the daemon's real carrier and direct session against the protocol's own client half — a
  proven device's request crosses the channel and reaches the route table as `loopback: false`,
  `webrtc-peer:…`, though both peers are on one machine; the heartbeat crosses as text; and a refused
  device proof reaches the client as `closed` `4403` before the channel closes.
- **Built — the browser carrier.** `packages/pwa/src/lib/webrtc-carrier.ts` (`WebRtcDialer`: the dial,
  bounded gathering, the deadline and the sentence it fails with, renegotiation on a dead path or a new
  network, the signaller that posts through an introducer), wired as the router's `CarrierDialers.webrtc`
  by the store, the fallback reason in the router's choice, and the round trip on the Connection panel
  (`useCarrierRtt`). Proved by `tests/e2e/webrtc-carrier.e2e.test.ts`: a real Chrome, paired over a real
  rendezvous with a freshly compiled `fyd` whose direct address is a sinkhole, is carried peer-to-peer
  with no session bytes on the relay; and with every ICE candidate removed from both descriptions in
  the page (a network with no peer-to-peer path; Chrome's own `disable_non_proxied_udp` policy was
  measured NOT to stop a loopback connection), it falls back to the relay at the deadline and the
  Connection panel says why.
- **GAP — no upgrade in place.** A connection that fell back to the relay stays there for the life of
  the page's connection, as every winner does (§13, "The walk", rule 4); WebRTC is tried again only
  when that carrier fails or the page reloads. A background upgrade would be a second, racing walk,
  which §13 rules out until it can still say why each carrier won.
- **GAP — first contact still pays the direct attempt.** Auto tries direct first (§15; the default, Relay, never reaches WebRTC), so a page away
  from home waits out its 4 seconds before WebRTC is even introduced; the measured 5.6–13.1 s above
  includes it.
- **GAP — no NAT is in any test.** Both peers run on one machine, so ICE pairs host candidates;
  whether a given home router or carrier-grade NAT lets two server-reflexive candidates meet is the
  STUN half, which only a device on a real network can show. Symmetric NAT on both ends is expected to
  fail and fall back — that is what the deadline is for.
