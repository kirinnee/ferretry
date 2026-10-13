# Zero-trust remote access

Status: **design, owner-approved direction; mechanics owned by this document.** It is built as four
pull requests in order — (A) device key, mutual handshake, access lease and idle expiry; (B) passkey
step-up and least-privilege defaults; (C) audit log and alerts; (D) signed PWA releases. Each PR
moves the matching section below from _design_ to _built_ and updates the contract documents it
touches ([pairing](../pairing.md), [grants](../grants.md), [relay-protocol](../relay-protocol.md),
[secrets](../secrets.md)).

The owner's goal, verbatim: _"we need it to be as secure as cloudflare zerotrust (like VPN)"_ and
_"i dont want user needing to signin to an id provider every other second"_.

## The one-paragraph version

A paired browser holds a **device key** it cannot export, and every session on every carrier is a
**mutually authenticated, end-to-end encrypted** channel: the daemon proves its identity against the
fingerprint in the pairing QR, and the device proves possession of its key by signing the same
handshake transcript. There is no bearer credential anywhere — nothing stored, nothing on the wire,
nothing in a header — so a copied browser profile, a backup or a sniffed LAN is worth nothing. A
session's authority is a **15-minute lease** the device renews silently by signing a daemon
challenge, and a device unused for **30 days** must pair again. Dangerous acts (a terminal, a
filesystem write, using a secret, changing the machine, grants, adding or removing devices) also need
a **passkey step-up** — Face ID / Touch ID / a PIN on the phone — that the **daemon** verifies, valid
for 15 minutes. A newly paired device can read and chat and nothing else until the owner grants more,
**at the machine** or from an already-privileged device with a step-up. Everything is recorded in an
append-only **audit log**, a new device is announced to the other devices, and the app itself is a
**signed release** its service worker verifies before it updates.

No identity provider exists anywhere in this design, and there are no repeated sign-ins: the device
key does the authenticating, silently; the passkey is asked for only before a dangerous act, at most
once per 15 minutes.

## What this is compared against

Cloudflare Zero Trust with WARP gives a device: (1) a device certificate / enrolment that is not a
copyable password, (2) short-lived access tokens renewed by the device, (3) re-authentication for
sensitive applications, (4) per-device, per-application policy with least privilege, (5) logs of who
did what, (6) an encrypted tunnel end to end. This design supplies each one, in the same order, with
mechanisms that need no identity provider and run on a machine with no inbound route:

| Zero Trust feature            | Ferretry mechanism                                                   | PR  |
| ----------------------------- | -------------------------------------------------------------------- | --- |
| WARP device certificate       | non-extractable Ed25519 device key, public half only on the daemon   | A   |
| tunnel (WireGuard / MASQUE)   | `ferretry-relay/2` session on **both** carriers, direct included     | A   |
| short access token + renewal  | 15-minute session lease, renewed by a signed daemon challenge        | A   |
| session / device expiry       | 30-day idle expiry; instant revocation that closes live sockets      | A   |
| re-auth for sensitive apps    | WebAuthn passkey step-up, verified by the daemon, 15 minutes         | B   |
| per-device policy             | per-device grants, default read + chat, widened at the machine       | B   |
| logs and alerts               | append-only bounded audit log, new-device alert to the other devices | C   |
| (a managed client, not a web) | signed PWA release manifest, pinned key in the service worker (TOFU) | D   |

The last row is the one place a web app is structurally weaker than WARP, and it is the subject of
the honest section at the end.

## Threat model

Assets, in order of value: **the host** (a terminal is the whole machine), **secrets** (using one runs
a command), **the fleet's provider accounts**, **conversation content**, and **metadata** (who paired
when, from where).

Adversaries, and what each must be denied:

| adversary                                      | must NOT be able to                                                                             |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **stolen phone, locked**                       | anything: the app's key is usable only by code running in the unlocked browser                  |
| **stolen phone, unlocked, app open**           | a dangerous act without the owner's biometric/PIN; outlast a revoke; register its own passkey   |
| **copied storage** (backup, profile copy, IDB) | authenticate at all: the private key is non-extractable and never serialised as bytes           |
| **malicious relay / Cloudflare**               | read, alter, inject, replay or impersonate either end; learn the device id or any credential    |
| **LAN attacker** (same Wi-Fi as the daemon)    | read or alter direct traffic, learn a credential, impersonate the daemon to a pairing device    |
| **compromised Pages deploy**                   | silently replace an installed app (detected and refused by D, within the TOFU limits below)     |
| **XSS in the app**                             | carry the key away; act after the tab closes; perform a dangerous act without the owner's UV    |
| **replay** of any captured frame or assertion  | have it accepted in any other session, or twice in the same one                                 |
| **downgrade** to an older protocol or path     | reach any path that is weaker: none exists — the bearer path, `POST /v1/pair` and `/1` are gone |

Out of scope by decision, not oversight: device posture (needs a native client), an attacker with the
owner's user account on the host, a malicious agent the owner chats with (see the end), and Cloudflare
Access in front of a self-hosted relay (a doc note in the self-hosting runbook only).

