# Capability grants — what a caller who is not on this host may do

Read this before describing what grants protect against, because the useful property is narrower
than the name suggests.

## The one-sentence version

**A caller that arrived on the host is ungoverned. Everything here is about the caller that did not** — a
paired phone, a browser across the network, a session carried over the relay — which may do what the
operator granted, and needs a passkey step-up for the dangerous parts.

## Why the host command line is exempt

Somebody standing at the machine already _has_ the machine. They can edit
`<FY_HOME>/config/daemon.json`, run `fy` directly, or start any program they like. A permission model
that gated the command line would add friction and no safety — and it would slam the one door a
**lost passkey** or a mis-narrowed device can still be repaired through, which is the whole reason this
feature cannot brick a machine. `fy` authenticates with the admin token, and reading that file already
requires being on the host.

## A browser on the host is ungoverned too — when the host is proven

A **browser is a paired device wherever it runs**, including on the machine itself. Whether it is governed
is decided by how its request **arrived**, not by who it claims to be: a browser whose request came over a
carrier that proved the host (see below) is ungoverned, and every other browser is governed. There is no
unlock to present and no password to set — **a fresh install needs no setup, no questionnaire and no secret**
to be useful, and the only thing that moves a caller from governed to ungoverned is being at the machine.

**It is friction, not a boundary, and no comment in this repository may say otherwise.** A person at
that keyboard can open a terminal, read the admin token and do all of it anyway; a browser tab left open on
the host is not protected by any of this. What the model buys is that a remote caller is bounded and
deliberate, not that the host is defended against somebody sitting at it.

The answer has three cases:

| caller                                                | governed?            |
| ----------------------------------------------------- | -------------------- |
| `fy` on the host (admin token, loopback)              | no, always           |
| a browser whose request arrived on a host-proven path | no                   |
| anything else                                         | yes, unconditionally |

`GrantsView` carries `governed` (do the limits apply to me), `hostLocal` (did this request arrive on the
machine) and `steppedUp` (does this device hold a passkey step-up right now). Today `hostLocal` is exactly
`!governed`; the two stay separate fields because they are different questions, and a UI that derived one
from the other would have to be rewritten the day a third caller class appears.

## "Loopback" means how the request arrived

This is the single detail that decides whether the design is sound rather than a hole.

The relay **terminates on the host it serves**. A check that read a peer address, a `Host` header or
a URL containing `127.0.0.1` would see loopback for a phone on the other side of the world and hand
it the machine.

`ApiRequest.loopback` is therefore **carrier-derived**:

- the Bun transport sets it from the socket's real remote address;
- `tunnelApiRequest` (the session hop) sets it from the session's **arrival**: `false`
  **unconditionally** for a relayed session, whatever address the request appears to carry, and for a
  direct session exactly what the listener decided for its WebSocket upgrade — the same answer the
  same listener gives an HTTP request — and nothing inside a record can change it.

Nothing re-derives it, and no header can move it.
`packages/daemon/tests/unit/grants/policy.test.ts` asserts exactly this with a relayed request that
presents every loopback-looking signal it can.

**A loopback peer is still not proof of the host.** A remote caller forwarded through a locally bound
proxy (`tailscale serve`, `cloudflared`) arrives from a loopback peer too, so every host-locality rule
— `privilegedOnly` routes, widening (`hostLocal`) and whether a caller is governed — reads
`arrivedOnHost` in `packages/daemon/src/lib/api/http.ts` instead of `loopback`. It admits:

- a request whose carrier proved the host (`privilegedLoopback`: a loopback-only bind that advertises
  no foreign address, `mayTrustDirectLoopback`), or
- the host's **admin token** over a loopback peer — reading that token already needs this machine's
  disk, and without it the host's own command line would stop working on a daemon bound beyond loopback.

The consequence, stated plainly: on a daemon bound to a wildcard address or advertised through a proxy,
a **browser on the same machine is treated as remote** — governed, needing a step-up for the dangerous
acts and unable to widen. `fy` on the host still can.

## Six capabilities, two axes

| capability   | what it covers                                                                                      |
| ------------ | --------------------------------------------------------------------------------------------------- |
| `fleet`      | the machine, its credentials, components, profiles and runtimes, and the proposals that change them |
| `terminal`   | opening, writing to and streaming session terminals                                                 |
| `browser`    | the human login window and per-session browser control                                              |
| `filesystem` | reading session working trees and registering projects on the host                                  |
| `warden`     | supervision status, sweeps and the warden configuration                                             |
| `pairing`    | pairing codes, the paired-device list, and Web Push enrolment                                       |

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

