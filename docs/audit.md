# Security audit log

What this machine records about who reached it and what they did — section C of the zero-trust
design (`docs/design/zero-trust.md` on `feat/zero-trust`). The wire contract is
`packages/protocol/src/lib/audit.ts`.

## Where and how

- Two stores under `<FY_HOME>/state/`, each rotated to a `.1.jsonl` sibling when the next record
  would carry it past 1 MiB, so the log is bounded at 4 MiB. Rotation is a rename; nothing is ever
  rewritten in place.
  - `audit-kept.jsonl` — the **kept** store: only the successes of a change to who may reach this
    machine and what they may do there (`AUDIT_KEPT_EVENTS`: pairings, revocations, idle expiries, key
    rotations, passkeys added, grant changes, secret changes, security-setting changes, warden
    reconfiguration). Never activity.
  - `audit.jsonl` — the **general** store: everything else — refusals, failures, and all ACTIVITY
    (terminal attaches and input, secrets used, agents started or prompted, codes minted, step-ups).
- **Nothing a paired device does can take a kept record off the disk.** What is rationed is decided by
  the CAUSE, not the actor: an idle expiry is the machine acting, but a paired device can shorten the
  idle period and pair devices for it to expire, so it is treated like a device's record. Only a person
  at the machine is exempt. Four rules, together:
  1. Activity never goes to the kept store, so the cheap things a device repeats at will — re-attaching
     to a terminal 15,000 times — land in the general store, folded.
  2. Every rationed caller shares ONE allowance of 50 kept records per kept EVENT per UTC day
     (`AUDIT_KEPT_DAILY_ALLOWANCE`) — shared, because a device can pair new devices; per event, so
     fifty secret puts cannot spend what a pairing or a revocation needs. Past it, the first of each
     event and actor kind is still kept with `detail.keptAllowanceSpent`, the rest are counted into one
     kept line when the day ends — naming their subjects in `detail.subjects` as far as one field holds,
     then `+N` — and every overspent record is written in full to the general store.
  3. A rationed kept record is written **never-rotating**: if the kept store is full it is refused (and
     written to the general store, with the operator told in the boot journal) rather than renaming the
     oldest kept file away. Only a person at the machine rotates the kept store.
  4. A daemon pairs at most 32 devices at once (`PAIRING_MAX_DEVICES`), and grants at most 10
     redemptions an hour on each carrier (`PAIRING_GRANTS_PER_HOUR`) — the relay has no peer address
     to rate-limit by, and a device can redeem codes it minted itself. A refusal leaves the code live.
     The flood test (`tests/integration/audit/file-audit-journal.test.ts`, "a flood by a paired device")
     drives every audited route and socket as a paired device for a simulated week, plus the review's
     15,000-attach probe, then a flood of idle expiries after a device shortened the idle period, and asserts `device.paired` is still on disk and on the reader's page. The first two fail against the
     round-1 code and the third against the round-2 code.
- One `O_APPEND` write per record, synced, mode `0600`. Every open is `O_NOFOLLOW | O_NONBLOCK` and is
  followed by an `fstat` of the handle: anything but a regular file with exactly one link is refused,
  so a FIFO cannot hang the daemon and a hard link cannot redirect the log.
- A record that cannot be written is reported in the daemon's boot journal and **never** fails the
  request it describes — refusing to revoke a stolen phone because a disk is full would make the
  machine less safe. Recording is wrapped so a throwing sink cannot either.

## Repeats are folded

A refused or failed record opens a 60-second window keyed by actor, event, outcome and carrier — not
subject, so a flood of random ids is one flood. A SUCCESS of activity opens one keyed by actor, event,
subject and every detail, so "this phone attached to that terminal" is one line a minute with a count,
and two acts that differ in anything a reader cares about stay apart. A kept event is never folded.
The first record of a window is written; the rest are counted and written as ONE record with
`detail.repeats` when the window closes. A timer in `fyd`
flushes windows that ran their length, so a burst that stops is still reported, and shutdown flushes
everything. A flood therefore costs about one line a minute and cannot write its way through the
bound.

## What a record holds

`{ at, event, actor: { kind, deviceId?, deviceName? }, subject?, outcome, detail? }`

- `actor.kind`: `host` (admin token / command line), `device` (a paired device, by id and name),
  `warden`, or `anonymous` (an unpaired caller — only on `pairing.refused`).
