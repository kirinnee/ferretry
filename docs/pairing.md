# Pairing — how another device gets access to one machine

A Ferretry daemon serves exactly the devices it has been told to serve. Pairing is the whole of that
decision: a short-lived code is minted on one side, read by the device being added, and exchanged once
to register that device's own key. This document is the contract. Implement against it rather than
against the code, and change it in the same commit as the behaviour.

## The one-sentence version

The machine mints a code that lives for **two minutes** and works **once**; the device that reads it
registers a **key it generated and can never export**; the machine keeps only the public half, and the
grant ends when it is revoked or goes unused for its idle period — **30 days** unless the machine's owner
changed it. No bearer value exists anywhere — the
rationale and the threat model are [design/zero-trust.md](design/zero-trust.md) A1–A7.

## What travels, and what never does

| value              | where it lives                                            | who may read it                                         |
| ------------------ | --------------------------------------------------------- | ------------------------------------------------------- |
| pairing code       | the daemon's memory for its TTL, and one screen           | whoever is being shown the code                         |
| pairing id         | the mint response, and revoke URLs                        | anybody who may reach the pairing API                   |
| device private key | the redeeming browser's IndexedDB, **non-extractable**    | nobody — the browser will sign with it but never export |
| device public key  | `state/devices.json` (SPKI), and the sealed `pair` record | the daemon, to verify each session's proof against      |
| device id          | the device, and `devices.json`                            | names a grant; proves nothing on its own                |

Two properties hold by construction rather than by discipline:

- **There is no device credential to return.** A device proves its grant by signing each session's
  handshake transcript ([relay-protocol.md](relay-protocol.md) §14), so a captured record is worth
  nothing in any other session, and the daemon holds nothing a thief could replay. `PairedDeviceSchema` —
  the projection that crosses the wire — has no field for a key or a proof.
- **The code never enters a URL path or query.** Revocation is addressed by **pairing id**, which is a
  non-secret handle the mint answers with for exactly this reason: a URL reaches every access log in
  the path, and a code in a log outlives its two minutes. The pairing _link_ carries the code in a
  **fragment**, which is never sent in an HTTP request.

## The exchange

```
POST /v1/pair/code            (operator minimum, `pairing.use`)   → { pairingId, code, expiresAt, link+reach | refusal }
GET  /v1/pair/code/:pairingId (operator minimum, `pairing.use`)   → pending | redeemed | expired
DELETE /v1/pair/code/:pairingId (operator minimum, `pairing.use`) → the code's fate, never the code
(no route)                    a sealed `pair` record inside a session  → { deviceId, daemonId, daemonName, capabilities, carriers, idleExpiryDays }
GET  /v1/pair/devices         (operator minimum, `pairing.use`)   → who may reach this machine
DELETE /v1/pair/devices/:id   (operator minimum, `pairing.use`)   → the remaining list
GET  /v1/carriers             (authenticated minimum, no-store)    → { carriers } — the set, asked again later
```

**`operator` is the route's credential minimum, not an admin token.** Any credential but a warden's
meets it — a paired device's session included — which is what lets a browser, whose only grant comes
from redeeming a pairing code, add the second device. An `admin-token` minimum would have left that
journey where it started: on the command line. The narrowing that remains is the capability demand
beside it, and off the host that is the operator's to switch off.

**There is no public route on this surface at all.** Redemption is not an HTTP request on either
carrier: `POST /v1/pair` is deleted, and an app that still calls it is answered by nothing.

### Redemption is one sealed record, on whichever carrier reaches the daemon

The browser mints a fresh non-extractable Ed25519 key, then opens a **pre-auth session** — on the
daemon's own address first (`/v1/rendezvous/<daemonId>/client` on its listener), then on the rendezvous
its build discovered — and sends **one sealed `pair` record** carrying the code, its device name, the
public key and a signature by that key over this session's transcript, specified exactly in
[relay-protocol.md](relay-protocol.md) §14. The daemon is proved against the QR-pinned fingerprint
before the code is sent; there is exactly one attempt per session and one sealed outcome (`paired`
carrying the redemption response, or one generic `pair-refused`), then the session closes.

- **A bad proof is a wrong code.** An attempt whose signature does not verify spends one guess and gets
  the same uniform refusal, so the proof is not a second oracle.