**The primary security layer is locality.** A remote caller can never turn a capability on. The passkey
step-up is the **second layer**, over every remote `configure` and the remote `use` of `terminal`,
`browser` and `pairing`; it needs no setup beyond pairing, because the passkey is the one the person
already holds.

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
  loopback can mint **when its request arrived on a host-proven carrier**. That is the loopback principle
  applied consistently — somebody at the machine already has the machine — and a grant cannot narrow it,
  because a grant only ever governs a caller who is not on this host. It is stated here rather than
  discovered, because it is the part of the design a reviewer should agree to. A governed caller minting
  needs a step-up (`pairing.use`); see [pairing](pairing.md).
- **Its safety is the one-way gate, not its default.** A caller who is not on the host may switch
  `pairing` **off** and can never switch it back **on**. An operator who decides that only the machine
  itself hands out credentials therefore makes a decision that sticks: a stolen phone cannot restore an
  access its owner revoked, and it cannot re-grant itself the ability to mint more.
- **`pairing` governs MINTING, never redemption — on every carrier.** Redemption's credential is the
  code itself: redemption is a sealed record on a pre-auth session (`relay-protocol.md` §14), on the
  direct carrier and over a relay alike, because the redeeming device has no other credential yet —
  there is no redemption route at all. So an operator who switches `pairing` off has not switched off a redemption path —
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

## The passkey step-up

There is no operator password. The passkey step-up replaced it for every purpose it had — the local
browser's unlock, the remote `configure` lock and the per-change confirmation — and **nothing is kept for
compatibility**. [design/zero-trust.md](design/zero-trust.md) B owns the ceremony (who verifies it, the
step-up window, which origin a passkey belongs to); this section owns what the grant layer does with it.
The window is the `stepUpWindowMinutes` security setting (0–60, default 15); at `0` a step-up admits
exactly one act and the boundary spends it.

**What needs one.** A **governed** caller needs a current step-up for:

- **every `configure` demand**, on every capability; and
- **`use` of `terminal`, `browser` and `pairing`** — session terminals are arbitrary code on the host, the
  browser capability drives a browser the operator is signed into, and pairing hands out credentials.

Every other `use` — reading the fleet, the filesystem view, supervision status — is ordinary operation and
needs nothing beyond the grant. The rule is one predicate, `demandNeedsStepUp`, read by the same place that
reads the grant, so the two cannot drift.

- **A step-up is a fact about a device and an app session, held in the daemon's memory.** The browser never
  holds a value it could replay, so there is no token to steal, no header and no lifetime to configure here.
  `GrantsView.steppedUp` reports it, always `false` for a caller with no proven device.
- **The refusal is `step-up-required`**, wire code `grant_step_up_required` (`STEP_UP_REQUIRED_CODE`). The
  axis is granted and nothing is broken; the next step is a passkey confirmation on the same device and
  then the one retry. The grants route answers with the same code as the authorization boundary, so the
  browser's single retry-after-confirmation path covers both.
- **There is nothing on the machine to guess or forget.** There is no secret to be rate limited, rotated,
  forgotten or recovered. A device with no passkey registers one within its pairing window; losing every
  passkey is repaired at the machine, which is where recovery already lived.
- **A remote warden is governed and can never step up.** Its credential is not a paired device, so it has
  no passkey to present: `warden.configure` is therefore unreachable to it, while `warden.use` — which needs
  no step-up — is unchanged.
- **A stale `state/operator-password.json` is deleted at boot**, with one notice line. Nothing reads it any
  more; leaving it would be a verifier on disk guarding nothing.

### Where the browser asks for it

**One prompt, raised at the moment a refusal says a step-up is needed.** The browser answers
`grant_step_up_required` by running the passkey ceremony through the app's single step-up requirement and
retrying the request once. There is deliberately no second implementation: two prompts worded differently
is how one capability once came to describe its own authority in terms no other used.

- **The prompt is the operating system's**, not a field the page draws, and it asks a person who already
  holds the device. Nothing typed into the page can be captured by the page.
