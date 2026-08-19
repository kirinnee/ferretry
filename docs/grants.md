# Capability grants — what a caller who is not on this host may do

Read this before describing what grants protect against, because the useful property is narrower
than the name suggests.

## The one-sentence version

**The host's command line is ungoverned; a local browser is ungoverned once it unlocks. Everything
else here is about the caller who reached this daemon from somewhere else** — a paired phone, a
browser across the network, a session carried over the relay.

## Why the host command line is exempt

Somebody standing at the machine already _has_ the machine. They can edit
`<FY_HOME>/config/daemon.json`, run `fy` directly, or start any program they like. A permission model
that gated the command line would add friction and no safety — and it would slam the one door a
**forgotten password** can still be repaired through, which is the whole reason this feature cannot
brick a machine. `fy` authenticates with the admin token, and reading that file already requires
being on the host.

## Why a local browser is not

A **browser is a paired device wherever it runs**, including on the machine itself. An unattended tab
on somebody's desk was one tap from provisioning the host — writing runnable wrappers into their
accounts — so a local browser is governed by everything below **until it presents an unlock**, and
ungoverned afterwards. One gate at the door, then full authority; no per-action prompt and no second
gate. That is exactly what `sudo` provides.

**It is friction, not a boundary, and no comment in this repository may say otherwise.** A person at
that keyboard can open a terminal, read the admin token and do all of it anyway. What the gate buys is
that a destructive change is _deliberate_: it defends against a slip, casual misuse and a tab left
open. It does not defend against an attacker with local access.

**A machine with no password cannot ask for one**, so a local browser there is ungoverned as it always
was. That is the state every new install starts in: **no setup, no questionnaire and no password** to
be useful. A password is required when a **device** is paired ([pairing](pairing.md)), which is the
moment remote access starts existing — and the **daemon** is what requires it, so it does not matter
whether the pairing was started from the browser or from `fy pair`. `fy daemon start` also offers to set
one when a person is watching, but that is convenience: a service-manager start has no terminal to ask
at, so the refusal at pairing is what makes the requirement a promise rather than a habit.

So the answer has four cases rather than two:

| caller                                      | governed?                         |
| ------------------------------------------- | --------------------------------- |
| `fy` on the host (admin token, loopback)    | no, always                        |
| a local browser, no password on the machine | no — there is no gate to pass     |
| a local browser, password set, no unlock    | **yes** — until it unlocks        |
| a local browser, password set, unlocked     | no, for the unlock's five minutes |
| anything off the host                       | yes, unconditionally              |

`GrantsView` therefore carries **two** booleans rather than one: `governed` (do the limits apply to
me) and `hostLocal` (did this request arrive on the machine). They used to be exact inverses; they are
not any more, and a UI that derived one from the other would badge somebody standing at the machine as
remote the moment their unlock expired. Widening still follows `hostLocal` — see the table below.

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
| `filesystem` | reading session working trees and registering projects on the host     |
| `warden`     | supervision status, sweeps and the warden configuration                |
| `pairing`    | pairing codes, the paired-device list, and Web Push enrolment          |

Each has two axes, and they are different questions:

- **use** — may the caller exercise the capability at all?
- **configure** — may the caller change how it behaves on this host?

The list is closed. Everything the daemon does _inside its own state home_ — sessions, tasks,
attention, pins — is deliberately absent: a grant list that grew to cover every route would be a
second copy of the route table, and a second copy is how the two stop agreeing.

## Permissive by default; LOCALITY is the layer

Both axes default to **enabled** for every capability. The dangerous act is structurally
unavailable to a remote caller, so starting open costs much less than it would otherwise, and starting
closed would make a fresh remote session useless until somebody walked to the machine.

**The primary security layer is locality, not the password.** A remote caller can never turn a
capability on. The operator password is a _second, optional_ lock over remote **configure**, for an
operator who wants one.

**What this does not reduce, stated rather than discovered:** locality bounds what a remote caller may
_grant_, and says nothing about what an already-granted capability may _do_. `terminal.use` is
arbitrary code on the host; `fleet.use` composes changes that write executables. A paired device is
trusted with those by default — so **pairing**, not this layer, is where that decision is actually
made.

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
  loopback can mint — once it is past the operator-password gate, which is where a local browser now
  proves itself. That is the loopback principle applied consistently — somebody at the machine already
  has the machine — and a grant cannot narrow it, because a grant only ever governs a caller who is not
  on this host. It is stated here rather than discovered, because it is the part of the design a
  reviewer should agree to. The PWA additionally refuses to mint the FIRST code until a password exists;
  see [pairing](pairing.md).
