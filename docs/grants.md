# Capability grants — what a caller who is not on this host may do

Read this before describing what grants protect against, because the useful property is narrower
than the name suggests.

## The one-sentence version

**A loopback caller is ungoverned. Everything here is about the caller who reached this daemon from
somewhere else** — a paired phone, a browser across the network, a session carried over the relay.

## Why loopback is exempt

Somebody standing at the machine already _has_ the machine. They can edit
`<FY_HOME>/config/daemon.json`, run `fy` directly, or start any program they like. A permission model
that gated them would add friction and no safety, and it would make a grant document that refuses
everything a document nobody could ever edit back.

So the common case — one person, one laptop, a browser on `127.0.0.1` — needs **no setup, no
questionnaire and no password**. Nothing in this document applies to it.

## "Loopback" means how the request arrived

This is the single detail that decides whether the design is sound rather than a hole.

The relay **terminates on the host it serves**. A check that read a peer address, a `Host` header or
a URL containing `127.0.0.1` would see loopback for a phone on the other side of the world and hand
it the machine.

`ApiRequest.loopback` is therefore **carrier-derived**:

- the Bun transport sets it from the socket's real remote address;
- `tunnelApiRequest` (the relay hop) sets it to `false` **unconditionally**, whatever address the
  request appears to carry.

Nothing re-derives it, and no header can move it.
`packages/daemon/tests/unit/grants/policy.test.ts` asserts exactly this with a relayed request that
presents every loopback-looking signal it can.

## Five capabilities, two axes

| capability   | what it covers                                                         |
| ------------ | ---------------------------------------------------------------------- |
| `fleet`      | the account manifest, plan, usage, assets, proposals and `fleet apply` |
| `terminal`   | opening, writing to and streaming session terminals                    |
| `browser`    | the human login window and per-session browser control                 |
| `filesystem` | the read-only session working-tree surface                             |
| `warden`     | supervision status, sweeps and the warden configuration                |

Each has two axes, and they are different questions:

- **use** — may the caller exercise the capability at all?
- **configure** — may the caller change how it behaves on this host?

The list is closed. Everything the daemon does _inside its own state home_ — sessions, tasks,
attention, pins — is deliberately absent: a grant list that grew to cover every route would be a
second copy of the route table, and a second copy is how the two stop agreeing.

## Permissive by default; the password is the layer

Both axes default to **enabled** for all five. The product should let a person do as much as possible
from the UI, and the security model is something a cautious operator turns **on** rather than a wall
everyone starts behind.

That layer is the **operator password**:

- with one set, every `configure` demand needs a short-lived unlock;
- with none set, `configure` passes and the answer comes back as `ungated` rather than `granted`, so
  a UI can say once — beside the control, never as nagging — that nothing is standing behind it.

**The honest cost:** with permissive defaults and no password, anyone holding a pairing can change
this machine's fleet and settings. That is stated in one plain sentence wherever remote access is
inspected (`fy daemon config`, the daemon's boot log, the PWA's grant surface), and never as a
question somebody has to answer to use their own machine.

## The operator password

- **It is not the system root password.** Nothing here shells out to `sudo`, and it cannot elevate
  anything on the machine. It is a Ferretry operator secret for one daemon.
- Stored as an **argon2id verifier** (Bun's built-in, at the OWASP interactive parameters) in
  `<FY_HOME>/state/operator-password.json`, mode `0600` — deliberately **not** in
  `config/daemon.json`, which is the file that travels into backups, dotfile repositories and screen
  shares.
- **Use, never read.** There is no getter on the port, no route that returns one, and nothing above
  the verifier is ever handed a password to leak. `passwordSet` is a boolean and is the entire
  disclosure.
- **Rate limited per daemon**: five attempts, then a fifteen-minute lockout. A correct password
  during a lockout is still refused — a limiter that let one through early would leak that the guess
  was right while claiming to be closed.
- Set it with `fy daemon password set`, reading the value from **stdin**. There is no flag that takes
  one: an argument is in shell history and in `/proc/<pid>/cmdline` for every account on the box.

## Widening and narrowing are not the same act

| change                              | what it needs                                                   |
| ----------------------------------- | --------------------------------------------------------------- |
| turning an axis **off**             | the `configure` grant on that capability; never the password    |
| turning an axis **on**              | a valid unlock, on every path including the host's command line |
| turning one **on**, no password set | a host act — a remote caller cannot prove operator intent       |

Revoking must never be harder than granting: in an incident the fastest possible path to _"the UI can
no longer do that"_ matters more than a confirmation, and a password prompt between a person and
shutting a door is a liability.

## A grant only ever narrows

The grant layer is consulted **after** authentication and **after** the route's own `RouteScope`
check. Every branch either keeps the answer those produced or removes it. There is no input that
turns a refused route into a served one — a device token cannot reach an `admin` route because a
grant says `use: true`, and no document an operator writes can make it.

## Unknown is not permitted

Permissive **defaults** settle what an operator's _silence_ meant. They say nothing about damage.

- A document with no `grants` key is a **complete** answer: every axis takes the product default.
- A document whose `grants` key is **wrong** — an unknown capability, a string where a boolean
  belongs — fails to parse, and the boot refuses rather than falling back to anything.
- A grant document that becomes unreadable at runtime sets the enforced answer to `undetermined`, and
  every governed capability is refused until a human repairs it.

## Where it lives

| thing                      | path                                                         |
| -------------------------- | ------------------------------------------------------------ |
| the wire contract          | `packages/protocol/src/lib/grants.ts`                        |
| the decision               | `packages/daemon/src/lib/grants/`                            |
| the authorization boundary | `packages/daemon/src/lib/api/capability.ts`, `dispatcher.ts` |
| the routes                 | `packages/daemon/src/lib/runtime/mounts/grants.ts`           |
| the grants themselves      | `<FY_HOME>/config/daemon.json`, under `grants`               |
| the password verifier      | `<FY_HOME>/state/operator-password.json` (mode 0600)         |
| the change record          | `<FY_HOME>/state/grant-audit.jsonl`                          |
| the command line           | `fy daemon config`, `fy daemon password`                     |

`fyd --print-config` reports every capability with its **origin** — `default` or `config file` — the
same provenance treatment every other value gets, because a person reading a permission report is
usually asking which of these they chose and which something chose for them.

## Changes take effect immediately

`fy daemon config set …` writes the document and moves the daemon's in-memory answer in the same
call, so the next request is decided by the new one. **No restart.**

The case that _does_ need a restart is a document edited by hand behind the daemon's back, and the
command says so at the moment somebody might be tempted to do that instead.

## Declared GAPs

- **`configure` has no route of its own for `terminal`, `browser` or `filesystem`.** Those three
  subsystems have no host settings the API can change today, so their configure axis governs exactly
  one thing: whether a remote caller may re-grant that capability. It is not decoration — it is the
  coarse switch's own lock — but it is narrower than `fleet` and `warden`, whose configure axis gates
  real host-changing routes (`PUT /v1/fleet/environment`, `POST /v1/fleet/apply`,
  `PATCH /v1/warden/config`).
- **The audit journal has no read surface.** `state/grant-audit.jsonl` is written and never served;
  there is no `fy daemon config history`. The record exists so the question is answerable, but
  answering it means reading the file.
- **The daemon's fleet event stream (`GET /v1/events`) is not governed.** It carries session events
  the whole UI depends on rather than fleet configuration, so tying it to the `fleet` capability
  would make revoking `fleet` break the session list. If a future event kind carries fleet
  configuration, it needs its own decision.