- `outcome`: `succeeded`, `refused` (a 4xx), `failed` (a 5xx or a thrown error).
- `detail`: at most twelve short scalar facts. There is no field that can hold a nested document,
  an argv or a multi-line value. A subject or name that is not short single-line text is written as
  `<invalid>` with `detail.subjectLength`, never as the text itself.

**Names and ids only.** Never a code, token, key, proof, secret value or command line. The
integration test `tests/integration/audit/file-audit-journal.test.ts` drives every audited route
with each of those in the request and the response and greps the files on disk for every one, and
`tests/integration/audit/pairing-on-disk.test.ts` does the same over a real redemption on each
carrier.

**A device's name is a label somebody chose.** Every reader shows it marked and quoted beside a short
id (`device “Pixel 8” (…a1b2c3)`), and redemption refuses a name that would read as one of the fixed
actor phrases (`this computer`, `a supervising agent`, …).

## What is recorded today

| Event                                                    | Where it is caught                                                                                                                                                                                                                                                            |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `device.paired`                                          | `AuditedPairingService.onGranted` — direct and relayed, with the carrier                                                                                                                                                                                                      |
| `pairing.refused`                                        | `AuditedPairingService` — folded per carrier                                                                                                                                                                                                                                  |
| `pairing.code-minted`                                    | `POST /v1/pair/code`                                                                                                                                                                                                                                                          |
| `pairing.code-revoked`                                   | `DELETE /v1/pair/code/:pairingId`                                                                                                                                                                                                                                             |
| `device.revoked`                                         | `DELETE /v1/pair/devices/:deviceId`                                                                                                                                                                                                                                           |
| `push.changed`                                           | push subscription enrol and remove                                                                                                                                                                                                                                            |
| `grants.changed`                                         | `PATCH /v1/grants`, one device's grants (`PATCH /v1/pair/devices/:deviceId/grants`)                                                                                                                                                                                           |
| `security.changed`                                       | `PATCH /v1/security` — with every setting's number or boolean after the change in `detail` — and an owner re-opening a passkey window                                                                                                                                         |
| `passkey.registered`                                     | `POST /v1/passkeys`                                                                                                                                                                                                                                                           |
| `step-up.succeeded`                                      | a passed step-up or unlock (`detail.action`); `step-up.failed` when refused                                                                                                                                                                                                   |
| `device.key-rotated`                                     | `AuditedPairingService.rotateDeviceKey`, inside a step-up                                                                                                                                                                                                                     |
| `device.expired`                                         | `AuditedPairingService.revokeDevice` with no actor — the daemon's own idle expiry                                                                                                                                                                                             |
| `session.opened`                                         | `POST /v1/sessions` and a fork — an agent started, folded per device                                                                                                                                                                                                          |
| `agent.prompted`                                         | `POST /v1/sessions/:sessionId/send`, `/answer` and `/migrate/ask-to-stop-jobs` — folded per device per session                                                                                                                                                                |
| `fleet.configured`                                       | proposal create and apply, credential sign-in and its answer/cancel, tool install                                                                                                                                                                                             |
| `fleet.configured` (`catalog-install`, `catalog-remove`) | `POST /v1/catalog-installs/<scope>` and `DELETE …/<scope>/:installId` — the item name, publisher name and scope; never a file, a command or a secret. A refusal (a changed publisher, a conflict, a bad binding) is recorded `refused` with the refusal code in `detail.code` |
| `terminal.opened`                                        | terminal create, and every stream attach (`detail.mode: 'attach'`)                                                                                                                                                                                                            |
| `terminal.input`                                         | keystroke frames on a terminal stream, a Console write, and a Processes-tab Stop (`detail.mode: 'process-stop'`) — counted, never their bytes                                                                                                                                 |
| `link.opened`                                            | `POST /v1/system/open-url` — a link handed to this computer's browser; the host only, never the path or query                                                                                                                                                                 |
| `browser.opened`                                         | browser sign-in window, browser control, and every browser stream attach                                                                                                                                                                                                      |
| `browser.proxy-tested`                                   | `POST /v1/browser/proxy/test` — a test of the browser proxy; the outcome and its error class in `detail`, never an address or a credential                                                                                                                                    |
| `secrets.used`                                           | `POST /v1/secrets/use` — the `used` names only, never the output                                                                                                                                                                                                              |
| `secrets.changed`                                        | secret put and delete — the name only                                                                                                                                                                                                                                         |
| `warden.configured`                                      | `PATCH /v1/warden/config`                                                                                                                                                                                                                                                     |
| `warden.ran`                                             | `POST /v1/warden/run`, and `POST /v1/warden/investigate` (detail `action: investigate`)                                                                                                                                                                                       |
| `worktree.removed`                                       | `POST /v1/worktrees/remove`                                                                                                                                                                                                                                                   |

