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
challenge, and a device unused for **30 days** must pair again. Before it may do anything at all, a
device **unlocks** the machine with a **passkey** — Face ID / Touch ID / a PIN on the phone — that the
**daemon** verifies; the unlock lasts **8 hours** by default (1 hour to 7 days) across page loads, and inside it
the device may do everything its grants allow with no further prompt (B1). **Adding access always asks
again**: minting a pairing code, widening another device, and turning "what agents may control"
(terminals/browsers/files) back ON from a remote device each need a passkey proved for that one act —
turning one OFF never does, and the machine itself is never asked (owner decision, T).
The owner can turn a per-act step-up back on (`stepUpOnActions`). A newly paired device holds every
capability behind its unlock, or `fleet.use` only when its code was minted `fy pair --limited`; a
remote device may only narrow a grant or a security setting, and widening is **at the machine**, with
`fy`. Everything is recorded in an append-only **audit log**, a new device or passkey is announced to
the other devices, and the app itself is a **signed release** its service worker verifies before it
updates.

No identity provider exists anywhere in this design, and there are no repeated sign-ins: the device
key does the authenticating, silently; the passkey is asked for once per machine per unlock period,
and again only to add a device or widen one (or per act, if the owner asks for that).

## What this is compared against

Cloudflare Zero Trust with WARP gives a device: (1) a device certificate / enrolment that is not a
copyable password, (2) short-lived access tokens renewed by the device, (3) re-authentication for
sensitive applications, (4) per-device, per-application policy with least privilege, (5) logs of who
did what, (6) an encrypted tunnel end to end. This design supplies each one, in the same order, with
mechanisms that need no identity provider and run on a machine with no inbound route:

| Zero Trust feature            | Ferretry mechanism                                                                                 | PR  |
| ----------------------------- | -------------------------------------------------------------------------------------------------- | --- |
| WARP device certificate       | non-extractable Ed25519 device key, public half only on the daemon                                 | A   |
| tunnel (WireGuard / MASQUE)   | `ferretry-relay/2` session on **both** carriers, direct included                                   | A   |
| short access token + renewal  | 15-minute session lease, renewed by a signed daemon challenge                                      | A   |
| session / device expiry       | 30-day idle expiry; instant revocation that closes live sockets                                    | A   |
| re-auth for sensitive apps    | WebAuthn passkey unlock, verified by the daemon, 8 hours by default; fresh passkey to add a device | B   |
| per-device policy             | per-device grants, full behind the unlock or `--limited`, widened at the machine                   | B   |
| logs and alerts               | append-only bounded audit log, new-device alert to the other devices                               | C   |
| (a managed client, not a web) | signed PWA release manifest, pinned key in the service worker (TOFU)                               | D   |

The last row is the one place a web app is structurally weaker than WARP, and it is the subject of
the honest section at the end.

## Threat model

Assets, in order of value: **the host** (a terminal is the whole machine), **secrets** (using one runs
a command), **the fleet's provider accounts**, **conversation content**, and **metadata** (who paired
when, from where).

Adversaries, and what each must be denied:

| adversary                                      | must NOT be able to                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **stolen phone, locked**                       | anything: the app's key is usable only by code running in the unlocked browser                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **stolen phone, unlocked, app open**           | anything before the device unlocks the machine; register its own passkey on THIS device. INSIDE an unlock period it can do what the owner could (B1) EXCEPT add access: minting a pairing code and widening another device always want a fresh passkey confirmation for that one act, unlock or not (owner decision 2026-10-14; R2-M2 closed), so it cannot pair a device of its own without the owner's face, finger or PIN — the period, `stepUpOnActions`, the `passkey-added` push and revoking the phone are the controls |
| **copied storage** (backup, profile copy, IDB) | authenticate at all: the private key is non-extractable and never serialised as bytes                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **malicious relay / Cloudflare**               | read, alter, inject, replay or impersonate either end; learn the device id or any credential                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **LAN attacker** (same Wi-Fi as the daemon)    | read or alter direct traffic, learn a credential, impersonate the daemon to a pairing device                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **compromised Pages deploy**                   | silently replace an installed app (detected and refused by D, within the TOFU limits below)                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **XSS in the app**                             | carry the key away; act before the owner unlocks. Inside an unlock it can act as the owner (B1) — on ANY page load of that device for the unlock's validity, not only the tab that unlocked (the unlock is the device's, by decision; R2-M1)                                                                                                                                                                                                                                                                                   |
| **replay** of any captured frame or assertion  | have it accepted in any other session, or twice in the same one                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **downgrade** to an older protocol or path     | reach any path that is weaker: none exists — the bearer path, `POST /v1/pair` and `/1` are gone                                                                                                                                                                                                                                                                                                                                                                                                                                |

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
  The remote-browser viewer, the last surface written against tickets, opens its stream the same way.
- **Admission is a cheap check in front of the expensive one.** A socket's hello costs the daemon a
  key agreement and a signature before anything is known about the caller, so the upgrade is admitted
  first: at most **30 admitted upgrades a minute from one peer address** (a refusal spends none), at
  most **2 unproven sockets per remote address** (the host's loopback is exempt: every tab on it shares
  one), and at most **16 unproven and 64 direct sessions** in all — a full cap closes the OLDEST
  unproven socket for the newcomer, so a squatter must out-race honest arrivals. The per-address exemption for the host's own tabs applies only on a host-proven carrier (a loopback-only bind): behind a proxy on a wildcard bind, every remote caller arrives from `127.0.0.1` and shares one bounded address. Declared: a proxy in front of a loopback-only bind still shares the exemption, so that deployment is exposed to a cheap denial of direct sessions (the relay is unaffected). The slot is taken when the upgrade is
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
  last five minutes — trusted input the browser raised, never a script's. A page that only loaded (a
  restored tab, a launch at login, a reload) is not a person (`packages/pwa/src/lib/presence.ts`).
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