- **The two carriers keep separate budgets** (below): a direct attempt is keyed by its peer address and
  spends the code's five direct guesses; a relayed one spends the relay budget.
- **The key is saved only after `paired`.** A refused or unreachable pairing leaves nothing in the
  browser. An attempt whose record left but whose answer never arrived is reported plainly, and a later
  refusal of the same code says the earlier attempt may have paired a device nobody holds and tells the
  reader to check the device list.
- **When every carrier fails, every leg is reported**, in plain words, one sentence each
  (`PairingUnreachableError` in `packages/pwa/src/lib/pairing-unreachable.ts`). A loopback direct
  address is called what it is: it means "this computer itself", so from another device it can never
  reach the machine. The relay leg says whether the machine is not connected to the relay, the relay is
  switched off or busy, or it could not be reached at all. When no relay was discovered, the sentence
  says so. Reporting only the first leg hid a failing relay behind a loopback dial that could never have
  worked. Sentences name a host and port only, never a path, so the fingerprint stays out of them.

What a relay operator can and cannot observe about a redemption is §10 and §13 of the same document:
fingerprint, client IP, timing and frame shape, and the fact that a first pairing happened — never the
code, the key, the minted device id, the device name, or the outcome of the exchange itself.

**What the device does next is ordinary.** The pairing session ends the moment its outcome is
sealed, so the browser reconnects proving the key it just registered and speaks the ordinary
authenticated request session — on either carrier — and opens a separate stream session per live
stream when it wants events or a terminal. Pairing is one exchange, and everything after it is the
product's normal traffic over whichever carrier the walk won.

### What a redemption hands back

The `paired` outcome carries `carriers`: **every way this daemon can be reached**, not merely the address
this device happened to pair over. A phone that learned only the direct address has nothing to fall back
on when it leaves the house, and it cannot discover a rendezvous by itself — each end used to read its own
build-time directory, so the two met only by coincidence of picking the same service.

The daemon resolves that set **once, at boot**, and hands the same value to this response and to the
refresh route below. Neither entry is a secret: a rendezvous address is already known to the rendezvous,
and a daemon address is already known to whoever was authorised to pair. The daemon **fingerprint** is the
secret in this subject and it is not on the list — the wire schema has no field for one. The full carrier
contract is [relay-protocol.md](relay-protocol.md) §13.

### What a new device may do

**A newly paired device can do anything on this machine — once it unlocks it with its passkey**
(owner decision 2026-10-14; [design/zero-trust.md](design/zero-trust.md) B1 and B5; [grants.md](grants.md)).
Before its first unlock it can do nothing but unlock and register its first passkey. Every unlock lasts the
machine's unlock period (8 hours unless the owner changed it), for every page of that device, and a revoke
ends it at once.

**`fy pair --limited`** mints a code whose redemption gives the device `fleet.use` only: it can read the
fleet and chat with sessions, and terminals, files, the browser, secrets, the warden, pairing and every
`configure` axis start off. A limited device is widened one capability at a time: by the owner with
`fy device grant <device> <capability> --use` (the admin token, the only ungoverned caller — B4), or from
any browser's Settings → Add a device toggles by a device that holds `pairing.configure` and the capability
it is giving.

- **A full code from another device is checked.** `POST /v1/pair/code` mints `full` by default; from a
  paired device it is refused (`403 grant_forbidden`) unless that device holds every capability itself,
  so no device can mint a code giving a new device more than it holds. At the machine anything goes. A
  limited code, `{ "grants": "limited" }`, can be minted by any device allowed to pair.
- **The code carries the choice, the link does not.** The daemon holds the grant set with the live code and
  applies it at redemption; the QR stays the one-version `v1` fragment, so nothing about what a code grants
  is visible to whoever reads it. A newer mint replaces the code and its choice together.
- **It is not a bypass.** The daemon-wide document still narrows the device, and the device still has to
  unlock before it can do anything. The mint answers `grants: "full" | "limited"`, so the host's screen says
  which it drew; a daemon too old to know `limited` echoes nothing, read as `full`, and `fy pair --limited`
  says it was not applied.
- **`fy pair --full` is gone**: it is the default now.

### Asking again — `GET /v1/carriers`