- **A surface that has just stepped up re-reads its own permissions**, so what it renders is what the daemon
  would now answer — otherwise it goes on claiming a confirmation is owed while the action beside it needs
  none.
- **The prompt appears only where a step-up would help.** A refusal a step-up cannot fix (`not-granted`,
  `undetermined`) gets its sentence and no prompt, and a caller on the host is never asked.

### The per-change confirmation is gone, and what that costs

Applying a fleet proposal (`POST /v1/fleet/proposals/:proposalId/apply`) and starting a harness sign-in
(`POST /v1/fleet/login`) used to ask a governed caller for the password again, bound to that one act. They
now sit under the ordinary `fleet.configure` step-up and **ask for nothing in the request body**; the
request schemas are empty objects. That is a real weakening and it is stated rather than discovered:

- The old property was "bound to one diff". The new one is "bound to a biometric check on this device within
  the window". It is weaker against a request an attacker could replay, which a sealed session no longer
  allows, and stronger against a password somebody watched being typed or reused elsewhere.
- Within the window, a step-up covers any number of `configure` acts. There is no per-act confirmation for
  any capability, and none is planned: the artifact worth binding to (a staged diff, one sign-in identity)
  exists only for the fleet, and a prompt on every act of a capability without one trains people to click
  through.
- The remote risk in a sign-in is still **account substitution**, not disclosure: a caller who can start one
  and forward its code can bind this fleet to a provider account THEY control. That is a change to how the
  host behaves, so it sits on `fleet.configure` and the step-up is what stands in front of it.

## Who may change the security settings

The per-machine security settings ([design/zero-trust.md](design/zero-trust.md) B6 — step-up window, key
rotation, presence on opening, idle expiry) follow the same asymmetry as the grants. Changing one is a
`configure` act on `pairing`: `PATCH /v1/security` demands `pairing.configure`, so a remote caller needs
that grant **and** a current step-up, and may only **narrow**. Widening any field is host-only
(`arrivedOnHost`): a remote widen is `403 security_widen_at_machine`, whose sentence names
`fy daemon security set <setting> <value>`. A request that changes several fields is judged field by field
and refused whole if any one widens remotely. Reading them (`GET /v1/security`) needs no capability.

## Widening is a local act. There is no remote path to it.

"Local" below means **arrived on the host** — `fy` with the admin token, or a browser on a host-proven
carrier. A caller that did not arrive on the host is governed, and **no step-up buys it a widening**.

| act                                | on the host (ungoverned) | remote (governed)                          |
| ---------------------------------- | ------------------------ | ------------------------------------------ |
| turn **on** (off→on)               | allowed                  | **never — a step-up does not change this** |
| turn **off** (on→off)              | allowed                  | allowed, **with a step-up**                |
| configure a capability that is on  | allowed                  | allowed, **with a step-up**                |
| configure a capability that is off | allowed                  | refused — it is off (`not-granted`)        |

Widening follows **`hostLocal`**, which is now exactly `!governed`; both stay on the wire because they
answer different questions ("do the limits apply to me" and "did this request arrive at the machine") and a
screen should read the one it means rather than a rule it would have to restate.

A patch that widens one capability and narrows another is refused **entirely**. A half-applied widen
leaves the operator with a machine in a state they did not ask for and were not told about, and the
refusal they saw is indistinguishable from a total one.

**This is a one-way door, and that is the trade.** An operator who switches something off from a phone
cannot switch it back on from that phone. It is what makes the rule safe, and it is also a way to lock
yourself out of your own machine — so the refusal names the remedy exactly, and `mayGrant` on every
capability view lets a UI say so _before_ somebody walks through, rather than after.

Revoking must never be harder than granting. A governed narrowing costs one touch on the device already in
hand — a step-up and nothing else — and never a trip to the host, which is the property that matters in an
incident. It is not free, and the cost is stated: a phone whose passkey the thief cannot use cannot narrow
either, so the remedy for that case is the host.

## A grant only ever narrows

The grant layer is consulted **after** authentication and after the route's credential minimum and
`privilegedOnly` checks. Every branch either keeps the answer those produced or removes it. There is no input that
turns a refused route into a served one — a paired device's session cannot reach an `admin-token`
route because a grant says `use: true`, and no document an operator writes can make it.

## Unknown is not permitted