- **Its safety is the one-way gate, not its default.** A caller who is not on the host may switch
  `pairing` **off** and can never switch it back **on**. An operator who decides that only the machine
  itself hands out credentials therefore makes a decision that sticks: a stolen phone cannot restore an
  access its owner revoked, and it cannot re-grant itself the ability to mint more.
- **`pairing` governs MINTING, never redemption — on every carrier.** Redemption's credential is the
  code itself: `POST /v1/pair` is public because the redeeming device has no other credential yet, and
  the relayed redemption (`relay-protocol.md` §14) is a sealed record on a pre-auth session for exactly
  the same reason. So an operator who switches `pairing` off has not switched off a redemption path —
  they have stopped new codes from existing, and with nothing minted there is nothing to redeem,
  directly or through a rendezvous. The exposure of the gap is bounded by the live code's two minutes,
  and it is stated here rather than discovered during an incident.
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
   remedy. Hence the ordering in the section above **and on the control itself**: the remote turn-off
   warning for `pairing` carries "revoke that device FIRST", from
   `COARSE_SWITCH_ALSO_STOPS` in `packages/pwa/src/lib/grants.ts`. The doc records the reasoning; the
   switch carries the order, because that is where somebody is standing.
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

That is one of three tools this feature caught giving a confident wrong answer, and the shape is worth
carrying: **a tool answering is not a tool agreeing.**

| tool                       | the question you asked    | the question it answered                            |
| -------------------------- | ------------------------- | --------------------------------------------------- |
| `rg -r`                    | does this string appear?  | here is every hit, rewritten (`--replace`)          |
| `git branch -r --contains` | did this content ship?    | is this SHA an ancestor? (never, after a squash)    |
| `treefmt`                  | is this file well formed? | it is now — a conflict marker became valid Markdown |

The third is the one that needed a gate rather than a note, because nothing was mis-read: every check was
right about the artefact it was handed, and the formatter had changed the artefact. See
`scripts/validate/conflict-markers.sh`, which knows the laundered shape as well as the raw one.

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
- **A local browser can also set and replace it** — `PUT /v1/grants/password`, which is
  `privilegedOnly`, so no caller off the host reaches it whatever credential it holds. Replacing an
  existing one needs an unlock, because a browser that could rewrite the password it cannot prove would
  make the gate one tap wide. Setting the **first** one needs nothing: there is no gate yet.
- **Setting a password is ONE-WAY. Nothing removes one.** There is no `fy daemon password clear`, no
  request body that means "remove it" — `GrantPasswordRequestSchema` requires the field — and no port
  method below it that could express one. The reason is the whole point of the layer: removing a
  password **revokes no device**. `PairingService.mint` refuses to hand out a code without a password,
  so a device credential only ever exists on a machine that had one; a removal therefore leaves that
  machine with **paired devices and no gate**, which is the one state the rest of this document treats
  as unreachable. A warning beside the button was the whole mitigation, and a warning is not a rule.
  - **The cost, accepted knowingly.** Somebody who sets a password and never pairs anything has no
    route back to a passwordless machine: they unlock to change local settings from a browser, for a
    hole that in their case was never open. That is the trade.
  - **The narrower alternative, considered and not taken.** `clear` could have refused only while
    paired devices exist — closing the hole and preserving the way back for a solo local user. The
    owner chose outright removal instead: one rule with no state in it, rather than a verb whose
    availability depends on a list somebody has to check.
- **`fy daemon password set` never asks for the old password, and that door must stay open.** It is the
  escape hatch, and with nothing able to remove a password it is the ONLY one: a local browser needs the
  current password to move it, so a forgotten password would otherwise brick the daemon forever — no
  remote path, no local path, nothing. The admin token is
  ungoverned for exactly this reason (`isGovernedCaller`), the UI names the command wherever somebody
  could get stuck, and `packages/daemon/tests/unit/{grants/service,runtime/mounts/grants}.test.ts`
  assert recovery from a state where the password is unknown.