A set published only at pairing time goes stale while both halves stay healthy: an operator changes or
switches off a rendezvous, and the only repair a device has is to pair again. This route is the second
moment.

- **`authenticated`**, so any caller this daemon issued a credential to may refresh its own copy —
  including a paired device and the capability-scoped warden. One class higher would refuse the reader
  that needs it and protect nothing.
- **`no-store`**, because the entire value of the answer is that it is current. A cached copy re-serves
  the rendezvous the operator just switched off.
- **Not `privilegedOnly`, and no capability demand.** The owner's command line already has the machine
  and needs no list; a paired device — a phone, or a browser on the host — is the reader. And an operator who switches `pairing` off to stop **new**
  devices being added must not thereby strand the devices already paired on a rendezvous this daemon no
  longer dials.
- **Read-only.** There is no `POST`, `PUT` or `DELETE` here. A device may learn where this daemon can be
  reached and can never re-point it: that is a change to the operator's own document.

**The daemon is authoritative and a client's copy is a cache.** A client REPLACES its stored set with this
answer rather than merging into it — that is what makes both halves of a disagreement resolve, because a
relay the daemon dropped disappears instead of being dialled forever, and a relay the daemon added arrives
without anybody re-pairing. A merge would only ever fix the second.

**This route is not a way in.** It is reached inside a session the paired device key opened, on any
carrier. Pairing itself has a relayed form — the sealed record above, not a route — so first contact
does not require an address reachable on its own: a daemon that publishes a rendezvous is pairable by
a phone that can never dial it directly.

### Who may mint

Read [grants.md](grants.md) first: minting is governed by the `pairing` capability, so only **the owner at
the machine** — `fy pair` with the host's admin token — is ungoverned, and **every paired device**, a browser
on the host included, mints while the operator leaves `pairing` on (B4: a tunnel to `127.0.0.1` is
indistinguishable from a local browser). The two facts a UI needs before it offers anything — whether this
caller is the owner at the machine, and which grant is the caller's own — are on `GET /v1/pair/devices` as
`hostLocal` and `thisDeviceId`. `hostLocal` is `arrivedOnHost`, never the bare loopback flag, so a caller behind
a local proxy is never told it is at the machine. Since B5 a paired device also needs `pairing.use` in its
OWN grants, which a newly paired device holds unless it was paired `--limited`. Both are
carrier-derived and server-derived respectively; neither may be inferred in a browser.

The app mints from one panel, Settings → ‹machine› → **Add a device**, and opens that same panel from two
shortcuts: **Pair a phone with ‹machine›…** in the machine switcher at the top of the sessions bar, and
the same act in the finder. Both are offered only while `GET /v1/grants` reads this caller's `pairing.use`
as open or waiting only on a passkey; any other answer, or none, hides them, and Settings still explains
why.

### Minting needs no password

**`POST /v1/pair/code` asks for no secret.** The owner's `fy pair` mints freely. A **governed** caller — a
paired phone, a browser across the network or on the host itself — mints only while the operator leaves `pairing`
on **and** it has just confirmed **this mint** with a passkey — a proof at most two minutes old, spent by
the one code it buys. The unlock is NOT enough, and neither is a step-up merely inside its window, whatever
`stepUpOnActions` says (owner decision 2026-10-14, [design/zero-trust.md](design/zero-trust.md) B6). The
refusal is `403 grant_step_up_required` with `demand.act: "add-device"`, and the app answers it by raising
the passkey prompt — "Confirm with your passkey to add a device on ‹machine›" — and retrying once; a remote
warden has no device and can never mint. Widening another device's grants is held to the same rule
(`act: "widen-device"`).

There is no first-password requirement, because there is no password. What stops a stolen or unattended
phone from handing out more access is the passkey each mint asks for, not a secret that had to exist before
the first device did. An unlocked phone in the wrong hands cannot pair another device without its owner's
face, finger or PIN; revocation remains the control for everything else it can do inside its unlock.

What this deliberately does **not** do:

- **It does not gate local use.** A machine nobody has paired starts, serves and configures itself with no
  setup at all.
- **It does not govern redemption.** The code is the credential, redeemed inside a sealed session; the
  step-up guards the act of _creating_ a code, and the code's two-minute life bounds the rest.
- **It does not migrate anything.** A `state/operator-password.json` left by an older build is deleted at
  boot with one notice line, and nothing is revoked.

