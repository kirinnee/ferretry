# Security audit log

What this machine records about who reached it and what they did — section C of the zero-trust
design (`docs/design/zero-trust.md` on `feat/zero-trust`). The wire contract is
`packages/protocol/src/lib/audit.ts`.

## Where and how

- `<FY_HOME>/state/audit.jsonl`, rotated to `audit.1.jsonl` when the next record would carry it past
  1 MiB. Two files are kept, so the log is bounded at 2 MiB. Rotation is a rename; nothing is ever
  rewritten in place.
- One `O_APPEND` write per record, synced, mode `0600`, opened with `O_NOFOLLOW`.
- A record that cannot be written is reported in the daemon's boot journal and **never** fails the
  request it describes — refusing to revoke a stolen phone because a disk is full would make the
  machine less safe.

## What a record holds

`{ at, event, actor: { kind, deviceId?, deviceName? }, subject?, outcome, detail? }`

- `actor.kind`: `host` (admin token / command line), `device` (a paired device, by id and name),
  `warden`, or `anonymous` (an unpaired caller — only on `pairing.refused`).
- `outcome`: `succeeded`, `refused` (a 4xx), `failed` (a 5xx or a thrown error).
- `detail`: at most twelve short scalar facts. There is no field that can hold a nested document,
  an argv or a multi-line value.

**Names and ids only.** Never a code, token, key, proof, secret value or command line. The
integration test `tests/integration/audit/file-audit-journal.test.ts` drives every audited route
with each of those in the request and the response and greps the files on disk for every one.

## What is recorded today

| Event                 | Where it is caught                                                  |
| --------------------- | ------------------------------------------------------------------- |
| `device.paired`       | `AuditedPairingService` — direct and relayed redemption             |
| `pairing.refused`     | `AuditedPairingService` — at most one record per minute per carrier |
| `pairing.code-minted` | `POST /v1/pair/code`                                                |
| `device.revoked`      | `DELETE /v1/pair/devices/:deviceId`                                 |
| `grants.changed`      | `PATCH /v1/grants`                                                  |
| `fleet.configured`    | proposal apply, credential sign-in start, tool install              |
| `terminal.opened`     | `POST /v1/sessions/:sessionId/terminals`                            |
| `secrets.used`        | `POST /v1/secrets/use` — the `used` names only, never the output    |

Routes are recorded by decorating the finished route table (`auditedRoutes` in
`packages/daemon/src/lib/audit/routes.ts`), so a relayed request is recorded exactly like a direct
one. `device.expired`, `session.opened`, `step-up.succeeded`, `step-up.failed` and
`passkey.registered` are declared in the schema and emitted by nothing yet.

Refusals are spaced because pairing is the one door anybody can knock on: a record per wrong guess
would let a stranger rotate the real history out of a bounded log.

## GAPs — declared

- A request the authorization boundary refuses **before** its handler runs (missing credential,
  switched-off grant, wrong credential class) is not recorded.
- `grant-audit.jsonl` and `GET /v1/grants/audit` still exist beside this log; folding them in is
  later work.

## Reading it

- `GET /v1/audit?limit=N` — newest first, `N` at most 200 (default 50), `operator` minimum and the
  `pairing.use` capability. Lines that do not parse are counted in `unreadable`, never dropped.
- `fy daemon audit [--limit N] [--json]`.
- The app: Settings › Security, per machine.

## New-device alerts

When a device is paired, every **other** enrolled device gets a Web Push notification: "A new device,
‹name›, was paired with ‹machine›". The app also shows an in-app notice for devices added since this
device last looked, with **That was me** and a one-tap **Remove it** (the existing revoke route). A
first run seeds the "last looked" instant without announcing devices that were already there.