- **`fy daemon reset` is the second escape hatch, and it never asks for the password either.** It stops
  the daemon and removes both trees this installation occupies — the state home, and the client-owned
  artifacts under `XDG_STATE_HOME` — so the machine comes back with no password, no paired devices and
  no secrets at all. Gating it on the password would close the door it exists to open. It is destructive
  rather than a repair, so it prints every path, its size, and how many secrets, devices and sessions
  are about to go before it asks for a typed confirmation; `--yes` is for scripts. **The browser has no
  equivalent**, and that is not an omission: a reset destroys the device grant the browser is
  authenticated by and stops the daemon serving it, so the request could never be answered. Reset is a
  thing somebody does at the machine.
- **Every held unlock dies when the password moves.** Rotating after a device is lost achieves nothing
  if what the old one bought survives it, so the browser drops its own held token too rather than
  presenting an authority the machine has already withdrawn.

### Where the browser asks for it

**One prompt, and it is a modal raised at the moment authority is needed** —
`features/settings/operator-unlock-dialog.tsx`, which the grants surface and the fleet cockpit both use.
There is deliberately no second implementation: two inline password fields worded differently is how one
capability came to describe its own authority in terms no other capability used.

**The shape is what the presentation gets wrong, and it got it wrong once already.** The mechanism has
behaved like `sudo` since `#362` — one typed password mints the unlock, rides the request that needed it,
and is not asked for again while the unlock is held. What a person MET was an inline password field inside
a staged-change card, under an expiry and a config revision, beside Confirm-and-Apply. So the screen said
_authorisation for this one action_ while the code said _unlock this machine_, and the owner read it the
way it was drawn. A prompt that arrives on the click, names what it unlocks, and leaves is the same
mechanism told truthfully.

- **The scope and the lifetime are stated once, in the prompt** (`UNLOCK_HOLDING_NOTE`): the window, that
  it covers everything changed inside it, that this screen holds it, and that closing the page ends it.
  **Not repeated beside each control the unlock then covers** — a note at every control teaches people
  the product nags and re-creates the per-action framing.
- **A per-change confirmation says something different, because it IS different.** It mints nothing and is
  spent inside the request that carries it, so the prompt for one must not promise a window: the dialog
  branches on whether the value becomes a held unlock.
- **Past the gate, the panel stops advertising a gate.** A surface that has just minted an unlock re-reads
  its own permissions WITH the token, so what it renders is what the daemon would now answer — otherwise
  it goes on claiming a password is owed while the apply beside it needs none, which is the one-gate model
  reported wrongly.
- **The prompt appears only where an unlock would help.** Where no password exists there is nothing to
  unlock and no prompt at all, and a refusal an unlock cannot fix gets its sentence and no prompt
  (`GrantGuidance.offersUnlock`).

## The per-change confirmation: `fleet.configure` asks once more

**One route asks a governed caller to prove the operator password again, against one exact staged change:
`POST /v1/fleet/proposals/:proposalId/apply`.** It is worth its own section because it looks like a second
gate and is not one.

- **It is the SAME secret, and the SAME budget.** The password travels in the apply body, is checked by
  `CapabilityGrantService.confirmChange`, and spends one of the same five tries an unlock spends, with the
  same fifteen-minute lockout. There is no second credential, no second lifetime, and no second refusal
  vocabulary — which is precisely what the mechanism it replaced had, and why it was deleted
  ([fleet-authority-unification](design/fleet-authority-unification.md)).
- **It mints nothing.** An unlock is a bearer value good for five minutes and any number of `configure`
  demands. This is spent inside the one request that carries it and leaves nothing behind, which is the
  whole of what "bound to one diff" means. **What it buys is narrow and worth stating narrowly:** a
  borrowed or replayed unlock is not by itself enough to write executable wrappers into somebody's home.
  It buys nothing at all against a caller that has the password.
- **An UNGOVERNED caller is asked for nothing.** The host's own command line, and a browser on this machine
  that has already unlocked, apply a fleet change with no prompt of any kind. `#358` established that
  shape — one gate at the door, then full authority, the way `sudo` behaves — and adding a per-action
  prompt behind it would be the patchwork this document exists to refuse.
- **A machine with no operator password is asked for nothing either.** There is no secret to bind a change
  to, and a control that cannot refuse is theatre. The capability layer reports that state as `ungated`
  rather than `granted` for exactly this reason: so a surface can say once, beside the control, that
  nothing is standing behind it.