### Who may redeem

**Never mint a link without saying who can redeem it.** The advertisement decision has three answers,
and the mint response carries that answer rather than making each renderer infer it again:

- `reach: "any-device"` accompanies an address another device can dial. The command line and browser
  panel show the link and draw its QR.
- `reach: "local-only"` accompanies a loopback address, and describes the **direct** address alone.
  Alone, it means no QR: on a phone, loopback names the phone. Beside a `discoveredRelayUrl` it no
  longer means unredeemable — the QR is drawn, because another device can redeem the link through a
  rendezvous **it discovers for itself** — and the notice says what that rendezvous can observe.
  `localOnlyNotice` owns both sentences; no surface re-derives the answer, and
  `invitationRedeemableByAnotherDevice` in `@ferretry/protocol` is the one narrowing that decides
  whether a QR is drawn at all.
- `refusal` replaces `daemonUrl`, `pairUrl`, and `reach` when a wildcard bind or missing port leaves no
  address to hand out. The daemon still mints the short-lived code; the surfaces show no link and name
  the fix for **that** reason. A refusal never carries a `discoveredRelayUrl` — the supported
  invariant, enforced by the schema, is that **a disclosed rendezvous only ever rides beside a link**:
  there is no address to disclose one beside, and no link to draw.

### The link names no rendezvous; the device finds one itself

The fragment is one form, `#v1;url=…;code=…;fp=…`, byte-identical to every link a daemon has ever
written. One codec in `@ferretry/protocol` (`formatPairingFragment` / `parsePairingFragment`) writes
and reads it, so the daemon and the browser cannot hold different opinions about the same string:
readers require `url`/`code`/`fp`, ignore an unrecognised field name — a stray `relay=` included, which
is therefore never honoured — and refuse a duplicated one.

**A relayed first pairing needs nothing in the link when both ends resolve the same directory
candidate.** The scanning device's build carries `HOSTED_RELAY_DIRECTORY_ORIGIN` by default, reads
that no-store advertisement once per document, and dials the address it names when the daemon's own
address fails ([relay-protocol.md](relay-protocol.md) §14). The daemon uses the same default, so stock
builds meet at one rendezvous. Its runtime override and the PWA's build-time override are independent,
however; an operator using them must point both ends at the same directory. That address serves **one
redemption** and is never stored — what a device navigates by afterwards is the redemption response's
`carriers`, and the browser refuses a relayed pairing whose published set does not name the rendezvous
the exchange crossed.