Starting a daemon update (`POST /v1/daemon/update`, subject `daemon-update`) and changing the
automatic-install setting (`PATCH /v1/daemon/update/settings`, subject `daemon-update-settings`, with
`autoInstall` in `detail`), and updating an agent CLI (`POST /v1/harnesses/update`, subject `harness-update`),
are also `security.changed`: each lets new code run on the machine ([updating.md](updating.md)).

Routes are recorded by decorating the finished route and socket tables (`auditedRoutes` and
`auditedSocketRoutes` in `packages/daemon/src/lib/audit/routes.ts`), so a relayed request is recorded
exactly like a direct one. A step-up is a passkey ceremony, so every reader calls it "Passkey
confirmation".

**One place for every change.** `state/security-audit.jsonl` and the grant journal (from #464) still
exist and are still written, but nothing they record is missing here: grant changes, security
settings, re-opened passkey windows, passkeys added, key rotations, revocations and idle expiries all
reach this log too. The one exception is declared below.

**Nothing that changes state goes unreviewed.** `tests/unit/runtime/mounts/surface.test.ts` fails when
a mounted non-`GET` route or a socket is neither audited nor on the reviewed list in
`packages/daemon/tests/unit/audit/not-audited.ts`, where every entry says why. That list only shrinks.

## GAPs — declared

- A request the authorization boundary refuses **before** its handler runs (missing credential,
  switched-off grant, wrong credential class, a step-up that is required and absent) is not recorded.
- A passkey assertion whose signature counter did not move (`passkey.counter-refused`, a sign of a
  cloned authenticator) is written only to the grant journal; it reaches this log only as the
  `step-up.failed` of the request that carried it.
- The kept allowance is held in memory, so a daemon restart resets it. Restarting the daemon remotely
  takes a terminal, and a device with a terminal can already reach the files directly.
- The `keptOffset` page counts from the newest record, so a change recorded while somebody pages back
  can repeat one row at a page boundary. It never skips one.
- `grant-audit.jsonl` and `GET /v1/grants/audit` still exist beside this log; folding them in is
  later work.

## Reading it

- `GET /v1/audit?limit=N&keptOffset=K` — TWO lists, newest first: `kept` (the never-lose records,
  `N` of them from offset `K`, with `keptTotal`) and `records` (the newest `N` of everything else).
  They are never interleaved, so no amount of activity pushes a pairing off the page. `N` at most 200
  (default 50), `operator` minimum and the `pairing.configure` capability. Lines that do not parse are
  counted in `unreadable`, never dropped.
- **Why `configure` and not `use`.** The log holds more than the device list — secrets used and
  stored, terminals typed into, settings changed, failed pairings and where they came from. Every
  paired phone needs `pairing.use` to enrol for push, so gating the log there would hand that history
  to any device allowed to manage pairing. Filtering records to what the caller may see was rejected:
  a filtered log reads as a complete one, and the reader could not tell what was withheld.
- `fy daemon audit [--limit N] [--kept-skip K] [--json]` — "Security changes" first, with how many
  older ones there are and the flag that shows them, then "Recent activity".
- The app: Settings › ‹machine› › Machine › Security log, per machine — "Security changes" first with "Show older" until every
  one has been shown, then "Recent activity". Opening it marks a device as seen by the new-device notice
  only when that device's `device.paired` record was actually rendered; a refused or failed read marks
  nothing.

## New-device alerts

When a device is paired, every **other** enrolled device gets a Web Push notification titled
"A new device was paired": "A device calling itself “‹name›” (‹short id›) was paired with ‹machine›
over the relay / on the local network at ‹time›." That title, its `device-paired:` tag and event key
are reserved: an agent's notification always opens with `Agent “‹session›”` and can carry neither.

The app also shows an in-app notice for every device on the list **this browser has not seen**, with
**That was me** and a one-tap **Remove it** (the existing revoke route). "Seen" is a set of device ids
per machine, not an instant, so a skewed browser clock cannot hide a device. On a browser that has
never looked, every device paired more than a day before the newest one — by the daemon's own
`createdAt` values — counts as seen; a recent pairing is still announced. The device list carries
`pairedOver` (`direct` or `relay`) for devices paired since it was added.