### B1. The unlock: everything needs it, and it lasts N hours

**Owner decision (2026-10-14), which replaces the per-act step-up as the default:** "once we unlock the
app with a passkey, feel free to do anything (including start sessions)". It trades a prompt per
dangerous act for one prompt per machine per unlock period, and it is chosen for friendliness, with the
cost stated below.

- **Before an unlock, a device can do nothing.** A governed caller (every caller but the host's admin
  token — a browser on the host included, B4) whose device has not unlocked this machine within
  `unlockValidityHours` is answered `401 { code: "unlock_required" }` on EVERY request and every stream
  open, by the shared authorization boundary. The only routes served are the ones a device needs to get
  in: `POST /v1/unlock/options`, `POST /v1/unlock`, `GET /v1/passkeys`, `GET /v1/security`, and passkey
  registration within its own rules (B2). Pairing redemption is not a session route and is unaffected.
- **An unlock is one passkey assertion**, verified by the daemon exactly like a step-up (B2), held in the
  daemon's memory for the **device** — every page and tab of it — for `unlockValidityHours` (default 8,
  1–24). A restart, a revoke or the period ending locks the device again.
- **While unlocked, the device may do anything its grants allow, with no further prompt** — terminals,
  files, secrets, settings, starting sessions with any flags, mode or directory. The unlock IS the
  step-up for its whole validity: every demand below that needs a step-up is satisfied.
- **Except adding access, which always asks** (owner decision 2026-10-14, closing R2-M2). Minting a
  pairing code (`POST /v1/pair/code`) and widening another device's grants want a passkey proved FOR
  THAT ACT — within a challenge's lifetime (two minutes) and spent by it, so one confirmation adds one
  device — even inside an unlock and even with `stepUpOnActions` off. Neither the unlock nor a step-up
  merely inside its window counts. The refusal is `403 grant_step_up_required` with `demand.act`
  (`add-device` / `widen-device`), so the prompt names the act. The machine itself (the admin token
  over loopback) is never asked.
- **The per-act step-up remains as an option** (`stepUpOnActions`, off by default). When the owner turns
  it on, the acts below ask for a passkey again inside an unlock, for `stepUpWindowMinutes`. A machine
  with the unlock turned off always asks per act.

The acts a per-act step-up covers, when it is asked for:

| act                                                        | route demand                      |
| ---------------------------------------------------------- | --------------------------------- |
| open, attach to, or write to a terminal                    | `terminal.use`                    |
| write to a session's files, register a project             | `filesystem.configure`            |
| use a secret (runs a command), set or delete one           | `secrets.use/configure`           |
| any `fleet.configure` act (apply, sign-in, setup, clone …) | `fleet.configure`                 |
| change grants (daemon-wide or a device's)                  | `grants`                          |
| mint a pairing code (always, fresh), revoke a device       | `pairing.use`                     |
| browser control, warden configuration                      | `browser.use`, `warden.configure` |

The rule is one line in the dispatcher: **a route whose capability demand is `*.configure`, or is
`terminal.use`, `secrets.use`, `browser.use` or `pairing.use`, requires a step-up from a governed
caller** — and a current unlock is one unless `stepUpOnActions` is on. A refusal is
`403 { code: "grant_step_up_required" }`, which the app answers by raising the passkey prompt and retrying
once.

Starting an agent with your own flags, mode or directory is covered by the unlock (owner decision
2026-10-14).

**What this costs, said plainly.** A stolen phone that is **unlocked and inside its unlock period** can do
everything the owner could do from that phone until the period ends — open a terminal on the host, use a
secret, start agents — but not pair another device or widen one, which ask for a passkey every time. The per-act model stopped such a phone at its next dangerous
act; this one does not. The controls are: the unlock period (shorten it), `stepUpOnActions` (turn the
per-act prompt back on), and **revocation** — revoking the device ends every session it holds and every
unlock at once, from the machine or from any other device.

- **A start that is a terminal in disguise is decided as one** (review R2-H1). `POST /v1/sessions` with
  harness flags of its own, or with a working directory outside every registered project and the
  managed-worktree root, is a `terminal.use` act: covered by the unlock under the defaults, and asked
  per act when `stepUpOnActions` is on or the unlock is off — exactly as opening a terminal is. A plain
  start in a known project asks for nothing more. The prompt names it ("open a terminal").

### B2. The ceremony, and who verifies it

The **browser performs** the WebAuthn ceremony; the **daemon is the verifier**. The relay carries
only sealed records and can neither forge an assertion (it has no authenticator) nor replay one (the
challenge is single-use and bound to one device and `appSession`).

- Registration — `POST /v1/passkeys/options` → `{ challenge, rp: { id, name }, user, pubKeyCredParams }`,
  then `POST /v1/passkeys` with the attestation (`clientDataJSON`, `attestationObject`). Attestation
  format `none`; ES256, EdDSA and RS256 credentials are accepted. The daemon stores the credential
  id, its public key (as SPKI) and `signCount` on the device's record.
- Unlock — `POST /v1/unlock/options` → `{ challenge, rpId, allowCredentials }`, then `POST /v1/unlock`
  with `credentialId`, `clientDataJSON`, `authenticatorData`, `signature` (B1). The ceremony a device
  meets first, so an overdue device key is replaced here too (B6).
- Step-up — `POST /v1/step-up/options` and `POST /v1/step-up`, the same shapes on their own challenge,
  asked only when the machine wants a per-act confirmation inside an unlock (`stepUpOnActions`) or has no
  unlock at all.
- The daemon checks, in order: the challenge is one it issued to this device and `appSession`,
  unexpired (2 minutes) and unspent, and it is spent now; `clientData.type` is `webauthn.create` /
  `webauthn.get`; `clientData.origin` is one of the daemon's `corsOrigins`; `rpIdHash` equals
  SHA-256 of that origin's host; flags **UP and UV** are set; the credential belongs to this device;
  the signature verifies over `authenticatorData ‖ SHA-256(clientDataJSON)`; and, when either
  counter is non-zero, `signCount` increased. The counter is written by ONE compare-and-set inside the
  passkey store's serialized write, so two copies of the app that verified against the same stored count
  cannot both land and the later one cannot rewind it. A stuck, rewound or out-raced counter refuses
  (`not-verified`) and is written to the grant journal as `passkey.counter-refused=<deviceId>` until the
  audit log (C) lands.
- Issued challenges are swept on every issue: an unanswered one lives at most its two minutes, so a
  device that opens a session per fresh `appSession` and asks once cannot grow the ledger without bound.
- A verified **unlock** is held by the daemon for the `deviceId` — every page of it — for
  `unlockValidityHours` (8 by default), and **survives a daemon restart** (owner decision 2026-10-21: "we
  don't need to authenticate every time the daemon updates"): `state/unlocks.json` keeps the device id and
  the instant, nothing else, bound to the daemon identity. A verified per-act **step-up** is held in memory
  for `(deviceId, appSession)` for `stepUpWindowMinutes` (15 by default). Both end early on revoke; a
  step-up also ends on a restart and when the page closes (a new `appSession`). Neither is a value the
  browser holds.
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
device that already has access, or ask the owner to run `fy passkey window <this device>` at the
machine." Never a raw
`NotAllowedError`.

**Who may register a passkey**, because a thief holding an unlocked, open app — or code running in the
page — must not be able to add their own: (a) a device with **no passkey yet, within 10 minutes of
pairing** — the moment the owner is holding it; (b) a device that **already holds a passkey, by
confirming with it in the same ceremony**; (c) a device whose window **the owner re-opened at the
machine** with `fy passkey window <device>` — ten minutes, one passkey, audited (B4). Lost every passkey?
That last path recovers it without pairing again. `PasskeysView.registration` reports which applies:
`first-window`, `confirm-existing`, `reopened` or `closed`.

**Adding a second passkey is its own ceremony** (review M3). With attestation `none` nothing in a
registration proves an authenticator exists: page code (XSS, a malicious deploy) can make a key pair with
WebCrypto and build `clientDataJSON` and the attestation itself, UP and UV flags included. What it cannot
build is a signature by a passkey this daemon already holds. So for rule (b):

- `POST /v1/passkeys/options` answers the registration options **and** `confirm` — step-up-shaped options
  whose challenge is issued for this registration only: purpose `register-confirm`, single-use, two
  minutes, bound to `(deviceId, appSession)` and to this registration's own challenge. Asking again
  replaces both, so a confirmation from an earlier options call is refused.
- The app runs the assertion, then the creation, in one press of **Add a passkey**, and sends
  `POST /v1/passkeys` with the new credential plus `confirmation` (the assertion). The daemon spends both
  challenges first, then verifies the confirmation exactly as a step-up (this device's credential, its
  origin, UP and UV, the counter's compare-and-set), and only then the new credential.
- A missing, stale, wrong-purpose (a step-up's challenge) or other-device confirmation answers
  `not-verified`. **Holding a step-up opens nothing**: it is not one of the rules.

**A registration is never a step-up.** It used to grant one, on the reasoning that the authenticator had
just verified the person; but a registration proves nothing about the person (above), so a first-window
registration from page code was a step-up with no real user verification. Now an act straight after
registering asks for a step-up like any other act.

**Declared: the two windows have nothing to bind to.** Rules (a) and (c) carry no `confirm`, because the
device holds no usable passkey yet. Page code present in the page during the ten minutes after pairing, or
during a window the owner re-opened, can still register a software passkey and step up with it later
without the owner. The windows are short and the owner opened each one.

**An added passkey is announced.** Every registration is written to the grant journal as
`passkey.added=<deviceId>`, and the daemon sends one notification ("A passkey was added — ‹device› has a
new passkey for this machine. If that was not you, revoke the device at the machine.") to every enrolled
browser through the existing push path. It is best effort: a notice that cannot be delivered never undoes
the registration. A device that never enrolled for notifications is not told; the audit-log alert path
(C) is where a durable alert belongs.

**A credential belongs to exactly one device.** A step-up only accepts a credential stored for the device
whose session presents it, and a registration refuses a credential id ANY device already holds. So a
synced passkey (iCloud Keychain, Google Password Manager) that lands on a second phone cannot step up
that phone, and a device that learned another device's credential id cannot re-register it and take the
passkey over.

**As built** (`feat/zt-passkey-ui`), the app's side of registration:

- **Settings → Daemons → Security** is one panel per machine (`#security` deep-links to it, and the
  palette lists it). It shows the passkeys this device holds for that machine as "Passkey for
  ‹origin›, added ‹date›", says what a step-up is for in one sentence, and offers **Add a passkey**,
  which runs the registration ceremony above against the app's own origin and re-reads the list.
- **The button is offered only when it would work**: the machine reports `registration` other than
  `closed`, and the browser can run WebAuthn at all (the API exists and the page is a secure context).
  For `confirm-existing`, one sentence beside it names the machine and says the add starts with a
  confirmation by a passkey this device already holds. Otherwise one sentence says why — the ten-minute
  first-passkey rule and `fy passkey window`, or that this address cannot hold passkeys. Every refusal and ceremony failure is one
  plain sentence; no status or error name reaches the screen.
- **After pairing**, a device with no passkey for a machine sees one dismissible line pointing at that
  panel. It is read once per machine, never polled, hidden on Settings itself, and not shown when
  registration is `closed`, because a line pointing at a dead end is worse than none. Dismissal is
  remembered per machine in `localStorage`; storage that throws means the line may return next load.
- **The prompt names the machine and the act.** A `403 grant_step_up_required` (and a socket upgrade
  refused for a step-up) also carries `demand: { capability, axis }` — the closed pair, never a path or
  a session name — and the app turns it into one sentence: "Confirm with your passkey to open a terminal
  on ‹machine›." A missing or unparseable demand says "make this change" instead, never a blank.
  It names the act; it does not prove the person started it — code in the open page can still ask.
- **Not built, because the daemon has no route or field for it**: a passkey's name, its last use, and
  removing one passkey. `PasskeyView` is id, origin and created-at. Revoking the device still forgets
  all of its passkeys.
- **Not exercised end to end**: the prompt answers `403 grant_step_up_required`, and no governed route
  on this branch issues that refusal yet (B3's grant work does). The app's reaction is unit-tested; a
  real authenticator ceremony is not — the tests use a software authenticator on the daemon side and a
  fake credential container in the app.

**Stored passkey proofs.** Every other step-up is spent and forgotten. A standing sign-in rule
(`approve-sign-in-rule`, the one act in `STEP_UP_ACTS_STORED_PROOF`) is different: its record keeps the
owner's assertion for as long as the rule lasts, so the daemon can check it again later, offline, against
the passkey registry. Four things make that safe:

- **The challenge is derived, not random.** `POST /v1/step-up/options { act: 'approve-sign-in-rule',
subject: srs_… }` issues `signInRuleChallenge(nonce, signInRuleSubject(stage, canonical))`: the rule
  service draws the 32-byte nonce from the system CSPRNG when it stages the body, and the subject commits
  to the body's canonical bytes. So the assertion signs over exactly what the owner approved. The service
  takes this challenge as an argument for a stored-proof act and refuses one for every other act; it must
  be 32 bytes. The mount asks the rule service for the stage's challenge **for the session's own
  device** (`challengeOf(stage, deviceId)`), so a stage is answered only to the device it waits on: another
  paired device that learns an `srs_` id gets no challenge. A stage that isn't waiting, or isn't waiting
  for this device, answers `404 stage_not_found` and no challenge is made. Until the rule service exists
  (R3c-3), no stage is ever waiting.
- **The live ceremony is unchanged.** The counter must move, the origin must be allowed, UV must be set,
  and an overdue device key is rotated. A stored proof is a good live proof first. The daemon then keeps
  the evidence beside the bound grant: `{ deviceId, credentialId, clientDataJSON, authenticatorData,
signature }`, the bytes exactly as verified, never the rotation, together with the challenge it was
  verified against. What a challenge is for (an act, a bound save, or a kept proof) is fixed when it is
  issued and travels with it, so a stored-proof ceremony always keeps its evidence or is refused.
- **It is claimed once, by its own claim, for its own bytes.** The commit route takes it with
  `claimStoredProof(act, stage, expectedChallenge)`: once, within the challenge's 120 s, for that act and
  that stage on that copy of the app, and only when `expectedChallenge` (which the commit derives again
  from the very bytes it is about to write) equals, in constant time, the challenge the ceremony verified.
  A wrong challenge is handed nothing and spends nothing. So evidence over other bytes never reaches a
  commit, whatever the commit forgets. The every-caller claim (`claimFreshStepUp`) never takes a stored
  proof, and `claimStoredProof` never takes any other proof. So a rule's evidence can't be spent as a
  step-up, and a step-up can't be stored as a rule. A caller with no paired device (the admin token) holds
  none.
- **The offline re-check skips only the counter.** `verifyStoredAssertion` (`passkeys/verifier.ts`)
  still requires `webauthn.get`, the challenge, an origin equal to the **passkey's own** origin (not
  today's `corsOrigins`), the rpId hash, UP, UV and a valid signature. `StepUpService.verifyStoredProof`
  first asks whether the proof's device is **still paired**, then looks up the credential on that device
  in the registry as it stands now. So an unpaired device, a removed passkey or a forgotten device fails
  it, even when a revocation's passkey purge failed and left the passkeys on file. A passkey is never
  replaced under a known credential id either (the store refuses the duplicate), so what a kept proof is
  checked against can't change quietly. The counter is not checked because a kept assertion is the
  same bytes every time: its counter can never move again, and checking it would refuse every rule after
  the owner's next tap. Replay is not the risk the counter guards against here, because the derived
  challenge only verifies against the bytes it was made for, and nothing that checks a stored proof
  grants a live step-up. **Never use it for a live ceremony**; a live ceremony still refuses a counter
  that did not move.

**The passkeys-changed signal.** When a device is forgotten (revoked, its passkeys with it), or a
catalog member's key is (one browser removed, or the whole member revoked: every key goes), the daemon
emits `PasskeysChangedSignal` once the passkeys are gone. Whatever keeps a stored proof subscribes and
checks every proof again (R3c-3: the rule service, suspending `passkey-removed`). Listeners run at once
and the removal waits for them for at most 5 s; a listener that fails, or is still running then, is
reported and never undoes or stalls the removal. A device revocation attempts every owner's purge even
when an earlier one fails, records the revocation, then reports each failure. A stored proof is
re-checked before every use anyway, so a missed signal costs a later refusal, never a fill. Today nothing
subscribes. A member's passkey can't back a rule; the signal fires for it only so "a passkey was removed"
is one signal whichever route removed it.

**Declared: a stage's challenge is fixed.** Asking for options twice for one stage issues the same
challenge, because it is derived from that stage. An assertion captured from the first ceremony and
replayed against the second, from the same copy of the app, buys a proof for exactly the same bytes and
stage, so nothing is gained. The rule service drops a stage when it is committed, denied or expired, so a
committed stage is never offered again.

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
  biometric check within the current unlock" (B1), which is weaker against a replayed request and stronger against
  a known password — and replay is no longer possible inside a sealed session anyway.
- ~~**A declared GAP:** `pairing.use` also guarded the four `/v1/push/*` enrolment routes.~~ **Closed by B5:**
  a device enrolling itself needs no capability. It does need a step-up (review M2, below).

### B4. Only the owner's admin token is ungoverned, and it is the recovery path

**Owner decision (2026-10-13): "at the machine" means ONLY a caller presenting the owner-only local
credential** — the CLI with the admin token, over loopback. That caller is ungoverned: no step-up, no
per-device narrowing. Reading the token needs this machine's disk, so somebody presenting it already has
the machine.

**A browser on the host is an ordinary governed device**, even on a loopback-only bind. `ssh -L`, `socat`,
`cloudflared`, `tailscale serve` or any reverse proxy to `127.0.0.1` is indistinguishable from it, so
treating it as the owner would hand the machine to anybody who can open a tunnel. It pairs like any device
and confirms the dangerous acts (B1) with a passkey; it can never widen a grant or a setting.

The recovery is at the machine, with `fy`: a lost phone or a device narrowed to nothing is repaired with
`fy` commands, and a device that missed its first-passkey window or lost its authenticator gets
**`fy passkey window <device>`**, which re-opens that one device's registration window for ten minutes
and one passkey (`POST /v1/passkeys/registration-window`, admin token only, audited in the grant
journal). Without it a local browser past its first window would be locked out of every dangerous act.

As built:

- `arrivedOnHost(request, adminToken) = adminToken && request.loopback` (`packages/daemon/src/lib/api/http.ts`).
  Every owner rule reads it: governance, widening a grant or a security setting, and the passkey recovery.
- `privilegedLoopback` survives only for the PLACE: `privilegedOnly` routes (a local terminal attach) read
  `arrivedPrivileged` = `privilegedLoopback || arrivedOnHost`, and nothing it admits grants authority.
- `PasskeysView.registration` lost `host` and gained `reopened`.
- The device list's `hostLocal` reads `arrivedOnHost` too; it used to read the bare loopback flag, which
  told a caller behind a local proxy it was at the machine.

### B5. Least-privilege defaults

Grants become **per device**, on top of the daemon-wide document:

```
effective(device, capability, axis) = daemonWide[capability][axis] ∧ device.grants[capability][axis]
```

- **A newly paired device gets FULL grants, behind the unlock** (owner decision 2026-10-14, which
  replaces the `fleet.use`-only default this section first specified). It can do nothing until it
  unlocks the machine (B1), and then anything the daemon-wide document allows. Narrowing one device is
  still available: `fy pair --limited` mints a code whose device holds `fleet.use` only, and any device
  can be narrowed afterwards.
- A **seventh capability, `secrets`**, is added: `secrets.use` governs `POST /v1/secrets/use` (it
  runs a command — code execution) and the list; `secrets.configure` governs set and delete. Today
  those routes carry no capability demand at all, so any paired device can run a command through
  them; that is closed. The "before you add capability seven" questions in grants.md are answered in
  the same PR.
- **Widening a device** is done at the machine (`fy device grant <device> <capability> --use`; a browser
  on the host is a device like any other, B4), or remotely by a device that holds `pairing.configure` **and** the capability being
  granted **and** a current step-up. No device can grant what it does not hold, so nothing escalates.
- **Narrowing** a device (including oneself) needs a step-up and nothing else — never harder than
  widening.
- The daemon-wide document keeps its asymmetry unchanged: a remote caller may switch a capability off
  for everyone and can never switch it back on.
- Web Push self-enrolment moves off `pairing.use`: a device enrolling **itself** for notifications is
  allowed for every paired device (it grants nothing), so a default device still gets alerts.

**As built.**

- **`secrets` is the seventh capability** (`DAEMON_CAPABILITIES`). `GET /v1/secrets` and `POST /v1/secrets/use`
  demand `secrets.use`, which also needs a step-up from a governed caller (it runs a command); `POST
/v1/secrets` and `DELETE /v1/secrets/:name` demand `secrets.configure`. grants.md answers the
  capability-seven questions.
- **Per-device grants** live in each `devices.json` record as `grants`. The document stays at
  `schemaVersion: 2`: a record written before B5 reads as the default, which is a narrowing and therefore
  safe. A device's grants reach the boundary through the live registry (`PairedDeviceDirectory.grants`),
  keyed by the session's proven device; the dispatcher puts them on the `CapabilityPresentation`, which now
  rides on every authenticated `RouteContext`, so no mount re-derives a caller. A device whose record is
  gone is refused `undetermined`. The device half refuses with `device-not-granted`
  (`grant_device_not_granted`), asked after the daemon-wide half.
- **The default device holds every capability** (`FULL_DEVICE_GRANTS`, owner decision 2026-10-14), gated
  by the unlock. **`fy pair --limited`** mints a code whose redemption grants `LIMITED_DEVICE_GRANTS`
  (`fleet.use` only); the mint request is `{ grants: "limited" }`, and the default is `full`.
  `fy pair --full` (owner decision 2026-10-13) is removed: it is the default now. A remote mint of a
  `full` code is refused `403 grant_forbidden` unless the minting device holds every capability itself
  (the same `mayWiden` rule a device widen reads), so no device can pass on more than it holds; at the
  machine anything goes. The pairing service keeps the choice with the live code — the link carries
  nothing extra. A `devices.json` record written before B5 still reads as `limited`.
- **Changing one device** is `PATCH /v1/pair/devices/:deviceId/grants` (demand `pairing.use`), judged by
  `judgeDeviceGrantChange` in `src/lib/grants/policy.ts` and applied by `DeviceGrantService`: host —
  anything; any device (a browser on the host included) — a widen only of an axis the caller holds effectively (daemon-wide ∧ its own) and only
  with `pairing.configure`; every remote change needs a step-up; a patch with one illegal widen is refused
  whole before any step-up is asked. `configure ⇒ use` is kept true of the result. A change is written to
  `devices.json` before the live registry, calls `recheckAll` so open streams are re-asked, and is audited
  in `state/grant-audit.jsonl` as `<deviceId>/capability.axis=on|off`. At the host: `fy device ls` and
  `fy device grant`. In the app: a per-device Capabilities disclosure with a toggle per axis, disabled with
  its reason where `PairedDevicesView.mayWiden` says the caller may not widen.
- **Web Push self-enrolment** needs no capability: a device reads the key, lists and un-enrols its OWN
  enrolments freely, and enrols itself with a step-up — which the unlock is, unless the owner asked per act. Another device's enrolments are behind `pairing.use`,
  decided by the same guard.
- **Enrolling is a request the HOST makes** (review M2): the daemon POSTs to the endpoint at once and on
  every alert, from its own network position. So:
  - the endpoint must be a browser push service on its default port (`PUSH_SERVICE_HOSTS`: FCM, Mozilla
    autopush, `*.push.apple.com`, `*.notify.windows.com`), never an IP literal, a private range or a
    metadata address;
  - an endpoint another device holds is refused, never re-filed under the caller;
  - the answer never reports whether the confirmation push was accepted — that would be a reachability
    oracle — and a subscription the push service has discarded is dropped by the ordinary delivery path;
  - a governed device confirms with its passkey before it enrols.
    Declared cost: a browser whose push service is not on the list cannot enrol.
- **A race closed on the way:** a sighting's `lastSeenAt` refresh and a grant change each used to
  re-insert the record they read before their write, so the second to land could undo the first in memory;
  both now refresh the latest record.
- **Not built:** naming a device by its untrusted display name inside a refusal (the remedy names
  `<device>`), and a grant set other than `full` and `limited` for a code.

### B6. Per-daemon security settings

Owner decisions (2026-10-13, and 2026-10-14 for the unlock). One **Security** section per machine — in the
app's Settings for that machine, and `fy daemon security` at the host — holds the knobs below. Each has a
default and hard bounds; a value outside the bounds is refused, never clamped.

| Setting                 | Default    | Bounds                   | Narrower means |
| ----------------------- | ---------- | ------------------------ | -------------- |
| `unlockOnOpen`          | **on**     | on / off                 | on             |
| `unlockValidityHours`   | 8          | 1–168 (one week)         | smaller        |
| `stepUpOnActions`       | off        | on / off                 | on             |
| `stepUpWindowMinutes`   | 15         | 0–60 (0 = every time)    | smaller        |
| `deviceKeyRotationDays` | 30         | 7–90                     | smaller        |
| `idleExpiryDays`        | 30         | 1–90                     | smaller        |
| access lease            | 15 minutes | **fixed, not a setting** | —              |

- **Unlock on open** (B1). On by default: a device does nothing until it unlocks this machine with a
  passkey, and then may do anything its grants allow for `unlockValidityHours`, across page loads. **The
  unlock IS the step-up** for its whole validity — a deliberate reversal of the first version of this
  section, which said a confirmation on opening never counted as one.
- **Ask again for each change** (`stepUpOnActions`). Off by default, so the unlock covers every act.
  When on, the acts B1 lists ask for a passkey again inside an unlock, and each confirmation lasts
  `stepUpWindowMinutes` for one `appSession` (`0` asks every time). A machine with the unlock turned
  off always asks per act, whatever this says.
- **Device-key rotation.** The `authenticated` and `stream-opened` records carry `rotateBy`. Once it
  has passed, the next passkey ceremony — the unlock, or a step-up — also rotates the key: the browser
  mints a new non-extractable key, the daemon receives `{ deviceKey, proof }` where `proof` is the NEW
  key's signature over `"ferretry-device-rotate-v2" ‖ 0x00 ‖ TH ‖ LP(deviceId) ‖ LP(deviceKey)`, inside a
  session the OLD key opened, together with the assertion. The daemon swaps the SPKI, closes the device's
  other sessions with `4441` (so they reopen with the new key), and audits `device.key-rotated`. The old
  key then opens nothing. No extra prompt exists for this: an overdue device cannot finish the ceremony
  without rotating in it. Lost answer: the browser stores the new key as _pending_ before sending and, if
  the old key is refused, tries the pending one once — so a dropped response never strands the device.
- **Idle expiry.** A6's 30 days, now a setting. Shortening it applies at the next check (boot, auth,
  device list), so it can expire devices immediately; the confirmation says how many.
- **The access lease stays fixed at 15 minutes**, deliberately. Renewal is silent, so a longer lease
  buys a person nothing and only widens how long a revoked or expired device's open channel lives; a
  shorter one costs renewals without a security gain worth a knob. Fixed is simpler and safer.

**Who may change them — the grants.md asymmetry, again.** Changing any setting is a _configure_
action on the `pairing` capability.

- **Narrowing** (a smaller window or period, a switch turned ON) is allowed remotely by a device
  holding `pairing.configure` **with a current step-up** — which the unlock is, unless the owner asked per
  act.
- **Widening** (a larger window or period, a switch turned OFF) is allowed **only at the machine** —
  the owner's admin token over loopback, i.e. the CLI (B4); a browser on the host is a device like any
  other. A remote widen is `403` with a sentence naming the command to run at the machine.
  **Except** `unlockValidityHours` (owner decision 2026-10-21): a device may raise it with a passkey proved
  for that one change (`loosen-security`), applied at once and journaled — [grants.md](../grants.md) owns
  the rule.
- A request that changes several fields is judged field by field and refused whole if any field
  widens remotely.
- Where it lives: `<FY_HOME>/state/security.json` (`schemaVersion: 1`, written atomically, mode
  `0600`). An unreadable or invalid document **fails closed to the narrowest reading** with a notice
  naming the file, never to "off".
- Every change is audited as `security.changed` with the field, old value, new value and actor.

Tests: each bound accepted at its edges and refused one past them; each field's widen refused
remotely and accepted at loopback; narrow refused without a step-up and accepted with one; a mixed
request refused whole; before an unlock nothing but the exempt routes, after it everything with no
further step-up; the unlock lapsing at its validity; a per-act window that is turned on asking again;
rotation end to end; a stream ending at its renewal once the unlock lapsed; the corrupt-document
fail-closed path; and the audit record for every change.

**As built** (`feat/zt-security-settings`, PR E):

- **Contract.** `@ferretry/protocol` `security.ts` owns the fields, bounds, defaults, the patch and view
  schemas, `widensSecurity`, `isSecuritySwitch` and `asksStepUpPerAction`, so the daemon, `fy` and the
  app agree on what "narrower" means and on when a per-act step-up is asked. `GET /v1/security` answers
  `{ settings, source, mayWiden, widenCommand, updatedAt? }` to any paired caller, before an unlock too;
  `PATCH /v1/security` demands `pairing.configure` and answers `{ view, devicesExpiring }`. A remote widen
  is `403 security_widen_at_machine` naming `fy daemon security set <setting> <value>`; an out-of-bounds
  value is `400`. "At the machine" is `arrivedOnHost`, the one host-locality rule (B4).
- **Store.** `state/security.json`, `schemaVersion: 1`, atomic write, mode `0600`. Read once at boot; the
  service is then synchronous, so no enforcement waits on a file. A missing file is the defaults.
- **Damaged document — one deliberate departure from the spec text.** It fails closed to the unlock on
  for 1 hour, a per-act confirmation every time on top (`stepUpOnActions` on, window `0`) and rotation 7
  days, with a boot notice naming the file. Idle expiry is **kept at the default**, not shortened to 1
  day: the narrowest reading would unpair every device a day after a corrupted file, and an unpairing
  cannot be undone. A remote caller cannot patch a damaged document (`503 security_unavailable`); the
  host replaces it.
- **Audit.** `state/security-audit.jsonl`, one `security.changed` record per change with
  `security.<field>=<old>-><new>` and the actor, an empty change included, and one `device.key-rotated`
  record per rotation. Its own file, so the grant history reader is unchanged.
- **The unlock.** The shared request boundary answers every request of a governed device
  `401 unlock_required` until that device unlocks. Exempt (`unlockExempt` on the route): `GET /v1/passkeys`,
  `GET /v1/security`, `POST /v1/unlock/options`, `POST /v1/unlock`, and passkey registration
  (`POST /v1/passkeys/options`, `POST /v1/passkeys`), which keeps its own rules (B2) — a freshly paired
  device holds no passkey, so registering one is how it gets in. A stream open is refused the same way, because both route tables share the boundary. An unlock is
  held per **device** for `unlockValidityHours`, so it survives page loads and a daemon restart (see the
  unlock ledger above) and ends when it lapses or on a revoke. Registering a passkey grants no unlock and no step-up (review M3: code in the
  page can forge an attestation): a new device registers its first passkey, then unlocks with it. Every
  browser is asked, on the host too (B4).
- **The unlock is the step-up.** `StepUpService.held` — the witness the boundary asks — answers yes for a
  device inside its unlock unless `asksStepUpPerAction` (the owner turned `stepUpOnActions` on, or the
  unlock off), so every step-up-gated act is served with no further prompt. `spend` never spends an
  unlock. An unlock also records a per-act step-up for its `appSession`, so a machine that asks per act
  does not ask again for the act that follows the unlock at once.
- **Per-act window.** `StepUpRegistry` reads the window at every question, so a shortened window applies
  to step-ups already held. `0` makes a per-act step-up single-use: the boundary spends it when it admits a
  step-up-gated act (`GrantDecision.steppedUp`), and `PATCH /v1/grants`, which checks its own step-up,
  spends it through `RouteContext.spendStepUp`. An unspent single-use step-up lives two minutes, enough
  for the app's one re-send.
- **Streams lapse at their renewal.** `ApiSocketDispatcher.reauthorize` — asked at every lease renewal
  and grant change — keeps the step-up that admitted the stream standing but re-asks the unlock, so a
  stream whose device's unlock lapsed ends with the sealed `1008` at its next renewal (at most 15 minutes
  later), and the device reopens it after unlocking again.
- **Idle expiry.** `PairingService` reads `idleExpiryDays` at every check, so a shortened period applies
  at the next boot, session proof or device list; the pairing response reports the current value.
  `devicesExpiring` counts the devices the new period will end, and only when it shortened.
- **Rotation.** `authenticated` and `stream-opened` carry `rotateBy` (key age counted from the last
  `keyRotatedAt` on the device record, or from pairing). Past it, `POST /v1/unlock` or `POST /v1/step-up`
  without a `rotation` is `403 step_up_rotation_required` **without spending the challenge**, so the
  browser can answer the same challenge again with a new key. One shared ceremony checks the new key's
  proof over the carrying session's transcript before the assertion is verified; after it verifies, the
  daemon rewrites the device's key, ends the device's other sessions with `4441`, keeps the carrying
  session, audits `device.key-rotated`, and answers `keyRotated: true`. The label and message builder are
  `deviceRotateMessage` in `@ferretry/relay`.
- **Not exercised end to end:** a real authenticator; a real browser rotating its key against a real
  daemon; an unlock on a machine reached only through the hosted relay. Each half is unit-tested against
  the other half's contract.
- **Declared gap:** the app raises the unlock screen only for a refused **request**; a refused stream open
  is reported as a refusal, and the screen appears with the page's next request, which every page makes
  first.

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
  line, so a prompt nobody asked for must be refused. Its authority does NOT end when the tab closes: the
  unlock is held per device across page loads (owner decision), so a malicious deploy or XSS on any
  later load within `unlockValidityHours` acts with full access and no new biometric. This is the cost
  of "unlock once": shorten the validity, turn `stepUpOnActions` on, or revoke the device (R2-M1).
- **A first passkey is unattested.** In a new device's ten-minute first window, page code could register
  a software credential (`fmt: none`, user verification claimed by software) and unlock with it from
  then on, with no real biometric. This is inherent to an unattested web passkey; the `passkey-added`
  push tells the owner's other devices (R2-L1).
- **A dispatcher built without the step-up service is open on the unlock** (`NO_STEP_UP_WITNESS`). It
  is for surfaces that serve no device; the mounted dispatchers are given the real service, by type
  (R2-L2).
- **A compromised Pages deploy, on first install or via a new service worker** — see D. A deploy is
  trusted the way any website is, once.
- **A host that answers the browser’s own worker-install request differently from a plain fetch.**
  The release-integrity check reads the worker script with an ordinary fetch; a deploy that serves a
  different script to the browser’s install request bypasses the alarm.
- **Code running in the open app rewriting the pinned release key** in IndexedDB. The pin is only as
  strong as the app that holds it.
- **An unlocked phone in a thief's hand with a machine unlocked**, for everything but adding access,
  until the unlock period ends (B1): terminals, secrets, files, starting agents. Chatting with an agent that
  has tool permissions is **code execution by proxy** too; least privilege does not change what an agent already allowed to act will do when asked.
  Revoke the device first.
- **The 30-day idle window.** A device used at least once a month never expires; revocation is the
  control for a lost device, and the new-device alert is the control for an added one.
- **Somebody at the machine.** The host's admin token is ungoverned by design (B4), so anybody who can
  read it — anybody at an unlocked keyboard — has the machine. A browser or an SSH tunnel is not: both are
  governed devices.
- **Relay metadata.** A relay still sees fingerprint, IPs, timing and frame sizes
  (`relay-protocol.md` §10); this design hides the device id from it, nothing more.
- **Denial of service.** A relay can drop traffic; a guesser can spend a pairing code's relay budget.
- **Device posture.** No OS version, disk encryption or screen-lock check — that needs a native app.
