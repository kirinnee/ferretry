# Security audit log

What this machine records about who reached it and what they did — section C of the zero-trust
design (`docs/design/zero-trust.md` on `feat/zero-trust`). The wire contract is
`packages/protocol/src/lib/audit.ts`.

## Where and how

- Two stores under `<FY_HOME>/state/`, each rotated to a `.1.jsonl` sibling when the next record
  would carry it past 1 MiB, so the log is bounded at 4 MiB. Rotation is a rename; nothing is ever
  rewritten in place.
  - `audit-kept.jsonl` — the **kept** store: only the successes a reader must never lose
    (`AUDIT_KEPT_EVENTS`: pairings, revocations, key rotations, grant, fleet, secret and security
    changes, secrets used, terminals opened and typed into).
  - `audit.jsonl` — the **general** store: everything else, refusals and failures included.
  A stranger who can only produce refusals therefore can only rotate the general store; the history
  of who was paired and what changed survives in the kept one.
- One `O_APPEND` write per record, synced, mode `0600`. Every open is `O_NOFOLLOW | O_NONBLOCK` and is
  followed by an `fstat` of the handle: anything but a regular file with exactly one link is refused,
  so a FIFO cannot hang the daemon and a hard link cannot redirect the log.
- A record that cannot be written is reported in the daemon's boot journal and **never** fails the
  request it describes — refusing to revoke a stolen phone because a disk is full would make the
  machine less safe. Recording is wrapped so a throwing sink cannot either.

## Repeats are folded

A refused or failed record, and every `terminal.input` record, opens a 60-second window keyed by
actor, event and outcome (input: per terminal). The first is written; the rest inside the window are
counted and written as ONE record with `detail.repeats` when the window closes. A timer in `fyd`
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

| Event                  | Where it is caught                                                        |
| ---------------------- | ------------------------------------------------------------------------- |
| `device.paired`        | `AuditedPairingService.onGranted` — direct and relayed, with the carrier  |
| `pairing.refused`      | `AuditedPairingService` — folded per carrier                              |
| `pairing.code-minted`  | `POST /v1/pair/code`                                                      |
| `pairing.code-revoked` | `DELETE /v1/pair/code/:pairingId`                                         |
| `device.revoked`       | `DELETE /v1/pair/devices/:deviceId`                                       |
| `push.changed`         | push subscription enrol and remove                                        |
| `grants.changed`       | `PATCH /v1/grants`                                                        |
| `security.changed`     | operator password set, operator unlock                                    |
| `fleet.configured`     | proposal create and apply, credential sign-in and its answer/cancel, tool install |
| `terminal.opened`      | terminal create, and every stream attach (`detail.mode: 'attach'`)        |
| `terminal.input`       | keystroke frames on a terminal stream — counted, never their bytes        |
| `browser.opened`       | browser sign-in window, browser control, and every browser stream attach  |
| `secrets.used`         | `POST /v1/secrets/use` — the `used` names only, never the output          |
| `secrets.changed`      | secret put and delete — the name only                                     |
| `warden.configured`    | `PATCH /v1/warden/config`                                                 |
| `warden.ran`           | `POST /v1/warden/run`                                                     |
| `worktree.removed`     | `POST /v1/worktrees/remove`                                               |

Routes are recorded by decorating the finished route and socket tables (`auditedRoutes` and
`auditedSocketRoutes` in `packages/daemon/src/lib/audit/routes.ts`), so a relayed request is recorded
exactly like a direct one. `device.expired`, `device.key-rotated`, `session.opened`,
`step-up.succeeded`, `step-up.failed` and `passkey.registered` are declared in the schema and emitted
by nothing yet. A step-up is a passkey ceremony, so every reader calls it "Passkey confirmation".

**Nothing that changes state goes unreviewed.** `tests/unit/runtime/mounts/surface.test.ts` fails when
a mounted non-`GET` route or a socket is neither audited nor on the reviewed list in
`packages/daemon/tests/unit/audit/not-audited.ts`, where every entry says why. That list only shrinks.

## GAPs — declared

- A request the authorization boundary refuses **before** its handler runs (missing credential,
  switched-off grant, wrong credential class) is not recorded.
- `grant-audit.jsonl` and `GET /v1/grants/audit` still exist beside this log; folding them in is
  later work.

## Reading it

- `GET /v1/audit?limit=N` — newest first, `N` at most 200 (default 50), `operator` minimum and the
  `pairing.configure` capability. Lines that do not parse are counted in `unreadable`, never dropped.
- **Why `configure` and not `use`.** The log holds more than the device list — secrets used and
  stored, terminals typed into, settings changed, failed pairings and where they came from. Every
  paired phone needs `pairing.use` to enrol for push, so gating the log there would hand that history
  to any device allowed to manage pairing. Filtering records to what the caller may see was rejected:
  a filtered log reads as a complete one, and the reader could not tell what was withheld.
- `fy daemon audit [--limit N] [--json]`.
- The app: Settings › Security, per machine.

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