- **The confirmation happens BEFORE the change is spent.** A mistyped password must not burn a staged
  change the caller was entitled to apply, which would make the mechanism a denial of service against the
  person it exists to ask.
- `GET /v1/fleet/permissions` carries `confirmation: 'none' | 'operator-password'` so a panel says this
  before somebody clicks, and `applyRefusal` is the shared `GrantRefusal`, so the fleet panel words a
  refusal exactly as the grants panel does.

**Why only the fleet.** Every capability can do damage, and this is not a claim that the fleet's is worse
in kind. It is that a fleet apply is a discrete, reviewable artifact — a numbered manifest of writes a
person reads before agreeing — so there is something for a confirmation to be _bound to_. `terminal.use` is
a stream of arbitrary code with no such boundary; a per-change prompt there would be a per-keystroke prompt,
which is the control that trains people to click through. If a second capability ever grows a reviewable
artifact, the machinery is `CallerGovernance.confirmChange` and it is not fleet-specific.

## Widening is a local act. There is no remote path to it.

"Local" below means **on the host and past the gate** — `fy`, or a browser that has unlocked (or a
machine with no password at all). A local browser that has _not_ unlocked reads the `locked` refusal on
`configure` and on any widen, and its remedy is the password rather than a command to run on the host it
is already sitting at.

| act                                | local (past the gate) | remote (governed)                              |
| ---------------------------------- | --------------------- | ---------------------------------------------- |
| turn **on** (off→on)               | allowed               | **never — password or no password**            |
| turn **off** (on→off)              | allowed               | allowed                                        |
| configure a capability that is on  | allowed               | allowed; the password gates it when one is set |
| configure a capability that is off | allowed               | refused — it is off                            |

Widening follows **`hostLocal`, not `governed`**: a local browser waiting to unlock may still widen once
it has, so `mayGrant` stays true for it. Reporting `false` there would tell somebody standing at the
machine that a door they can reopen is shut for good.

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

The grant layer is consulted **after** authentication and after the route's credential minimum and
`privilegedOnly` checks. Every branch either keeps the answer those produced or removes it. There is no input that
turns a refused route into a served one — a device token cannot reach an `admin-token` route because a
grant says `use: true`, and no document an operator writes can make it.

## Unknown is not permitted

Permissive **defaults** settle what an operator's _silence_ meant. They say nothing about damage.

- A document with no `grants` key is a **complete** answer: every axis takes the product default.
- A document whose `grants` key is **wrong** — an unknown capability, a string where a boolean
  belongs — fails to parse, and the boot refuses rather than falling back to anything.
- A grant document that becomes unreadable at runtime sets the enforced answer to `undetermined`, and
  every governed capability is refused until a human repairs it.

## Where it lives

| thing                      | path                                                                    |
| -------------------------- | ----------------------------------------------------------------------- |
| the wire contract          | `packages/protocol/src/lib/grants.ts`                                   |
| the decision               | `packages/daemon/src/lib/grants/`                                       |
| the authorization boundary | `packages/daemon/src/lib/api/capability.ts`, `dispatcher.ts`            |
| the routes                 | `packages/daemon/src/lib/runtime/mounts/grants.ts`                      |
| the grants themselves      | `<FY_HOME>/config/daemon.json`, under `grants`                          |
| the password verifier      | `<FY_HOME>/state/operator-password.json` (mode 0600)                    |
| the change record          | `<FY_HOME>/state/grant-audit.jsonl`, read by `fy daemon config history` |
| the command line           | `fy daemon config`, `fy daemon password`                                |
| all of it, removed         | `fy daemon reset` on the host — both roots, no password required        |

`fyd --print-config` reports every capability with its **origin** — `default` or `config file` — the
same provenance treatment every other value gets, because a person reading a permission report is
usually asking which of these they chose and which something chose for them.

## Finding out without reading this document

Every refusal names a command that fixes it. That is the point of the layer, not a nicety — a person
meeting a denial should not have to know this file exists:

| refusal        | what the sentence says to do                                                         |
| -------------- | ------------------------------------------------------------------------------------ |
| `not-granted`  | `fy daemon config set <capability> --use` / `--configure`, on the host               |
| `locked`       | enter the password — or, if you do not have it, `fy daemon password set` at the host |
| `rate-limited` | wait for the lockout, or `fy daemon password set` at the host                        |
| `undetermined` | `fy daemon config` on the host, to see and repair the document                       |

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
- **The local browser gate is bypassable by design, and only the browser is gated.** Anybody at that
  keyboard can open a terminal, read the admin token and change everything without the password. The
  gate buys deliberateness against slips and unattended tabs, nothing more, and the escape hatch it
  depends on is the same door that makes it bypassable. There is no version of this that is both
  unbypassable and recoverable, and recoverable is the one that was chosen.
- ~~The first-password requirement lives in the PWA's pairing flow, not in the daemon.~~ **Closed.**
  `POST /v1/pair/code` refuses while no operator password exists, for **every** caller — a phone, a
  browser on the machine, and `fy pair` on the host, which mints through that same route. The guarantee
  is therefore "**no passwordless remote device can be created**", not "the browser will not create one".
  The rule is `PairingService.mint`, which answers a refusal instead of a code; the browser's panel is a
  **pre-check** that explains before somebody taps, and `fy pair` prints the daemon's sentence. One rule,
  one sentence, and no second copy to drift. The check is at the **mint**, which used to leave a window:
  a code minted while a password existed still redeemed if the password was removed inside that code's
  two minutes. Nothing removes a password any more, so nothing can open that window — and the check
  stays where it is regardless, because expiring a live code somebody is walking to their phone to scan
  would be a rule reaching backwards.
- **A daemon started by a service manager can still come up passwordless, and that is not a hole.**
  `fy daemon start` offers to set the first password when a person is there to answer — and only then:
  systemd and launchd run the daemon executable with no terminal, so a prompt there would hang the unit
  and the machine would silently stop running the daemon at boot. Startup prompting is therefore
  convenience and can never be the promise; **pairing refusing is the promise**, and it holds however the
  daemon was started.
- **An install that already has paired devices and no password is not migrated.** Nothing nags it and
  nothing is revoked; the requirement lands at its **next** pairing, which needs no separate prompt and
  cannot lock anybody out. Such an operator can also set one at any time from a local browser or with
  `fy daemon password set`.
- **`configure` has no route of its own for `terminal`, `browser` or `pairing`.** Those three
  subsystems have no host settings the API can change today, so their configure axis governs exactly
  one thing: whether a remote caller may re-grant that capability. It is not decoration — it is the
  coarse switch's own lock. `filesystem.configure` also gates `POST /v1/projects`, because registering
  a project may create a directory, initialise Git or clone a repository at an arbitrary absolute host
  path. Like the real host-changing routes governed by `fleet.configure` and `warden.configure`, this
  remains permissive by default and does not govern the host's own command line.
- ~~The audit journal has no read surface.~~ **Closed.** `GET /v1/grants/audit` and
  `fy daemon config history` (alias `log`) read the tail of `state/grant-audit.jsonl`. The read is
  `admin` scope rather than the grant read’s `warden`, because it names DEVICES; it is bounded to a
  64 KiB window of the file and the newest 50 records; and a line it cannot parse is **counted and
  reported**, never dropped — a truncated or tampered journal must not read as a clean history.
- **The daemon's fleet event stream (`GET /v1/events`) is not governed.** It carries session events
  the whole UI depends on rather than fleet configuration, so tying it to the `fleet` capability
  would make revoking `fleet` break the session list. If a future event kind carries fleet
  configuration, it needs its own decision.
- **Web Push enrolment is governed by `pairing`, not by a capability of its own.** The four
  `/v1/push/*` routes each demand `pairing.use`, because what they do is device management: only a
  paired device may enrol, the enrolment is filed against that device's grant, and revoking the grant
  destroys it. Pairing is _who may reach this daemon_; push is _who this daemon may reach_; one
  operator decision about devices governs both, and the list above stays closed.

  **The honest cost, stated rather than discovered:** an operator who switches `pairing` off for
  remote callers also loses remote enrolment **and** remote un-enrolment. That is coherent — both are
  device management, and revoking a device still takes its notifications with it from anywhere — but it
  is not the same thing as a switch labelled "notifications". If a separately nameable notification
  decision is wanted, it is one constant in `packages/daemon/src/lib/runtime/mounts/push.ts` plus
  wherever a capability is declared; that second half is what the unified configuration model owns, and
  adding a seventh member here before it lands would be the duplication that model exists to remove.