## A. The device key, the mutual handshake, the lease and idle expiry

### A1. The device key

- **Algorithm: Ed25519.** Measured, not assumed: the browser half of the relay already requires
  WebCrypto **X25519** (key agreement) and **Ed25519** (verifying the daemon's signature) — see
  `packages/relay/src/adapters/webcrypto-relay-crypto.ts` — so Ed25519 _signing_ adds no browser
  requirement the app does not already have. ECDSA P-256 would be the fallback for a browser without
  Ed25519; there is none that runs the relay client, so it is not built. A browser that refuses
  `generateKey({name:'Ed25519'}, false, ['sign'])` cannot pair, and the pairing screen says so in
  one sentence instead of falling back to anything weaker.
- **Non-extractable.** Generated with `extractable: false`. The `CryptoKey` object is stored in
  IndexedDB (database `ferretry-device-keys`, store `keys`, key = the daemon id), which keeps the
  object but never its bytes: `exportKey` on it throws, and a copy of the database restored into
  another profile yields a key object that the browser refuses to use, or no key at all.
- **One key per daemon.** A browser paired with three machines holds three keys. A revoked or
  expired pairing deletes only its own key, and a key that leaked by any route would authenticate to
  one daemon only.
- **The daemon stores only the public half**: the 44-byte SPKI, base64url, in
  `state/devices.json` (format v2 below). No token, no digest of a token, nothing a backup of the
  daemon's state could replay.

### A2. Pairing registers the key

Pairing always runs inside a §6 session now, on **both** carriers, so the daemon is proved against
the QR fingerprint before the code leaves the device on every path — the LAN included. The plain-HTTP
`POST /v1/pair` is **deleted**: it handed a live code to whatever answered at an address nothing had
authenticated, which `relay-protocol.md` §14 already called the weaker path.

The sequence-1 record of a pairing session:

```json
{
  "t": "pair",
  "protocol": "ferretry-relay/2",
  "code": "XXXX-XXXX",
  "deviceName": "Ferretry PWA",
  "deviceKey": "<44-byte Ed25519 SPKI, b64url>",
  "proof": "<64-byte Ed25519 signature, b64url>"
}
```

```
proof = Ed25519-Sign(device key, "ferretry-device-pair-v2" ‖ 0x00 ‖ TH ‖ LP(deviceKey as UTF-8 b64url text))
```

`TH` is this session's handshake transcript (§6). The proof shows the device holds the private half
of the key it is registering and binds the registration to this one session. A proof that fails is
treated exactly like a wrong code — one attempt spent, the same constant-time comparison against a
dummy, the same uniform `pair-refused` — so it is not an oracle either.

The sealed `paired` answer embeds the redemption response, which no longer carries a token:

```json
{
  "deviceId": "fy_device_id_…",
  "daemonId": "fy_daemon_…",
  "daemonName": "…",
  "capabilities": ["daemon-api"],
  "carriers": [ … ],
  "grants": { "fleet": { "use": true, "configure": false }, … },
  "idleExpiryDays": 30
}
```

`DeviceTokenSchema` is deleted from `@ferretry/protocol`, so nothing can construct, parse or log one.

### A3. The direct carrier speaks the same protocol

`relay-protocol.md` §1 and §3 always said the two carriers are byte-for-byte the same above the
socket; until now "direct" was really plain HTTP with a bearer header — over `http://` on a LAN, in
the clear. It becomes what the document said:

```
GET ws(s)://<daemon address>/v1/rendezvous/<daemonId>/client      (WebSocket upgrade)
```

- The daemon serves this path on its own listener. **One socket is one session**: on upgrade the
  daemon mints a 16-byte session id and sends the client the same `ready` control frame a rendezvous
  sends (`limits` included). That is the only control frame on a direct socket; the daemon never
  sends `challenge` and accepts no `claim`. Everything after it — handshake, records, credit,
  heartbeats — is identical to a relayed session, handled by the same `RelayLink` code.
- **Locality is decided by the carrier, as before.** A direct socket's arrival is classified exactly
  as an HTTP request on the same listener is (`loopback` from the socket's real peer,
  `privilegedLoopback` from the bind), and a relayed session is never local. The tunnel stamps the
  classification on every `ApiRequest` it builds; no header, address or URL inside a record can move
  it.
- **Every browser request goes through a session.** The router's direct branch opens a direct
  session instead of calling `fetch`, and event, terminal and remote-browser streams open stream
  sessions on either carrier. Single-use socket tickets are deleted entirely — daemon routes,
  protocol schema and PWA client: a stream is its own session, so nothing is left for a ticket to do.
  (GAP: the remote-browser viewer is unmounted and still written against tickets; it moves onto a
  stream session before it is mounted again.)
- **Admission is a cheap check in front of the expensive one.** A socket's hello costs the daemon a
  key agreement and a signature before anything is known about the caller, so the upgrade is admitted
  first: at most **30 upgrades a minute from one peer address**, at most **8 sockets that have not yet
  proved a device**, and at most **64 direct sessions** in all. The slot is taken when the upgrade is
  admitted, not when the socket attaches, so a burst of concurrent upgrades cannot all pass the check
  before any is counted; a reserved slot whose socket never attaches is handed back after ten seconds.
  An upgrade from an origin the daemon does not serve is refused with the same `403` an HTTP request
  from it gets, before any socket route runs.
- The HTTP listener keeps serving the **host's** credentials (admin token, warden token) exactly as
  before. It no longer resolves a device credential of any kind: the device bearer path is deleted,
  so a device identity can only come from a session. `ApiCredentials.devices` survives only as a
  yes/no "is this device still paired" check on each request, which fails closed when absent.

### A4. The mutual handshake: the device signs the transcript

§6's two handshake frames are unchanged in shape; the end-to-end protocol identifier becomes
**`ferretry-relay/2`** in `hs1`, `hs2` and every tunnel record, and the transcript and key-schedule
labels become `…-v2`. The **rendezvous control plane stays `ferretry-relay/1`** and the frame header
stays version `0x01`: nothing a relay parses changes, so no relay is redeployed and none can tell the
two apart. A `/1` peer meets a `/2` peer with `4426` at the handshake — there is no negotiation and
nothing to downgrade to.

The client authenticates in its sequence-1 record, inside the channel (so the relay never sees a
device id), the way TLS 1.3 does with `CertificateVerify`:

```json
{ "t": "auth",   "protocol": "ferretry-relay/2", "deviceId": "fy_device_id_…", "appSession": "<16 bytes b64url>", "proof": "<sig>" }
{ "t": "stream", "protocol": "ferretry-relay/2", "deviceId": "…", "appSession": "…", "proof": "<sig>", "path": "/v1/events", "query": [ … ] }
```

```
proof = Ed25519-Sign(device key,
          "ferretry-device-auth-v2" ‖ 0x00 ‖ TH ‖ LP(t) ‖ LP(deviceId) ‖ LP(appSession))
```

- The daemon looks the device up by id, checks it is not idle-expired (A6), and verifies the proof
  against the stored SPKI. An unknown id is verified against a fixed dummy key, so a known id and an
  unknown one cost the same Ed25519 verify. Unknown device, expired device and bad proof are **one**
  refusal, `4403`, uniform in wording, so the answer is not an oracle for which ids exist.
- **The close code is not secret.** A close travels in the clear, so a relay operator sees `4403` and
  `4441` and learns WHEN a session was refused, or when a device stopped renewing (asleep, locked,
  revoked) — never which device, and never why. Only the sealed records are private.
- Declared limit: an id that has just idle-expired also costs a revocation write on that request, so
  its timing differs. Ids carry 132 random bits, so this can only confirm an id that already leaked.
- `TH` covers both ephemeral keys, both nonces, the daemon's identity and the session id, so a proof
  is valid for exactly one session: a captured record replays into nothing.
- `appSession` is 16 random bytes the page generates once per page load and holds only in memory. It
  names "this running copy of the app" so a step-up (B) belongs to one tab's life and ends when the
  page closes. It is signed, so a relay cannot move it.
- **The daemon, not the page, decides when a copy of the app has closed.** `appSession` is any 16
  bytes the client picks, so code running in the page (an XSS, a malicious deploy) could keep it and
  present it again from a later page of the same device. What it cannot keep is a live session. A
  step-up therefore belongs to one **span**: the unbroken stretch in which that `(deviceId,
appSession)` holds at least one session, with 60 seconds of slack for a reconnect. When the span
  ends the step-up is dropped, and the same id presented afterwards begins a new span that holds
  nothing (`StepUpRegistry`, told by the connection registry when each session opens and closes).
- Declared limit: while the real page is still open, other code of the same origin on the same device
  (a second tab of a malicious deploy) can open a session with the same id and share its step-up. It
  could already drive the open tab itself, so the span does not widen what that code can do.
- The admin token is still not resolvable through a session, deliberately — it is a host-local secret.

### A5. The access lease and silent renewal

There is no bearer access token. The "access ticket" is a **lease the daemon holds against one keyed
session**: 15 minutes from the moment the device's proof verified.

```
daemon → client   { "t": "renew", "protocol": "ferretry-relay/2", "nonce": "<32 bytes b64url>", "expiresAt": "<ISO instant>" }
client → daemon   { "t": "renewed", "protocol": "ferretry-relay/2", "proof": "<sig>" }

proof = Ed25519-Sign(device key, "ferretry-device-renew-v2" ‖ 0x00 ‖ TH ‖ LP(nonce))
```

- The daemon sends `renew` two minutes before the lease ends, in request and stream sessions alike;
  the client answers immediately (an incoming record wakes even a background tab, where a timer
  would be throttled). A valid answer re-checks that the device is still paired and not idle-expired
  and extends the lease to 15 minutes from now. The nonce is single-use; a second `renewed`, or one
  with no outstanding `renew`, is `4400`.
- A lease that runs out ends the session with **`4441` — the access lease ended**, which a client
  treats as "open a new session", silently, never as a revocation. `4403` stays the only code that
  means "this device is no longer accepted".
- **A session also has an absolute cap: 12 hours** (`MAX_SESSION_SECONDS`) from its first proof. The
  lease is never extended past it; the session ends `4441` and the client opens a new one, which is
  a fresh proof over a fresh transcript.
- **The clock is checked on every record, not only by the timer.** A record that arrives after the
  lease ended is not served, even when the event loop was too busy to fire the lease timer in time.
- **`renew` jumps the queue.** It goes ahead of any payload waiting for credit, behind only the record
  being sealed, so a busy terminal stream cannot hold the renewal back until the lease lapses.
- What it buys: authority on any one channel needs a device signature at least every 15 minutes and
  can never outlive 12 hours, and every renewal re-reads revocation and expiry from the daemon's own
  state.
- Declared limit: a write still running when a session ends (lease, cap, revocation) completes on the
  daemon, but its answer is lost with the session. The client correctly never replays a write, so the
  person can be told a change failed that in fact happened. A correctness gap, not a security one.
- **An open stream is asked again.** A stream session keeps the request it was accepted for, and the
  daemon re-runs the socket table's own authorization for it (`ApiSocketDispatcher.reauthorize`) on
  every renewal and whenever the grant service's answer moves — a change, a refresh, a failed
  refresh. A stream that is no longer allowed ends with a sealed `1008 this stream is no longer
allowed`, never `4403`, which would tell the device it is unpaired. The re-check counts the step-up
  that opened the stream as spent: a step-up authorizes the OPEN, and only a narrowed grant ends it.

### A6. Idle expiry and revocation

- `lastSeenAt` is now real, and it means **a person used this device**. Only a request the page marks
  `presence: true` advances it: the page is visible and somebody touched, clicked or typed in it in the
  last five minutes, or it was opened in the last minute (`packages/pwa/src/lib/presence.ts`).
  Authentication and silent renewal never advance it, so a tab left open on a forgotten laptop still
  expires. It is persisted at most once an hour per device (so a busy phone is not a disk write per
  request). The mark is the device's own word, and that is enough: it answers a forgotten device, not
  a hostile one — somebody using a stolen phone IS present, and revocation is the control for that.
- A device whose `lastSeenAt` is **30 days** old is expired: refused at its next auth, removed from
  `devices.json`, and absent from the device list — it must pair again. The check runs at boot, at
  every auth or renewal, and at every device-list read; there is no timer.
- Revocation is unchanged and instant: the document is written, the registry entry dropped, and every
  live socket the device holds — direct sessions included — is closed with `4403`.

### A7. `devices.json` v2, and no compatibility

```json
{
  "schemaVersion": 2,
  "daemonId": "fy_daemon_…",
  "devices": [
    {
      "id": "fy_device_id_…",
      "name": "…",
      "platform": "browser",
      "publicKey": "<44-byte Ed25519 SPKI b64url>",
      "createdAt": "…",
      "lastSeenAt": "…",
      "grants": { … }
    }
  ]
}
```

A v1 document (records carrying `tokenHash`) is read as **no devices**: every device pairs again
once, the boot trail says how many grants were dropped and why, and the next write replaces the file.
That is the owner's decision ("NO backward compatibility needed"), and it is the only migration that
deletes the bearer path completely rather than keeping a reader for it.

The browser drops its stored `deviceToken` the same way: a stored connection without a device key is
not a pairing, and the app shows the pairing screen for it.

### A8. Large bodies cross the tunnel

Moving the direct carrier into the tunnel means a §7 record (65 492 bytes of plaintext) would cap
every answer the LAN used to carry uncapped. `oversize` is therefore replaced by chunking, which also
fixes the relay's own limit:

```json
{ "t": "req", "id": 7, "method": "PUT", "path": "…", "body": "<first part>", "more": true }
{ "t": "req-more", "id": 7, "body": "<next part>", "more": true }
{ "t": "req-more", "id": 7, "body": "<last part>" }

{ "t": "res", "id": 7, "status": 200, "headers": { … }, "body": "<first part>", "more": true }
{ "t": "res-more", "id": 7, "body": "<next part>" }
```

Parts of one id arrive in sequence order; parts of different ids may interleave. A body is assembled
up to **32 MiB**; a request beyond that is answered `413` and a response beyond it `502` with a
typed error, never truncated. Credit (§8) bounds what is in flight.

### A9. Version skew says which side to update

Pages ships the app on every merge to `main`, while a daemon updates when its owner upgrades it, so
for a while an updated app meets an old `fyd` and an old (cached) app meets an updated one. Neither
case may surface as a generic connection error. Each is **one plain sentence naming the side to
update and how**:

| who is newer | what is observed                                                                                                    | the sentence the person reads                                                                                                                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the app      | the daemon closes the handshake with `4426`, or answers a direct socket upgrade with no session, or `hs2` says `/1` | "This machine is running an older Ferretry than this app. Update it on the machine (brew upgrade --cask ferretry, nix profile upgrade, your apt or dnf upgrade, or the install script again), then run fy daemon restart and pair this device again." |
| the daemon   | an old app's plain-HTTP request carrying an `fy_device_` bearer token, or an old `hs1` naming `/1`                  | "This app is older than the machine it is talking to. Reload the page (or reopen the installed app) to update it, then pair again."                                                                                                                   |

The second row is the daemon's job, because an old app cannot learn new words: an HTTP request with
a bearer that looks like a pre-key device token is answered `426 Upgrade Required` with that sentence
as the error message (which the old app already renders as text), and an `hs1` naming `/1` is closed
with `4426` and the same sentence as the close reason. The upgrade commands are written once, in
`@ferretry/protocol`, so the CLI, the daemon and the app cannot name different ones.

**An "older daemon" signal is evidence, never a verdict that stops the walk.** A plain `/healthz`
answer and a `closed 4400 'unparseable client hello'` are both unauthenticated: anybody on the direct
path can forge them. So the app notes the signal and keeps walking the carriers, and the first row's
sentence is shown only when NO carrier reached the daemon and at least one of them looked old. A
forged signal on the direct path therefore cannot stop the app from reaching a working relay.

## B. Passkey step-up and least privilege

### B1. Which acts need a step-up

A **governed** caller (any device not on a host-proven carrier) must hold a current step-up for:

| act                                                        | route demand                      |
| ---------------------------------------------------------- | --------------------------------- |
| open, attach to, or write to a terminal                    | `terminal.use`                    |
| write to a session's files, register a project             | `filesystem.configure`            |
| use a secret (runs a command), set or delete one           | `secrets.use/configure`           |
| any `fleet.configure` act (apply, sign-in, setup, clone …) | `fleet.configure`                 |
| change grants (daemon-wide or a device's)                  | `grants`                          |
| mint a pairing code, revoke a device                       | `pairing.use`                     |
| browser control, warden configuration                      | `browser.use`, `warden.configure` |

The rule is one line in the dispatcher: **a route whose capability demand is `*.configure`, or is
`terminal.use`, `secrets.use`, `browser.use` or `pairing.use`, requires a step-up from a governed
caller.** Reads (`fleet.use`, `filesystem.use`, `warden.use`) and everything in the daemon's own
state home (sessions, chat, tasks, attention, pins) do not. A refusal is
`403 { code: "grant_step_up_required" }`, which the app answers by raising the passkey prompt and retrying
once.

### B2. The ceremony, and who verifies it

The **browser performs** the WebAuthn ceremony; the **daemon is the verifier**. The relay carries
only sealed records and can neither forge an assertion (it has no authenticator) nor replay one (the
challenge is single-use and bound to one device and `appSession`).

- Registration — `POST /v1/passkeys/options` → `{ challenge, rp: { id, name }, user, pubKeyCredParams }`,
  then `POST /v1/passkeys` with the attestation (`clientDataJSON`, `attestationObject`). Attestation
  format `none`; ES256, EdDSA and RS256 credentials are accepted. The daemon stores the credential
  id, its public key (as SPKI) and `signCount` on the device's record.
- Step-up — `POST /v1/step-up/options` → `{ challenge, rpId, allowCredentials }`, then
  `POST /v1/step-up` with `credentialId`, `clientDataJSON`, `authenticatorData`, `signature`.
- The daemon checks, in order: the challenge is one it issued to this device and `appSession`,
  unexpired (2 minutes) and unspent, and it is spent now; `clientData.type` is `webauthn.create` /
  `webauthn.get`; `clientData.origin` is one of the daemon's `corsOrigins`; `rpIdHash` equals
  SHA-256 of that origin's host; flags **UP and UV** are set; the credential belongs to this device;
  the signature verifies over `authenticatorData ‖ SHA-256(clientDataJSON)`; and, when either
  counter is non-zero, `signCount` increased (a stuck or rewound counter refuses and is audited).
- A verified step-up is held **in the daemon's memory** for `(deviceId, appSession)` for **15
  minutes**. It ends early on revoke, on a daemon restart and when the page closes (a new
  `appSession`). It is never a value the browser holds.
- Verification is WebCrypto only: a minimal CBOR reader (attestation object, COSE key) and DER →
  raw conversion for ES256 are written here rather than imported, because the verifier is ~300 lines
  with a fixed input shape and every dependency on this path is attack surface.

**A passkey belongs to one app origin.** WebAuthn binds a credential to its relying-party id, which
is the host of the page that created it: a passkey made in the hosted app (`ferretry.pages.dev`)
cannot be used by a self-hosted copy (`ferretry.example.com`), a local development server
(`localhost`) or a preview deploy, and vice versa — browsers refuse to offer it, by design. So:

- each app origin a person uses has **its own device key and its own passkey**. That is already true
  of the device key (IndexedDB is per origin), so an app at a second origin is simply a second paired
  device and registers its own passkey within its pairing window;
- the daemon accepts an assertion only for an origin in `corsOrigins`, and checks `rpIdHash` against
  **that** origin's host — a self-hosted app works once its origin is added there, exactly as its
  requests already need;
- `localhost` is a valid relying-party id for development (browsers treat it as a secure context);
  a plain-HTTP LAN origin (`http://192.168.…`) is not, so WebAuthn is unavailable there and the app
  says so.

When the browser has no passkey for this origin — or the origin cannot hold one — the step-up prompt
says it plainly: "This copy of the app at ‹origin› has no passkey for this machine. Add one from a
device that already has access, or pair this device again at the machine." Never a raw
`NotAllowedError`.

**Who may register a passkey**, because a thief holding an unlocked, open app must not be able to add
their own: (a) a device with **no passkey yet, within 10 minutes of pairing** — the moment the owner
is holding it; (b) any device **with a current step-up** (adds a second authenticator); (c) the
**host** (a browser on a host-proven carrier). Lost every passkey? Revoke the device and pair again at
the machine.

### B3. The operator password is deleted

**Done.** The step-up replaced the operator password for every purpose it had: the local-browser unlock,
the remote `configure` lock and the per-change confirmation on fleet apply and sign-in. No compatibility
was kept.

- **Removed:** `state/operator-password.json`, `PUT /v1/grants/password`, `POST /v1/grants/unlock`, the
  `x-ferretry-operator-unlock` header, `fy daemon password`, the unlock dialog, and the password prompt at
  `fy daemon start`. A stale `state/operator-password.json` is deleted at boot with one notice line.
- **Pairing:** `POST /v1/pair/code` no longer requires a password. It is governed by `pairing.use`, so a
  governed caller needs a step-up to mint, and a caller on the host mints freely.
- **The decision:** a caller is governed exactly when its request did not arrive on the host. A governed
  caller needs a step-up for every `configure` demand and for `use` of `terminal`, `browser` and
  `pairing`; every other `use` is granted. The refusals are `granted`, `not-granted`,
  `step-up-required` and `undetermined` — `locked`, `rate-limited` and `ungated` no longer exist.
- **Widening is host-only.** A governed caller may only narrow, and a narrowing needs a step-up. A remote
  warden is governed and can never step up, because it has no device.
- **The cost, stated:** the per-change confirmation's "bound to one diff" property becomes "bound to a
  biometric check in the last 15 minutes", which is weaker against a replayed request and stronger against
  a known password — and replay is no longer possible inside a sealed session anyway.
- **A declared GAP:** `pairing.use` also guards the four `/v1/push/*` enrolment routes, so a governed push
  subscription now needs a step-up too. Moving push off `pairing.use` is B5 and is not done here
  ([grants.md](../grants.md) records it).

### B4. Loopback is ungoverned, and it is the recovery path

A caller that **arrived on the host** — the CLI with the admin token, or a browser on a host-proven
direct carrier (`privilegedLoopback`) — is ungoverned: no step-up, no per-device narrowing. Somebody
at the machine already has the machine. This is also the only recovery: lost phone, lost passkey or a
device narrowed to nothing is repaired at the machine, with `fy` or a local browser. The cost is
stated: a browser tab left open on the host is not protected by any of this. A remote caller arriving
through a local proxy (`tailscale serve`, `cloudflared`) is NOT host-proven, exactly as today.

### B5. Least-privilege defaults

Grants become **per device**, on top of the daemon-wide document:

```
effective(device, capability, axis) = daemonWide[capability][axis] ∧ device.grants[capability][axis]
```

- A newly paired device gets **`fleet.use` only**: it can read the fleet and chat with sessions.
  Terminal, filesystem, browser, secrets, warden, pairing and every `configure` axis start off.
- A **seventh capability, `secrets`**, is added: `secrets.use` governs `POST /v1/secrets/use` (it
  runs a command — code execution) and the list; `secrets.configure` governs set and delete. Today
  those routes carry no capability demand at all, so any paired device can run a command through
  them; that is closed. The "before you add capability seven" questions in grants.md are answered in
  the same PR.
- **Widening a device** is done at the machine (`fy device grant <device> <capability> --use`, or the
  local browser), or remotely by a device that holds `pairing.configure` **and** the capability being
  granted **and** a current step-up. No device can grant what it does not hold, so nothing escalates.
- **Narrowing** a device (including oneself) needs a step-up and nothing else — never harder than
  widening.
- The daemon-wide document keeps its asymmetry unchanged: a remote caller may switch a capability off
  for everyone and can never switch it back on.
- Web Push self-enrolment moves off `pairing.use`: a device enrolling **itself** for notifications is
  allowed for every paired device (it grants nothing), so a default device still gets alerts.

### B6. Per-daemon security settings

Owner decision (2026-10-13). One **Security** section per machine — in the app's Settings for that
machine, and `fy daemon security` at the host — holds the knobs below. Each has a default and hard
bounds; a value outside the bounds is refused, never clamped.

| Setting                 | Default    | Bounds                   | Narrower means |
| ----------------------- | ---------- | ------------------------ | -------------- |
| `stepUpWindowMinutes`   | 15         | 0–60 (0 = every time)    | smaller        |
| `deviceKeyRotationDays` | 30         | 7–90                     | smaller        |
| `presenceOnOpen`        | off        | on / off                 | on             |
| `presenceValidityHours` | 8          | 1–24                     | smaller        |
| `idleExpiryDays`        | 30         | 1–90                     | smaller        |
| access lease            | 15 minutes | **fixed, not a setting** | —              |

- **Step-up window.** How long one passkey assertion covers dangerous actions (B1) for one
  `appSession`. `0` asks every time.
- **Device-key rotation.** The `authenticated` and `stream-opened` records carry `rotateBy`. Once it
  has passed, the next step-up ceremony also rotates the key: the browser mints a new non-extractable
  key, the daemon receives `{ deviceKey, proof }` where `proof` is the NEW key's signature over
  `"ferretry-device-rotate-v2" ‖ 0x00 ‖ TH ‖ LP(deviceId) ‖ LP(deviceKey)`, inside a session the OLD
  key opened, together with the assertion. The daemon swaps the SPKI, closes the device's other
  sessions with `4441` (so they reopen with the new key), and audits `device.key-rotated`. The old key
  then opens nothing. No extra prompt exists for this: a device that is overdue cannot complete a
  step-up-gated action without rotating in the same ceremony, while plain `fleet.use` keeps working.
  Lost answer: the browser stores the new key as _pending_ before sending and, if the old key is
  refused, tries the pending one once — so a dropped response never strands the device.
- **Presence on open.** Off by default. When on, a session still opens (the device key is proved as
  always), but every request answers `401 presence_required` until the device completes a passkey
  assertion; one assertion is good for `presenceValidityHours` for that device, across page loads.
  Dangerous actions still need their own step-up window — presence never counts as a step-up.
- **Idle expiry.** A6's 30 days, now a setting. Shortening it applies at the next check (boot, auth,
  device list), so it can expire devices immediately; the confirmation says how many.
- **The access lease stays fixed at 15 minutes**, deliberately. Renewal is silent, so a longer lease
  buys a person nothing and only widens how long a revoked or expired device's open channel lives; a
  shorter one costs renewals without a security gain worth a knob. Fixed is simpler and safer.

**Who may change them — the grants.md asymmetry, again.** Changing any setting is a _configure_
action on the `pairing` capability.

- **Narrowing** (a smaller window or period, `presenceOnOpen` → on) is allowed remotely by a device
  holding `pairing.configure` **with a current step-up**.
- **Widening** (a larger window or period, `presenceOnOpen` → off) is allowed **only at the machine**
  — a loopback caller, the CLI, or the local browser. A remote widen is `403` with a sentence naming
  the command to run at the machine.
- A request that changes several fields is judged field by field and refused whole if any field
  widens remotely.
- Where it lives: `<FY_HOME>/state/security.json` (`schemaVersion: 1`, written atomically, mode
  `0600`). An unreadable or invalid document **fails closed to the defaults' narrowest reading**
  (presence on, window 0) with a notice naming the file, never to "off".
- Every change is audited as `security.changed` with the field, old value, new value and actor.

Tests: each bound accepted at its edges and refused one past them; each field's widen refused
remotely and accepted at loopback; narrow refused without a step-up and accepted with one; a mixed
request refused whole; rotation end to end (old key refused afterwards, other sessions closed, the
pending-key recovery); presence gating on and off; the corrupt-document fail-closed path; and the
audit record for every change.

Delivery: built after B (it needs the step-up ceremony), as part of B if it fits, otherwise as a
small PR E immediately after it.

## C. Audit log and alerts

- **Where:** `<FY_HOME>/state/audit.jsonl`, rotated to `audit.1.jsonl` at 1 MiB, two files kept —
  bounded at 2 MiB. Append-only: one `O_APPEND` write per record, mode `0600`, never rewritten in
  place. The existing `grant-audit.jsonl` is folded in (grant changes become one event kind).
- **What:** `{ at, event, actor: { kind: "host"|"device"|"warden", deviceId?, deviceName? }, subject?, outcome, detail? }`
  for: `device.paired`, `device.revoked`, `device.expired`, `pairing.code-minted`, `pairing.refused`,
  `session.opened` (carrier + locality, at most one per device per hour), `step-up.succeeded`,
  `step-up.failed`, `passkey.registered`, `terminal.opened`, `fleet.configured`, `grants.changed`,
  `secrets.used`, `security.changed`, `device.key-rotated`. **Names and ids only** — never a code, key, proof, assertion, secret value or
  command line; a test greps every written record for each of those.
- **Read:** `GET /v1/audit?limit=` (newest first, at most 200, `pairing.use`), `fy daemon audit`, and
  a Settings › Security view in the app. A line that does not parse is counted and reported, never
  dropped.
- **Alerts:** `device.paired` sends a Web Push notification to every **other** enrolled device
  ("A new device, ‹name›, was paired with ‹machine›") and the app shows an in-app notice for devices
  added since this device last looked, with a one-tap revoke.

## D. Signed PWA releases

- **Signing.** The release build writes `release-manifest.json` — `{ version, commit, createdAt,
files: { "<path>": "<sha256 b64url>" } }` covering every file in `dist/` — and CI signs its exact
  bytes with an Ed25519 key, writing `release-manifest.sig`. The private key lives in a GitHub
  Actions secret (`PWA_RELEASE_SIGNING_KEY`, PKCS#8 PEM) scoped to a protected `pwa-release`
  environment that only the `main` deploy job may use; it is never printed and never written to the
  workspace except into a `0600` temp file deleted by a trap. The public key is committed
  (`packages/pwa/release-signing-key.pub`) and compiled into the service worker. The runbook covers
  generation, rotation (a new key is announced by a manifest signed with the old one) and
  compromise (a forced reinstall).
- **Verifying.** The service worker serves the app from a cache it filled only with verified bytes.
  On an update check it fetches the manifest and signature, verifies the signature with the key it
  pinned at first install (stored in its own IndexedDB), fetches every listed file, checks every
  hash, and only then swaps caches. A manifest that fails — bad signature, unknown key, any hash
  mismatch, a version that is older than the installed one — is refused: the installed version keeps
  running and the app says an update failed verification.
- **TOFU, disclosed.** The first install trusts whatever Pages served at that moment. And because a
  browser installs a changed `sw.js` on its own schedule, an attacker who controls the deploy and
  ships a **new service worker** can replace the verifier itself. The running, verified app watches
  for a new worker and checks its script hash against the signed manifest; an unsigned one is
  reported loudly to the person and recorded on the daemon's audit log — **detected, not
  prevented**. Preventing it needs a client the deploy cannot rewrite (a native app or an
  extension), which is out of scope.
- **As built** (`feat/zt-signed-pwa`, runbook [`docs/pwa-release-signing.md`](../pwa-release-signing.md)),
  where the mechanics differ from the sketch above:
  - **The worker URL is fixed**, `/sw.verified.js`, not per release. The worker does not change when a
    release does — it swaps releases itself — and a changed worker script is still re-checked by the
    browser and reported.
  - The signed list names that script in a `worker` field, and the signature file is
    `<sha256 of the signing key's SPKI>.<signature>` (base64url), so "unknown key" and "bad signature"
    are told apart.
  - **Order is version, then `createdAt`** (the commit time), because many Pages deploys share one
    version.
  - **An unsigned build writes the word `unsigned` as its signature.** It is accepted — as
    "unverified", with nothing cached — only on a loopback hostname, refused everywhere else, and the
    deploy workflow refuses to publish one. Until the owner adds `PWA_RELEASE_SIGNING_KEY` to the
    `pwa-release` environment, the Pages deploy fails at its signing step on purpose: there is no
    unsigned deploy.
  - **Rotation:** commit `release-signing-key.next.pub`; the build lists it as `nextKey`; an installed
    copy that accepts that release trusts both; the first release signed by the new key retires the
    old one.
  - **Audit seam for C:** `onUnsignedWorker({ scriptUrl })` in
    `packages/pwa/src/hooks/use-release-integrity.ts`, not yet wired to the daemon's audit log.
  - The worker also shows Web Push notifications and handles their clicks — the app had no worker
    before, so a push could not reach a closed app.

## What this does NOT protect against

Said plainly, because the useful property is narrower than "zero trust" sounds:

- **A compromised host.** Everything terminates there. Malware as the owner's user reads the
  daemon's state, the admin token and the secrets key.
- **Code running in the open app.** XSS or a malicious deploy can _use_ the device key while the tab
  is open (it cannot copy it) and can raise a passkey prompt — the owner's biometric is the last
  line, so a prompt nobody asked for must be refused. Its authority ends when the tab closes.
- **A compromised Pages deploy, on first install or via a new service worker** — see D. A deploy is
  trusted the way any website is, once.
- **A host that answers the browser’s own worker-install request differently from a plain fetch.**
  The release-integrity check reads the worker script with an ordinary fetch; a deploy that serves a
  different script to the browser’s install request bypasses the alarm.
- **Code running in the open app rewriting the pinned release key** in IndexedDB. The pin is only as
  strong as the app that holds it.
- **An unlocked phone in a thief's hand with the app open**, for everything that needs no step-up:
  reading the fleet and chatting. Chatting with an agent that has tool permissions is **code
  execution by proxy**; least privilege does not change what an agent already allowed to act will do
  when asked. Revoke the device first.
- **The 30-day idle window.** A device used at least once a month never expires; revocation is the
  control for a lost device, and the new-device alert is the control for an added one.
- **Somebody at the machine.** Loopback is ungoverned by design (B4); an SSH tunnel to the port is
  loopback.
- **Relay metadata.** A relay still sees fingerprint, IPs, timing and frame sizes
  (`relay-protocol.md` §10); this design hides the device id from it, nothing more.
- **Denial of service.** A relay can drop traffic; a guesser can spend a pairing code's relay budget.
- **Device posture.** No OS version, disk encryption or screen-lock check — that needs a native app.