Permissive **defaults** settle what an operator's _silence_ meant. They say nothing about damage.

- A document with no `grants` key is a **complete** answer: every axis takes the product default.
- A document whose `grants` key is **wrong** — an unknown capability, a string where a boolean
  belongs — fails to parse, and the boot refuses rather than falling back to anything.
- A grant document that becomes unreadable at runtime sets the enforced answer to `undetermined`, and
  every governed capability is refused until a human repairs it.

## Where it lives

| thing                      | path                                                                       |
| -------------------------- | -------------------------------------------------------------------------- |
| the wire contract          | `packages/protocol/src/lib/grants.ts`                                      |
| the decision               | `packages/daemon/src/lib/grants/`                                          |
| the authorization boundary | `packages/daemon/src/lib/api/capability.ts`, `dispatcher.ts`               |
| the routes                 | `packages/daemon/src/lib/runtime/mounts/grants.ts`                         |
| the grants themselves      | `<FY_HOME>/config/daemon.json`, under `grants`                             |
| the change record          | `<FY_HOME>/state/grant-audit.jsonl`, read by `fy daemon config history`    |
| the step-up                | `packages/protocol/src/lib/step-up.ts`, `packages/daemon/src/lib/step-up/` |
| the command line           | `fy daemon config`                                                         |
| all of it, removed         | `fy daemon reset` on the host — both roots                                 |

`fyd --print-config` reports every capability with its **origin** — `default` or `config file` — the
same provenance treatment every other value gets, because a person reading a permission report is
usually asking which of these they chose and which something chose for them.

## Finding out without reading this document

Every refusal names a command that fixes it. That is the point of the layer, not a nicety — a person
meeting a denial should not have to know this file exists:

| refusal            | what the sentence says to do                                              |
| ------------------ | ------------------------------------------------------------------------- |
| `granted`          | nothing — the caller was served                                           |
| `not-granted`      | `fy daemon config set <capability> --use` / `--configure`, on the host    |
| `step-up-required` | confirm with the passkey on this device; the app does it and retries once |
| `undetermined`     | `fy daemon config` on the host, to see and repair the document            |

`step-up-required` is the one worth explaining. The axis is granted and nothing is broken, so it is the only
refusal the **caller** can clear without the operator: the person holding the device confirms and carries on.
A caller that cannot step up at all — a remote warden, which has no device — meets it as a final answer, and
the remedy is the host.

`fyd --check` states the posture in one line, and states it **after** answering whether anything off
the host can reach this daemon at all:

```
grants       nothing off this host can reach this daemon (host 127.0.0.1, no relay), so no grant governs another machine today
```

```
grants       reachable off this host (the relay at wss://…) — a remote caller may use everything, and change settings for everything
```

There is no "set a password" advice beside it, because there is nothing to set: the gate in front of those
changes is the passkey step-up, which a paired device already has the means to satisfy.

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
- **A caller on the host is ungoverned, so a browser tab left open on the host is unprotected.** Anybody at
  that keyboard can open a terminal, read the admin token and change everything; the step-up does not
  defend an unattended host, and no passkey prompt is asked of a browser that arrived on a host-proven
  carrier. That is the same door the recovery path depends on (a lost phone, a lost passkey or a device
  narrowed to nothing is repaired at the machine), and there is no version of this that is both
  unbypassable and recoverable — recoverable is the one that was chosen.
- **A step-up is per device and per app session, and bounds nothing about what the confirmed act does.**
  Within its window a step-up covers any number of `configure` acts and any number of `terminal.use`
  streams. It says "the person holding this device agreed recently", not "this particular diff was read".
  The per-change confirmation that bound an act to one staged change is gone, and the fleet's apply and
  sign-in now rest on the window alone.
- **A remote warden can never step up.** A step-up is a passkey held by a paired device, and a warden has
  no device, so `warden.configure` and every other step-up demand is unreachable to it from off the host.
  It is named here so nobody reads the refusal as a fault.
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

  **A second cost, from the step-up.** `pairing.use` is one of the three `use` demands that need a
  passkey step-up from a governed caller, so a governed device now needs a step-up to subscribe or
  unsubscribe too — a touch that notification enrolment does not otherwise warrant. Moving push off
  `pairing.use` is **B5** in [design/zero-trust.md](design/zero-trust.md) and is out of scope here; this
  is a declared GAP until it lands.
