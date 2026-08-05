| the change record | `<FY_HOME>/state/grant-audit.jsonl`, read by `fy daemon config history` |# Capability grants — what a caller who is not on this host may do

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

## Six capabilities, two axes

| capability   | what it covers                                                         |
| ------------ | ---------------------------------------------------------------------- |
| `fleet`      | the account manifest, plan, usage, assets, proposals and `fleet apply` |
| `terminal`   | opening, writing to and streaming session terminals                    |
| `browser`    | the human login window and per-session browser control                 |
| `filesystem` | the read-only session working-tree surface                             |
| `warden`     | supervision status, sweeps and the warden configuration                |
| `pairing`    | minting and revoking pairing codes, and the paired-device list         |

Each has two axes, and they are different questions:

- **use** — may the caller exercise the capability at all?
- **configure** — may the caller change how it behaves on this host?

The list is closed. Everything the daemon does _inside its own state home_ — sessions, tasks,
attention, pins — is deliberately absent: a grant list that grew to cover every route would be a
second copy of the route table, and a second copy is how the two stop agreeing.

<<<<<<< HEAD

## Permissive by default; LOCALITY is the layer

Both axes default to **enabled** for every capability. The dangerous act is structurally
unavailable to a remote caller, so starting open costs much less than it would otherwise, and starting
closed would make a fresh remote session useless until somebody walked to the machine.
=======

### `pairing` is the one that produces credentials

Exercising every other capability does something _with_ this machine. Exercising `pairing` hands
**another device** access to it, and a minted device credential outlives the decision that allowed it —
so it is worth saying out loud why it needs no exception to the permissive default:

- **A browser is always a paired device.** That is the whole reason this capability exists. `POST
/v1/pair/code` used to be `host`-scoped, and `host` is refused unless the caller authenticated with
  the admin token — a file on the machine. So the UI could not add a second device even while running
  _on_ the machine, and "add a device" had no home outside a terminal. The routes now sit at `admin`
  scope with a `pairing` demand, which is the layer that can say "loopback yes, remote by decision".
- **The scope move widens the layer beneath this one.** Any paired device reaching the daemon over
  loopback can now mint. That is the loopback principle applied consistently — somebody at the machine
  already has the machine — and a grant cannot narrow it, because a grant only ever governs a caller
  who is not on this host. It is stated here rather than discovered, because it is the part of the
  design a reviewer should agree to.
- **Its safety is the one-way gate, not its default.** A caller who is not on the host may switch
  `pairing` **off** and can never switch it back **on**. An operator who decides that only the machine
  itself hands out credentials therefore makes a decision that sticks: a stolen phone cannot restore an
  access its owner revoked, and it cannot re-grant itself the ability to mint more.
- **Revoking is on the `use` axis, deliberately.** Ending a code and ending a device's access are both
  _exercising_ pairing rather than changing how the host behaves. Putting either behind `configure`
  would add a gate between a person and a stolen phone at the one moment it matters.
- **Revoke the stolen device FIRST, then switch `pairing` off.** The two acts carry the same demand, so
  turning the capability off away from the machine also refuses `DELETE /v1/pair/devices/:deviceId` — and
  turning it back on is a local act. Reaching for the coarse switch first therefore locks you out of the
  remedy until you are at the machine. Nothing is unsafe when that happens (the thief cannot mint either,
  and everything is recoverable on the host), but the order matters and is stated here rather than
  discovered. Splitting revoke onto its own axis would fix the sequence by making revoking harder than
  granting, which is the trade this whole section refuses.

## Before you add capability seven: the coarse switch usually disables the remedy

> **Any control that can lock somebody out has to carry the way back at the point of decision, not in a
> doc.** A document is read afterwards; the lockout happens at the click.

This has now turned up three times, in two subsystems that share no code — which is what makes it
doctrine rather than a quirk of this feature:

1. **`fleet`, `terminal`, `browser`, `filesystem`, `warden`** — switching one off from a paired device is
   the change that device can never undo, because turning anything back on is a local act. So the widen
   refusal **names the host command**, and turning a capability off from a remote browser **warns before
   rather than after**.
2. **`pairing`** — switching it off in response to a stolen phone also refuses
   `DELETE /v1/pair/devices/:deviceId`, so the coarse switch disables the revoke that was the actual
   remedy. Hence the ordering in the section above, stated where somebody reaches for the switch.
3. **The state-home refusal** — outside grants entirely, with no capability involved: a daemon that
   cannot claim its state home **names `fy daemon adopt`** rather than reporting that it failed.

Every one is safe and every one is recoverable at the machine. None was fixed by changing a permission,
and that is the part worth carrying forward. Splitting a remedy onto its own axis to fix a sequence would
make revoking harder than granting, which inverts the asymmetry the whole design rests on.

So when a seventh capability is added, ask in this order:

1. What does somebody reach for this switch to STOP?
2. Does switching it off also stop the thing that undoes it?
3. If so, put the way back **on the control** — the command to run, or the ordering to follow — because
   whoever needs it is looking at the switch, not at this file.

A capability whose coarse switch disables its own remedy is not a flaw to be gated away. It is a one-way
door, and a one-way door has to be **labelled on the side somebody approaches it from.**

Each instance above cites a command. **Verify a cited command exists before adding one**, and verify it a
second way: `rg -n --fixed-strings "fy daemon adopt"`. Not `rg -r` — that is `--replace`, so
`rg -rn "adopt" src` prints every hit with `adopt` rewritten to `n`, which reads as "the command is not
there". That mistake was made while writing this section, and it would have cited a non-existent command as
evidence for a rule. A doc arguing from a command nobody can run is worse than no doc.