**A catalog share link follows the same rule** ([catalogs.md](catalogs.md) "A link works on the carriers
pairing uses"). The daemon's share gate is fed the same `discoverableRelayUrl`, so a loopback-bound machine
on the hosted relay mints a share link exactly when it would draw a pairing QR, the link carries the same
loopback `url` and `fp` and names no rendezvous, and the join is the sealed `join` record on whichever
carrier answers. One difference is deliberate: for a share link with a loopback `url`, the reader's browser
does not dial that address at all while it has a rendezvous to try (unless the app was itself opened on
loopback, where it goes last), because the reader is by definition another person and the address names
their own computer.

`discoveredRelayUrl` on the mint response is **host-facing only**. It exists so `fy pair`, the
Add-a-device panel and `fyd --check` know a loopback-bound daemon is redeemable anyway, and so they can
disclose which rendezvous the daemon expects to see the exchange's metadata. It is derived from relay
**provenance** at the composition root — only an address read from the daemon's directory, never an
operator's own configured block, and never merely the first published relay. It therefore describes
the daemon's candidate; it cannot prove that a PWA compiled with an independent override reads the
same directory. **No version escape hatch was spent:** a relay-bearing `v2` form was built and
withdrawn before any release, so a future second version may still land its pattern and its parser
together.

**A remedy that cannot be followed is a dead end with extra steps**, so there is one per reason rather
than one for all of them — `localOnlyNotice` and `refusalNotice` in `@ferretry/protocol` own every
sentence, and `fy pair`, the Add-a-device panel and `fyd --check` all render those and never their own.

Each remedy below answers **the direct address**, which is the only thing these reasons describe. A
`local-only` daemon that also dials a discoverable rendezvous is already redeemable from another
device, so its remedy is the upgrade to a connection with no third party on the path rather than the
remedy it reads as here — `localOnlyNotice` says so itself when a discovered address is present, and
this table is the no-rendezvous wording:

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
bind (`recordedBindAddress`), never from `publicUrl`. "The recorded bind" is the one `declaredBind` names —
the `carriers` bind entry when there is one, the top-level `host`/`port` otherwise — and the daemon
asks the same function, so the two ends cannot disagree about which port a `carriers` document means.
A wildcard bind resolves to loopback at the recorded port. Reading the advertisement there made an operator who followed the remedy unable to run
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

### What bounds how many devices

A paired device may mint a code and redeem it itself, so guesses are not the only thing to bound. A
daemon holds at most **32** paired devices (`PAIRING_MAX_DEVICES`), and grants at most **10** redemptions
an hour on **each** carrier (`PAIRING_GRANTS_PER_HOUR`) — a count, not a per-peer window, because a
relayed redemption has no peer address to key on. Both are checked after the code is judged and before
it is consumed, with the same refusal as a wrong code, so a full daemon leaves the code live for when a
device is removed. They bound the new-device alerts and the idle expiries the security log records
([audit.md](audit.md)).

## The QR code is a live credential

Whatever draws a QR of a pairing link is handling a credential for somebody's machine, so:

- **Generate it locally.** Never call a QR image service and never put a pairing URL in any third-party
  request. The browser does it with `packages/pwa/src/lib/qr-code.ts` — a pure byte-mode encoder in the
  bundle — and the command line does it with block characters in the terminal.
- **Never announce it.** The rendered symbol's accessible name says what it _is_, never what it encodes:
  a screen reader reading a pairing URL aloud puts a credential in the accessibility tree.
- **Never persist it.** No store, no `localStorage`, no URL, no log, no memo keyed by input. A code lives
  in component state for its TTL and then it is gone.
- **Never put it in an argument vector.** A command-line argument is world-readable on a shared host —
  `/proc/<pid>/cmdline` on Linux — and a browser started with a link repeats it in its own. So
  `fy pair --open` never hands `xdg-open`, `open` or `start` the link. It writes a one-line redirect page
  (`packages/cli/src/lib/pair/redirect-page.ts`) into a fresh `0700` directory under the user's state home
  (`<FY_HOME>/pair-open-*`, never the shared `/tmp`), as a `0600` file created with `O_EXCL`, and opens
  _that path_; the page's script does `location.replace(<link>)`, fragment intact. This is the one place the
  code touches disk, so the page lives seconds, not minutes: it is deleted 10 seconds after the launcher
  starts, at once if the launcher is missing, and when the process exits or is stopped. The timer holds
  `fy pair --no-wait` open for those seconds so the page is not removed before a cold browser reads it.
  Declared GAP: a `SIGKILL` or a power loss inside that window leaves a page behind. **A code expires two
  minutes after it is minted whether or not a leftover file survives** — the page can outlive its
  usefulness but never extend the code's life, and a code older than that opens nothing. The file is still
  a stale credential on disk, so it is swept rather than trusted to the expiry: the next `fy pair` and the
  daemon's boot both remove any `<FY_HOME>/pair-open-XXXXXX/pairing.html` older than 30 seconds
  (`sweepPairingRedirects` in `packages/protocol/src/adapters/pairing-redirect-sweep.ts`, the names and age
  in `pairing-redirect.ts` so the two programs cannot disagree). The sweep matches the directory name
  exactly, never follows a symbolic link, unlinks only a regular file, removes the directory with a plain
  `rmdir`, and treats an absent state home as nothing to do. A page younger than 30 seconds is left to the
  `fy pair` that may be showing it to a browser right now.
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
  against a credential the daemon has already promised to forget. Only **then** is every live session
  the device holds closed — direct and relayed alike, with the same `4403` an unknown device gets —
  because a session is authorized once, at its proof, and would otherwise outlive the grant. A request
  already in flight on a closing session is refused at the request boundary too: the dispatcher re-asks
  whether the device is still paired, and an unanswerable question is a refusal.
- **Idle expiry** — a device nobody has USED for the idle period is removed the next time the daemon looks
  (at boot, at a session's proof, at a device-list read) and must pair again. Use means a request the
  page marks `presence` — visible and touched within five minutes, by real input. A page that only
  loaded is not use, and neither is a proof or a silent renewal, so a tab left open on a forgotten
  laptop cannot keep the device paired.
  `lastSeenAt` reaches disk at most once an hour, so a busy phone is not a write per request;
  `idleExpiresAt` on each row says when the grant ends. The period is the `idleExpiryDays` security
  setting (1–90 days, default 30; [design/zero-trust.md](design/zero-trust.md) B6), read at every check, so
  shortening it can unpair devices at once. The change's answer says how many (`devicesExpiring`), and the
  redemption response's `idleExpiryDays` reports the value in force. Change it at the machine with
  `fy daemon security set idleExpiryDays <days>`, or shorten it from a paired device in Settings.

**At the machine: `fy device revoke <device>`.** This is THE way to remove a stolen phone without a
browser. `<device>` is a paired device's id, or its name when exactly one device has that name (the same
resolver as `fy passkey window`); it calls `DELETE /v1/pair/devices/:deviceId` with the host's admin token
over loopback, which is ungoverned, so no step-up is asked. From a paired device the same route asks only its
`pairing.use` grant and the unlock — never a per-act passkey, because revoking only takes away
([grants.md](grants.md#narrowing-never-asks-again)) and must be instant in an emergency. **The cost, said plainly:** an
unlocked phone that holds `pairing.use` (a default `full` pairing does) can revoke your OTHER devices with no
passkey, which locks you out of remote access until you reach the host (`fy device revoke`, then pair again). A
caller with no proven device (the admin token off loopback) is refused. Revoking is the one change here that cannot be
undone — the device must pair again — so it asks you to type `revoke` unless `--yes` waived it, and off a
terminal it refuses without `--yes` rather than skip the question. It ends in one sentence: the device can
no longer reach this machine, its open sessions were closed and its passkeys forgotten. An unknown name, two
devices with one name, a daemon that is not running and a device already gone are each one plain sentence
naming what to do, with exit code 1.

**Every revocation somebody asked for is recorded.** The act is written to the owner's grant journal
(`state/grant-audit.jsonl`, the one the grant changes and re-opened passkey windows already use) as
`device.revoked=<deviceId>` beside the resolved actor — `admin-cli` for this command line, `device:<id>` for a
governed device that asked — never a credential. The record is the LAST step, written only after the grant
is gone and its sessions are closed, so a refused or unknown revocation leaves none; a journal that cannot be
written does not undo the revocation, it surfaces as an error after the device is already gone.

**A revoked device's standing sign-in rules are suspended.** Every standing rule whose passkey was proved on that
device is suspended (`passkey-removed`) as part of the same revocation, because the rule service is one of the
device-state purges. Every purge is attempted even when an earlier one fails, so a push store that cannot be written
still leaves the rules suspended. A rule's kept proof also stops verifying once its device is no longer paired, so a
missed purge costs a refusal, never a fill. Only a new passkey from a device that is still paired resumes one
([secrets.md](secrets.md#standing-sign-in-rules)). The same holds for an idle expiry. Settings › Devices says so
before the owner revokes: "N standing rules were approved with this device's passkey; they will be suspended." It is
shown only on a machine that reports `sign-in-rules.1`, and only to a device that may read the rules.

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
| the panel's two shortcuts   | `packages/pwa/src/features/settings/pair-phone.tsx`                |
| the QR encoder              | `packages/pwa/src/lib/qr-code.ts`                                  |

## Declared GAPs

- **A device cannot be renamed.** The name is whatever the device called itself when it redeemed, and it
  is attacker-influenced text bounded by `PairingDeviceNameSchema`. Two phones that both say "Chrome" are
  told apart only by when they were added.
- **The pairing audit record is only the revocations somebody asked for.** `device.revoked=<deviceId>` is
  recorded with its actor (above). Still NOT recorded: a pairing (a device redeeming a code), a minted or
  revoked code, and **idle expiry** — a device removed because nobody used it for 30 days leaves no trace
  beyond its absence from `devices.json`, since no actor asked for it. So "when did this credential go
  away" is answerable for a revocation and not for an expiry, and "when did this device first join" is not
  answerable at all.
- **Code running in the paired page can USE the device key while the tab is open.** The key cannot be
  exported, so a cross-site script or a malicious deploy cannot carry it away, but it can sign sessions
  for as long as it runs. Signed PWA releases ([design/zero-trust.md](design/zero-trust.md) D) narrow
  the deploy half; nothing here narrows the in-page half.
- **An unanswered attempt can leave a grant nobody can name.** If a direct attempt's record left but its
  answer never arrived, and the browser's next attempt on the relay is refused (the code was spent),
  the daemon may hold a grant for a key the browser has but under a `deviceId` it never learned. Nothing
  can use it — the browser saved no pairing — and it lapses with idle expiry after 30 days; the
  refusal tells the reader to check the device list and revoke it sooner.
- **Devices paired before device keys were deleted on upgrade.** A `devices.json` from before schema 2
  held only token digests, which no session can prove against, so the daemon drops those grants at boot
  and says so once. Each such device must pair again.
- **An unlock bounds who acts, not what the act does.** A governed device inside its unlock may open a
  terminal or apply a fleet change for the rest of the unlock period with no further prompt; minting a code
  still wants a passkey for that one act. The passkey says the person holding the device agreed recently,
  nothing about the act itself ([grants.md](grants.md), [design/zero-trust.md](design/zero-trust.md) B1).
- **A device's first passkey has a ten-minute window.** It can be added only in the ten minutes after
  pairing (B2), so a newly paired device with no passkey for the machine sees one dismissible line
  pointing at Settings → Daemons → Security → Add a passkey. A device that misses the window cannot unlock
  the machine, so it can do nothing there, until the owner re-opens it at the machine (below) or it pairs
  again ([design/zero-trust.md](design/zero-trust.md) B1, B2).

**Recovering a device that cannot add a passkey: `fy passkey window <device>`.** A device that missed its
first ten-minute window, or lost the authenticator that held its passkey, cannot unlock again — and a
browser cannot re-open its own window, because no browser is ever "at the machine". The owner does it at
the machine: `fy passkey window <device>` takes a paired device's id, or its name when exactly one device
has that name, and calls `POST /v1/passkeys/registration-window` with the host's admin token over loopback.
Anybody else is refused (`403 step_up_not_at_machine`), an unknown device is `404 step_up_unknown_device`,
and the window is ten minutes, admits ONE passkey and is audited. The device then opens Settings →
Security → Add a passkey inside it. Nothing here pairs the device again, so its grant and its other
sessions are untouched.

- **The browser cannot scan on WebKit.** `BarcodeDetector` is Chromium-only, so the in-app scanner is
  absent there. This is not the blocked path it looks like — the intended carrier is the phone's own
  camera app, which opens the PWA pre-filled on every platform — but a reader who opened the app first
  gets the paste field rather than a bundled decoder every visitor would have to download.
- **`pairing.configure` governs no route.** Like `terminal` and `browser`, its configure
  axis governs exactly one thing: whether a remote caller may re-grant the capability. See
  [grants.md](grants.md).
- **A stock fresh device cannot discover an arbitrary self-hosted rendezvous.** A pairing fragment
  carries only the daemon's direct address, code and fingerprint, so its sole relayed first-pairing
  candidate is whatever directory its own build reads. A private PWA build can discover a self-hosted
  address when both ends are pointed at the directory that advertises it, but no existing link tells a
  stock build where an operator's directory lives. A daemon published only through an explicit
  self-hosted carrier is therefore pairable only from a device that can already reach its direct
  address, and naming a rendezvous in the link is deferred. `fy pair`, the Add-a-device panel and
  `fyd --check` fail closed for that daemon: they draw no QR and print the plain local-only sentence.
- **A private directory origin must be configured independently on both ends.** Both ends share the
  default, but `FY_RELAY_DIRECTORY_ORIGIN` is a runtime daemon override and a build-time PWA override.
  Setting only one sends the scanning device to a rendezvous the daemon does not hold, so direct is
  still tried first but relayed first contact ends at `4404`; the current pairing surface does not name
  the configuration mismatch. The fingerprint is pinned before any pairing code, token or payload is
  sent, so the wrong directory or rendezvous learns none of those secrets. It can still learn metadata
  the owner did not intend to share: the directory sees the device IP and request timing, and its
  rendezvous sees the device IP, daemon fingerprint and connection timing.