## Permissive by default; the password is the layer

Both axes default to **enabled** for all six. The product should let a person do as much as possible
from the UI, and the security model is something a cautious operator turns **on** rather than a wall
everyone starts behind.

> > > > > > > 141154ed (feat(pwa): add a device to one daemon from the browser)

**The primary security layer is locality, not the password.** A remote caller can never turn a
capability on. The operator password is a _second, optional_ lock over remote **configure**, for an
operator who wants one.

**What this does not reduce, stated rather than discovered:** locality bounds what a remote caller may
_grant_, and says nothing about what an already-granted capability may _do_. `terminal.use` is
arbitrary code on the host; `fleet.use` composes changes that write executables. A paired device is
trusted with those by default — so **pairing**, not this layer, is where that decision is actually
made.

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

## Widening is a local act. There is no remote path to it.

| act                                | local (loopback) | remote (governed)                              |
| ---------------------------------- | ---------------- | ---------------------------------------------- |
| turn **on** (off→on)               | allowed          | **never — password or no password**            |
| turn **off** (on→off)              | allowed          | allowed                                        |
| configure a capability that is on  | allowed          | allowed; the password gates it when one is set |
| configure a capability that is off | allowed          | refused — it is off                            |

A patch that widens one capability and narrows another is refused **entirely**. A half-applied widen
leaves the operator with a machine in a state they did not ask for and were not told about, and the
refusal they saw is indistinguishable from a total one.

**This is a one-way door, and that is the trade.** An operator who switches something off from a phone
cannot switch it back on from that phone. It is what makes the rule safe, and it is also a way to lock
yourself out of your own machine — so the refusal names the remedy exactly, and `mayGrant` on every
capability view lets a UI say so _before_ somebody walks through, rather than after.

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

## Finding out without reading this document

Every refusal names a command that fixes it. That is the point of the layer, not a nicety — a person
meeting a denial should not have to know this file exists:

| refusal        | what the sentence says to do                                                                   |
| -------------- | ---------------------------------------------------------------------------------------------- |
| `not-granted`  | `fy daemon config set <capability> --use` / `--configure`, on the host                         |
| `locked`       | enter the password — or, if you do not have it, `fy daemon password set` / `clear` at the host |
| `rate-limited` | wait for the lockout, or `fy daemon password set` at the host                                  |
| `undetermined` | `fy daemon config` on the host, to see and repair the document                                 |

`locked` is the one worth explaining. Its reader may not be the operator: the axis is granted, nothing
is broken, and "unlock first" is a complete instruction for whoever holds the password and **no
instruction at all** for whoever does not. It names both remedies and says which is whose.

`fyd --check` states the posture in one line, and states it **after** answering whether anything off
the host can reach this daemon at all:

```
grants       nothing off this host can reach this daemon (host 127.0.0.1, no relay), so no grant applies today
```

```
grants       reachable off this host (the relay at wss://…) — a remote caller may use everything, and change settings for everything
             ! no operator password is set, so any paired device can change this machine's fleet and settings without one; set one with `fy daemon password set`
```

Reachability counts the **relay**, not just the bind address. The daemon dials _out_ to a rendezvous,
so a loopback bind is reachable from anywhere the moment a relay is enabled — a check that read `host`
alone would tell somebody running the hosted relay that nothing could reach them. And on a daemon
nothing can reach, the capabilities are not recited at all: that would be noise implying a boundary
which is not doing anything.

## Changes take effect immediately

`fy daemon config set …` writes the document and moves the daemon's in-memory answer in the same
call, so the next request is decided by the new one. **No restart.**

The case that _does_ need a restart is a document edited by hand behind the daemon's back, and the
command says so at the moment somebody might be tempted to do that instead.

## Declared GAPs

- **An SSH tunnel to the daemon port reads as loopback**, because the socket genuinely is local. The
  model accepts this — a tunnel needs shell access, and anybody with that can read the admin token
  anyway — but `pairing` is the capability where it matters most, so it is written down rather than
  discovered.
- **`configure` has no route of its own for `terminal`, `browser`, `filesystem` or `pairing`.** Those four
  subsystems have no host settings the API can change today, so their configure axis governs exactly
  one thing: whether a remote caller may re-grant that capability. It is not decoration — it is the
  coarse switch's own lock — but it is narrower than `fleet` and `warden`, whose configure axis gates
  real host-changing routes (`PUT /v1/fleet/environment`, `POST /v1/fleet/apply`,
  `PATCH /v1/warden/config`).
- ~~The audit journal has no read surface.~~ **Closed.** `GET /v1/grants/audit` and
  `fy daemon config history` (alias `log`) read the tail of `state/grant-audit.jsonl`. The read is
  `admin` scope rather than the grant read’s `warden`, because it names DEVICES; it is bounded to a
  64 KiB window of the file and the newest 50 records; and a line it cannot parse is **counted and
  reported**, never dropped — a truncated or tampered journal must not read as a clean history.
- **The daemon's fleet event stream (`GET /v1/events`) is not governed.** It carries session events
  the whole UI depends on rather than fleet configuration, so tying it to the `fleet` capability
  would make revoking `fleet` break the session list. If a future event kind carries fleet
  configuration, it needs its own decision.
