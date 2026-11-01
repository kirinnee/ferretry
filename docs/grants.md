# Capability grants — what a caller who is not on this host may do

Read this before describing what grants protect against, because the useful property is narrower
than the name suggests.

## The one-sentence version

**Only the owner at the machine — `fy` with the host's admin token — is ungoverned. Everything here is about
every other caller**: a paired phone, a browser across the network, a session carried over the relay, and a
browser on the host itself. Being **governed means needing an unlock**: such a caller can do nothing until its
device unlocks the machine with a passkey, and then may do what the operator granted for the unlock period,
with no further prompt unless the owner asked for one per act.

## Why the host command line is exempt

Somebody standing at the machine already _has_ the machine. They can edit
`<FY_HOME>/config/daemon.json`, run `fy` directly, or start any program they like. A permission model
that gated the command line would add friction and no safety — and it would slam the one door a
**lost passkey** or a mis-narrowed device can still be repaired through, which is the whole reason this
feature cannot brick a machine. `fy` authenticates with the admin token, and reading that file already
requires being on the host.

## A browser on the host is an ordinary device

A **browser is a paired device wherever it runs**, including on the machine itself, and it is **governed like
every other device** (owner decision, 2026-10-13; [design/zero-trust.md](design/zero-trust.md) B4). The reason
is that nothing can tell it apart from a stranger: `ssh -L`, `socat`, `cloudflared`, `tailscale serve` or any
reverse proxy to `127.0.0.1` arrives exactly as a local browser does — a loopback peer, even on a
loopback-only bind. Only the host's admin token proves the owner, because reading it needs this machine's disk.

So a browser on the host confirms the dangerous acts with a passkey, as a phone does, and cannot widen a
grant: that is `fy` at the machine. There is still no password to set and **a fresh install needs no setup,
no questionnaire and no secret** to be useful.

**It is friction, not a boundary, and no comment in this repository may say otherwise.** A person at that
keyboard can open a terminal, read the admin token and do all of it anyway. What the model buys is that every
browser is bounded and deliberate, not that the host is defended against somebody sitting at it.

The answer has two cases:

| caller                                                 | governed?            | person routes?                   |
| ------------------------------------------------------ | -------------------- | -------------------------------- |
| `fy` on the host (admin token, loopback)               | no, always           | yes                              |
| a ferret session (its own `fys_` credential, on host)  | no — not a grant one | never: `403 owner_only`          |
| the admin token naming a ferret's session (older `fy`) | no, always           | never: `403 owner_only`          |
| anything else, a browser on the host too               | yes, unconditionally | yes, a paired device is a person |

`GrantsView` carries `governed` (do the limits apply to me), `hostLocal` (did this request arrive on the
machine) and `steppedUp` (does this device hold a passkey step-up right now). Today `hostLocal` is exactly
`!governed`; the two stay separate fields because they are different questions, and a UI that derived one
from the other would have to be rewritten the day a third caller class appears.

### A ferret session's own credential is not a device

A ferret pane's `FY_SESSION_TOKEN` (`Authorization: Bearer fys_…`) is a bearer class of its own, `session`
([agent-tools.md](agent-tools.md#the-ferret-session-credential)). It is not a grant holder: grants stay
about remote devices, and a session credential never goes through `decideCapability` — it is looked up only
for a request on this machine's privileged loopback carrier, so it is ungoverned like `fy` at the machine.
Its policy is the route's own `caller` declaration instead, a fixed table rather than an operator's answer:

- a `caller: 'person'` route — pairing, devices, passkeys, the step-up and unlock, grants, the security
  settings and the tunnel switch among them, and revoking a session's credential — refuses it with `403 owner_only` before the handler runs or
  the body is read, as it refuses the admin token naming a ferret's session and a warden;
- a `caller: 'any'` route serves it as its own session, never as the owner, and every session it starts is
  its own child (`parent_mismatch` for any other parent).

Neither half can widen anything: the `caller` rule is asked after authentication and only ever refuses, and
every grant question below still applies to every caller it applied to before.

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
- a **tunnel** arrival (protocol §15) reaches the daemon through `cloudflared` from a loopback peer, so
  it never lands on the API listener: the daemon's dedicated tunnel listener serves only the session
  route and stamps every arrival `loopback: false` and unprivileged, exactly like a relayed one.

Nothing re-derives it, and no header can move it.
`packages/daemon/tests/unit/grants/policy.test.ts` asserts exactly this with a relayed request that
presents every loopback-looking signal it can.

**A loopback peer is not proof of the owner.** A remote caller forwarded through a locally bound proxy
(`tailscale serve`, `cloudflared`, `ssh -L`) arrives from a loopback peer too, so every owner rule — widening
(`hostLocal`), whether a caller is governed, and the owner's passkey recovery — reads `arrivedOnHost` in
`packages/daemon/src/lib/api/http.ts` instead of `loopback`. It admits **only the host's admin token over a
loopback peer**: reading that token already needs this machine's disk, so nobody can present it who did not
already have the machine.

The carrier's `privilegedLoopback` proof (a loopback-only bind that advertises no foreign address,
`mayTrustDirectLoopback`) is now about the **place**, never the owner: it admits only `privilegedOnly` routes
— a local terminal attach — through `arrivedPrivileged`, and grants nothing.

## Eight capabilities, two axes

| capability   | what it covers                                                                                                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `fleet`      | the machine, its credentials, components, profiles and runtimes, and the proposals that change them                                                                                                                                  |
| `terminal`   | opening, writing to and streaming session terminals, and typing into a session's own pane (Console)                                                                                                                                  |
| `browser`    | the human login window and per-session browser control                                                                                                                                                                               |
| `filesystem` | reading session working trees, registering projects, and the browser file tools (upload / download / pdf) on the host                                                                                                                |
| `warden`     | supervision status, sweeps and the warden configuration                                                                                                                                                                              |
| `pairing`    | pairing codes, the paired devices and their grants, and other devices' push enrolments                                                                                                                                               |
| `secrets`    | running a command with a stored secret in its environment, listing, setting and deleting secrets                                                                                                                                     |
| `sharing`    | making catalogs of skills and MCP setups, freezing items into them, listing one item in many catalogs, choosing the default catalog, and exporting a signed file ([catalogs.md](catalogs.md#the-publisher-side)); no new passkey act |

**Leaving a ferret alone is `warden.configure`.** `POST /v1/warden/leave` keeps the Warden off one flagged
or cleared ferret for an hour, four, or until its status changes ([config-files.md](config-files.md#the-warden)).
It is not an investigation request (`warden.use`): it switches supervision of that ferret off for a while,
which is how the Warden behaves on this host — so a governed device steps up for it, and a remote warden,
which can never step up, can never quiet its own supervision or anyone else's.

**Updating the daemon is `fleet`.** Reading `GET /v1/daemon/update` is `use`; starting an update and
changing automatic install are `configure`, and a governed device also gives a passkey step-up for that
act alone (turning automatic install off never needs one). See [updating.md](updating.md).
Updating an agent CLI is the same act and the same gate: `GET /v1/harnesses/update` is `use`, `POST
/v1/harnesses/update` is `configure` plus the step-up, and a ferret may never start one.

**Opening a link on this computer is local-only.** `POST /v1/system/open-url` hands one http(s) address to the
operating system's own opener (macOS `open`, `xdg-open`, the Windows URL handler), so a router such as Finicky
picks the browser. It is `privilegedOnly`, decided from the carrier like `/attach`: a relayed, tunnelled or
WebRTC caller gets `403` before the handler runs, whatever it holds. The address is one argv element, never a
shell string; credentials and every non-http(s) scheme are refused; ten openings per ten seconds. The security
log records `link.opened` with the host only, never the path or query.

**The Console is a terminal.** `POST /v1/sessions/:sessionId/console/input` types into the agent's own
Claude / Codex pane and is declared `terminal` / `use` like every terminal route, so it is governed
identically: ungoverned from loopback; for a paired device, a browser across the network or a relayed session,
the `terminal` grant plus a current step-up, which the unlock holds by default; an undetermined grant
document refuses. It is not `/attach`: that route is `privilegedOnly` because it hands back a host tmux
address, while the Console's answer is a byte count. The pane it writes to is the one the attach proof
names — the session's single registration, matched on pane id, pid and process start — never a session
name. The security log records each write as `terminal.input` on the session (`detail.mode: 'console'`),
folded per window, and never what was typed.

**So is answering a permission prompt.** `POST /v1/sessions/:sessionId/permission` answers the harness's
tool-permission prompt with one key into the same proved pane, so it is declared `terminal` / `use` and
governed exactly as the Console is — a relayed answer is a remote one. It is audited as `terminal.input`
with `detail.mode: 'permission'`, never with the choice. How the prompt is read and why the answer is a
single key is [docs/permission-prompts.md](permission-prompts.md).

**So is answering a harness dialog.** `POST /v1/sessions/:sessionId/dialog` answers the harness's own
dialog — Codex's hook review, Claude's MCP-server approval — with arrows, then Enter or Esc, into the same
proved pane, so it is declared `terminal` / `use` and governed exactly as the Console is. It is audited as
`terminal.input` with `detail.mode: 'dialog'`, never with the choice. See
[docs/harness-dialogs.md](harness-dialogs.md).

**So is acting on the person's own draft.** `POST /v1/sessions/:sessionId/composer` presses Enter on, or
erases, text a person left typed in the agent's composer — the "Send it" / "Clear it" a refused send
offers. It is not a send (no ledger row, and the text is not Ferretry's), so it is declared `terminal` /
`use` and governed exactly as the Console is, unlike the send-ledger routes, which stay `operator` with no
capability. It acts only while the composer holds exactly the quoted draft, and is audited as
`terminal.input` with `detail.mode: 'composer'`, never with the text. See
[docs/message-delivery.md](message-delivery.md).

**So is a ferret's Processes tab.** `GET /v1/sessions/:sessionId/processes`, a process's
`/output` and its `/stop` are all declared `terminal` / `use`. The list is every command line under that
ferret's pane — what `ps` shows somebody with a shell there — an output read is what those commands print,
exactly what a terminal shows, and Stop is SIGTERM to a command the agent started, which is less than typing
Ctrl-C into the Console. None of the three can do anything a session terminal cannot, so none needs more; and
a device trusted only to read the Chat should not read every command's output, so none needs less. Stop
re-proves the process belongs to that pane with the same start time before signalling, and is audited as
`terminal.input` with `detail.mode: 'process-stop'`. See [docs/processes.md](processes.md).

Each has two axes, and they are different questions:

- **use** — may the caller exercise the capability at all?
- **configure** — may the caller change how it behaves on this host?

The list is closed. Everything the daemon does _inside its own state home_ — sessions, tasks,
the agenda, pins — is deliberately absent: a grant list that grew to cover every route would be a
second copy of the route table, and a second copy is how the two stop agreeing.

One consequence: agenda actions are gated by **who acts** (the human or a ferret), never by a capability.
`POST /v1/agenda/clear-agents` is owner-only on that axis — an agent credential gets 403 — and has no grant.
The one governed act inside the agenda is an answer that **confirms a held configuration change**
([agenda.md](agenda.md#confirming-a-configuration-change)): it asks that file's grant, exactly as
`POST /v1/config/confirm` does. The answer route therefore declares `consultsGrants` — no demand of its own,
but the boundary hands the handler the caller's grant standing, so the question can be asked. A route that
asks a grant question without one can only refuse every caller.

## Permissive by default; LOCALITY is the layer

Both axes default to **enabled** for every capability. The dangerous act is structurally
unavailable to a remote caller, so starting open costs much less than it would otherwise, and starting
closed would make a fresh remote session useless until somebody walked to the machine.

**The primary security layer is locality.** A remote caller can never turn a capability on. The passkey
**unlock** is the **second layer**: a governed caller does nothing until its device unlocks the machine,
and the unlock then stands in for the step-up over every `configure` and the `use` of `terminal`,
`browser`, `pairing`, `secrets` and `sharing` — except minting a code, widening a device, sealing secrets for
another machine ([secrets.md](secrets.md#copying-secrets-to-another-machine)), or turning "what agents
may control" back ON (terminals/browsers/files) from a remote device, which always want a passkey for
that act ([design/zero-trust.md](design/zero-trust.md) B1). Turning one of those three OFF never asks
for more than the ordinary `fleet.configure` step-up — only the ON half of a write does, so a single
save that turns some off and others on asks once, for the ON half. It needs no setup beyond pairing,
because the passkey is the one the person already holds.

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
- **The scope move does not widen the layer beneath this one.** A paired device minting a code is governed
  wherever it runs, a browser on the host included: it needs `pairing.use` and a step-up. Only `fy pair`
  with the host's admin token mints without either; see [pairing](pairing.md).
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

### Capability seven was added: `secrets`

The questions above, answered for it ([design/zero-trust.md](design/zero-trust.md) B5):

1. **What does somebody reach for this switch to STOP?** A paired device running commands with the
   machine's stored secrets in their environment (`POST /v1/secrets/use` is code execution on the host),
   or rewriting and deleting those secrets. Before `secrets` existed these routes named no demand, so any
   paired device could do both; that is closed, and `secrets.use` also needs a step-up from a governed caller.
2. **Does switching it off also stop the thing that undoes it?** No. Turning `secrets` off for remote
   callers stops nothing a remedy needs: the secrets are untouched, a leaked device is revoked through
   `pairing`, and the host's own `fy secret` commands are ungoverned. Turning it back on is a host act,
   like every other capability.
3. **So the way back on the control** is the same sentence every capability's remote turn-off already
   carries: the host command `fy daemon config set secrets --use`. There is no ordering to follow, so
   nothing like `pairing`'s "revoke FIRST" note is needed.

### Capability eight was added: `sharing`

The questions above, answered for it ([design/catalogs.md](design/catalogs.md) §3.6):

1. **What does somebody reach for this switch to STOP?** A paired device making a catalog, freezing
   skills and MCP setups into it, and exporting a file this machine has signed. The export is the
   daemon identity vouching for what is in it, and it is handed to people outside the device list, so
   it is the one act here that cannot be recalled. `sharing.use` therefore needs a step-up from a
   governed caller. A ferret that holds the admin token is refused every write regardless of the grant
   (it may list); that is not a grant, it is the route.
2. **Does switching it off also stop the thing that undoes it?** Not yet. With catalogs as files there is
   nothing a remote device has to undo: what was exported stays exported, a leaked device is revoked
   through `pairing`, and the host's own `fy catalog` commands are ungoverned. Members (phase 2b-1) are
   `sharing.use` too: minting a share needs a fresh `share-catalog` passkey from a governed caller, and a
   ferret may list shares and members but never mint, end or revoke. The remote turn-off warning will need
   the "revoke FIRST" ordering [design/catalogs.md](design/catalogs.md) §3.6 describes now that members
   can hold live sessions (built in 2b-2; revoking a member closes them).
3. **So the way back on the control** is the same sentence every capability's remote turn-off carries:
   the host command `fy daemon config set sharing --use`. `sharing` has no "it also stops" note in the
   switch: in phase 1 turning it off stops nothing beyond the catalog routes.
4. **`terminal` is a superset of `sharing`.** A device that holds `terminal` can run `fy catalog export`
   at the host, which is ungoverned, so switching `sharing` off does not keep catalogs from a device that
   still holds `terminal`. The switch governs the daemon's own catalog routes, not what a shell can do.

`sharing.configure` governs only whether a remote caller may re-grant `sharing`. Both axes are on by
default; the operator password is the opt-in layer. That is the daemon-wide document and a device paired
from this release on. A device paired **before** Sharing existed reads it as off (the narrowing rule below), and a
device can only widen what it holds, so only the machine could turn Sharing on. **One widening is made on purpose,
once, at boot** (owner decision 2026-10-31: sharing must start without a command at the machine;
`sharing-follows-pairing.ts`). A device gets Sharing on both axes only when ALL of these hold:

- its stored record has **every other capability fully on** and Sharing fully off — a device that held everything
  before Sharing existed, what it would hold if it were paired today (the owner's phone);
- the daemon-wide document is readable and has **Pairing fully on** (the operator's gate on handing out access);
- **no grant-journal record ever names its Sharing** — a Sharing set by hand is never undone;
- **no grant-journal record names the device at all since Sharing shipped** (v4.177.0): whoever changed it since
  saw Sharing and decided.

Each repair is recorded in the grant journal as `daemon:sharing-follows-pairing`, after its write, so it happens
once and `fy daemon config history` says why; a write whose record failed is said at boot. The whole journal is
read; a journal over 8 MiB, or a line or a file that will not read, repairs nothing and says so. A device that
held less than everything is never widened by this. It can be turned on in the app (Settings › Devices) by a
device that has Sharing and may manage devices, or at the machine with `fy device grant <device> sharing --use`.

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

## The unlock, and the passkey step-up inside it

**The unlock comes first** (owner decision 2026-10-14, [design/zero-trust.md](design/zero-trust.md) B1): a
governed device is answered `401 unlock_required` on everything but the routes it needs to get in, until it
unlocks this machine with a passkey; one unlock lasts `unlockValidityHours` (8 by default, 1 hour to 7 days)
for that device — **across a daemon restart too** (owner decision 2026-10-21: "we don't need to authenticate
every time the daemon updates"). `state/unlocks.json` keeps each device's id and the instant it unlocked —
no key, token or signature, owner-only, bound to the daemon identity that wrote it — and is read back at boot
for devices that are still paired. Whether that instant is still inside the period is asked of the settings
in force, so a shorter period set meanwhile applies at once; revoking a device removes its line; a damaged
file asks every device again, with one boot notice. A per-act step-up and a fresh "for this act" proof stay
in memory and end with the process: they are minutes long, and an update is the moment to ask again for one.
Writing that file needs this machine's disk, which already holds the admin token — it widens nothing.
**While a device is unlocked, its step-up is held** for every act below — the unlock IS the step-up — unless
the owner turned on `stepUpOnActions`, which asks for a passkey again per act inside an unlock. A machine
with the unlock turned off always asks per act. **Adding access always asks:** minting a pairing code,
widening another device, and turning "what agents may control" (terminals/browsers/files, T) back ON
want a passkey proved for that one act, from any device, unlocked or not
([design/zero-trust.md](design/zero-trust.md) B6) — turning one of those three OFF never does. So does
**installing from a catalog** (act `catalog-install`, [catalogs.md](catalogs.md)). **An unlock is never a
fresh proof for any act**: it opens the machine and holds the step-up for ordinary acts, but minting a
pairing code, widening a device, agent control, a daemon update and an install each ask for a passkey even
right after an unlock. **A fresh proof is stamped with the act it was proved for** (the app names the act when
it asks for the passkey), and a claim for one act takes only a proof stamped for that act, so a leftover proof
for another act (loosening a configuration file, say) never buys an install. The proof is claimed atomically
at admission, so one passkey buys one install. At the machine, nothing is asked — **except saving a 2FA seed**
(act `add-2fa-key`), **approving a task plan's sign-in lines** (act `approve-task-plan`) **and approving a standing
sign-in rule** (act `approve-sign-in-rule`): those three are asked of EVERY caller, the admin token on loopback
included, and each proof is bound to the one staged thing it commits (`subject`: the staged save `st_…`, the staged
selection `tps_…` or the staged rule `srs_…`, never another's), opens no step-up window, and is never the fresh proof
another act takes ([secrets.md](secrets.md#2fa-keys), [secure-copy.md](secure-copy.md#task-plans)). A standing rule's
proof is also a **stored proof** (`STEP_UP_ACTS_STORED_PROOF`): its challenge is derived from the rule's signed bytes
and the daemon keeps the assertion, claimed only through `ClaimStoredProof`, never as a fresh proof. Its options
answer only the paired device the stage waits on; any other caller, or a stage that is not waiting, gets
`404 stage_not_found` and no challenge ([secrets.md](secrets.md#standing-sign-in-rules)). A task plan's routes are `caller: 'person'`: staging, committing and
confirming a selection demand `terminal.configure` (plus `browser.use` for a page sign-in or a paste into a page, and
`secrets.configure` for a paste into the store), while reading plans, dropping a stage and revoking only narrow and
demand `terminal.use`; revoking never asks for a passkey. Every one that answers a plan or a stage's summary also
needs `secrets.use`, as `GET /v1/accounts` does, because a plan names the owner's accounts.

**Standing sign-in rules** (`/v1/sign-in-rules`, [secrets.md](secrets.md#standing-sign-in-rules)) are `caller:
'person'` on every route, so a ferret's credential is refused `owner_only` before a body is read. Reading the list,
the eligibility and a staged rule, dropping a stage, narrowing and revoking (one rule, or
`POST /v1/accounts/:id/sign-in-rules/revoke` for an account's) demand `secrets.use` — a rule names the owner's
accounts and says whether their own taps qualify a sign-in — and never ask for a passkey. Staging, confirming a
machine stage in the app, a device taking one (`…/bind`) and committing loosen what any ferret may have filled unasked, so they demand
`secrets.configure` and `browser.use` too, decided before the commit claims its proof, so a refusal never spends
it. The commit takes only the kept `approve-sign-in-rule` assertion over that stage's bytes, from a paired device:
the admin token on loopback is answered the step-up demand, like every other caller without one.

**The app asks only for the machine on screen.** With several machines paired, every page reads all of
them in the background, so a locked second machine used to raise its unlock over the first machine's
page. A background read (`GET`, `HEAD`) that meets `unlock_required` or a step-up now waits until its
machine is on screen, and the Machines list shows that machine as locked; anything a person pressed asks at
once. Two machines that answer to the same name are told apart by address in the prompt and the list.

There is no operator password. The passkey step-up replaced it for every purpose it had — the local
browser's unlock, the remote `configure` lock and the per-change confirmation — and **nothing is kept for
compatibility**. [design/zero-trust.md](design/zero-trust.md) B owns the ceremony (who verifies it, the
step-up window, which origin a passkey belongs to); this section owns what the grant layer does with it.
When a per-act step-up is asked for, its window is the `stepUpWindowMinutes` security setting (0–60, default
15); at `0` a step-up admits exactly one act and the boundary spends it. An unlock is never spent.

**What needs one** — which an unlock satisfies by default. A **governed** caller needs a current step-up for:

- **every `configure` demand**, on every capability; and
- **`use` of `terminal`, `browser`, `pairing`, `secrets` and `sharing`** — session terminals are arbitrary code on the
  host, the browser capability drives a browser the operator is signed into, pairing hands out credentials,
  using a secret runs a command with it in that command's environment, and an export makes this machine
  sign material for people who are not its devices.

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
- Within the window, a step-up covers any number of `configure` acts — and by default the window is the whole
  unlock. The opt-in per-act confirmation (`stepUpOnActions`) is a window, not a confirmation bound to one
  diff; none bound to one diff is planned: the artifact worth binding to (a staged diff, one sign-in identity)
  exists only for the fleet, and a prompt on every act of a capability without one trains people to click
  through.
- The remote risk in a sign-in is still **account substitution**, not disclosure: a caller who can start one
  and forward its code can bind this fleet to a provider account THEY control. That is a change to how the
  host behaves, so it sits on `fleet.configure` and the step-up is what stands in front of it.

## Who may change the security settings

The per-machine security settings ([design/zero-trust.md](design/zero-trust.md) B6 — the unlock and its period,
the per-act step-up and its window, key rotation, idle expiry) follow the same asymmetry as the grants. Changing one is a
`configure` act on `pairing`: `PATCH /v1/security` demands `pairing.configure`, so a remote caller needs
that grant **and** a current step-up, and may only **narrow**. Widening any field is host-only
(`arrivedOnHost`): a remote widen is `403 security_widen_at_machine`, whose sentence names
`fy daemon security set <setting> <value>`. A request that changes several fields is judged field by field
and refused whole if any one widens remotely. Reading them (`GET /v1/security`) needs no capability.

**One exception: raising how long an unlock lasts** (owner decision 2026-10-21). A paired device may raise
`unlockValidityHours` — up to its 7-day bound — with a passkey proved **for that change**
(`STEP_UP_ACTS.loosenSecurity`, act `loosen-security`). The unlock it already holds is not enough: without a
fresh proof the answer is `403 grant_step_up_required` naming that act, the app raises its one prompt, and
the retry is applied **at once** — no hold, because the person proving presence is the owner's consent — and
spends the proof. The journal line carries `security.loosened-with=passkey` beside the old and new value.
The list of fields this applies to is `SECURITY_PASSKEY_WIDEN_FIELDS` in
`packages/protocol/src/lib/security.ts`, and it is only this one: raising it asks the person less often, and
every unlock it stretches was itself a passkey. Turning the unlock or the per-act confirmation off, a longer
key period or a longer idle period stay at the machine. A request that raises the unlock **and** loosens
anything else is refused whole as before, without asking for a passkey first. At the machine nothing changes:
`fy` with the admin token raises it with no prompt.

The cost, stated: a thief holding an unlocked phone **and** its passkey (the person's biometric) could
stretch that phone's unlock to a week. They could already do everything else that passkey buys; the week is
bounded, journaled and undone at the machine or by revoking the device.

## Turning the tunnel on or off

Turning the tunnel on or off is `pairing.configure`. `PUT /v1/tunnel` ([relay-protocol.md](relay-protocol.md)
§15) changes how OTHER devices reach this host — a public hostname on Cloudflare's edge in front of it —
and how this host may be reached is the subject `pairing` already governs, beside `PATCH /v1/security`.
So a governed caller (relay, tunnel, WebRTC, or a device on a loopback peer) needs that grant and a
current step-up, the rule for every `configure` demand; the host's own `fy daemon tunnel on|off`, with
the admin token over loopback, is ungoverned. It is not a host-only widen like the security settings:
a tunnel reaches nobody who was not already paired — every session through it is the §6 handshake
against the pinned identity, and pairing itself is refused on the tunnel listener — which is why the
owner may switch it from the app. Reading it (`GET /v1/tunnel`) needs no capability, like
`GET /v1/carriers`. A change is journaled as `security.changed` with the subject `tunnel`.

## Widening is a local act. There is no remote path to it.

This section is about the DAEMON-WIDE document. One device's own grants have one more path: a remote
device that holds `pairing.configure` and an axis itself may give that axis to another device, with a
step-up — never more than the daemon-wide document allows, so it is a copy, not a widening of the machine
(see [Per-device grants](#per-device-grants)).

"Local" below means **the owner at the machine** — `fy` with the admin token. Every other caller, a browser
on the host included, is governed, and **no step-up buys it a widening**.

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

## Per-device grants

The document above answers **what any remote caller may ever do on this machine**. Each paired device
also carries its **own** grants, in its record in `<FY_HOME>/state/devices.json`, and a governed caller
gets both at once ([design/zero-trust.md](design/zero-trust.md) B5):

```
effective(device, capability, axis) = daemonWide[capability][axis] ∧ device.grants[capability][axis]
```

**Two versions of the app and the daemon agree on the capability list by narrowing.** A client (the app, `fy`)
reading `devices[].grants` or `mayWiden` from a daemon on another version reads a capability the answer omits
(an older daemon) as **off**, and drops a key it has never heard of (a newer daemon, with a later capability),
through one shared parse, `ReadCapabilityGrantsSchema`. The device screen therefore keeps working in both
directions, and never shows access that was not granted. The daemon itself stays closed on what it enforces
from. This is the version-skew rule in `packages/protocol/src/lib/version-skew.ts`.

- **A newly paired device holds every capability** (`FULL_DEVICE_GRANTS`, owner decision 2026-10-14), behind
  the unlock: it can do nothing until it unlocks, and then anything the daemon-wide document allows.
- **A `fy pair --limited` code** gives the device that redeems it `fleet.use` only (`LIMITED_DEVICE_GRANTS`):
  it can read the fleet and chat with sessions, and every other axis starts off until somebody widens it.
  A full code minted from another device is refused unless that device holds every capability itself, so no
  device can pass on more than it holds; at the machine anything goes. The code carries the choice inside
  the daemon, never in the QR or the link.
- **The host is ungoverned** (B4): `fy`, and anything else that arrived on the host, is narrowed by
  neither document.
- **A refusal says which half refused.** The daemon-wide half answers `not-granted` (remedy:
  `fy daemon config set …`); the device half answers `device-not-granted`, wire code
  `grant_device_not_granted` (remedy: `fy device grant <device> <capability> --use|--configure`). The
  daemon-wide answer is asked first, so its remedy — a change for everyone — is named before the per-device one.
- **A device the session proved but whose record is gone** is refused as `undetermined`, never served
  unnarrowed. A governed caller that is not a device (a remote warden) has no device record, so only the
  daemon-wide half and the step-up apply to it.
- **`devices.json` stays at `schemaVersion: 2`.** A record written before per-device grants has no `grants`
  field and reads as the default — `fleet.use` only — which is a narrowing and therefore safe. Every write
  carries the field. A record whose `grants` is malformed fails the document closed, as every other
  malformed field does.
- **A record written before a capability existed reads that capability as OFF, and is written back.**
  Adding a capability makes every stored `grants` one key short of the closed set, and refusing the document
  would stop a daemon with a paired device from starting at all. So `StatePairingRepository.open` fills each
  capability a record lacks with `{ use: false, configure: false }` (a narrowing, never a widening, whichever
  capability it is) and writes the document back once, whole. The `upgrade-grants` unit test keeps a
  committed `devices.json` exactly as v4.172.x wrote it (seven capabilities) and strips each capability this
  build knows from a full record in turn, so a capability added without thought for old records fails there.
  **Devices paired before `sharing` existed therefore start with Sharing OFF**, except the one boot repair for a
  device that held every other capability (see "Capability eight was added"). Any other device: in the app by a
  device that has Sharing and may manage devices, or at the machine with `fy device grant <device> sharing --use`.

### Changing a device's grants

`PATCH /v1/pair/devices/:deviceId/grants` with a partial `DeviceGrantsPatch`, answering the whole device
list. At the machine — `fy` with the admin token, the only ungoverned caller (B4):
`fy device grant <device> <capability> --use|--no-use|--configure|--no-configure`. In the app, Settings →
Add a device shows each device's capabilities as toggles; a browser is a governed device wherever it runs, so
its toggles follow the remote column below — a toggle it may not turn on says so, with the `fy` command.

| change                        | the owner (`fy`) | any device (a browser on the host too)                                                 |
| ----------------------------- | ---------------- | -------------------------------------------------------------------------------------- |
| turn an axis **on** (widen)   | allowed          | only an axis it holds itself, effective, **and** it holds `pairing.configure`; step-up |
| turn an axis **off** (narrow) | allowed          | allowed with a step-up — any device, its own included                                  |

- **No device can grant what it does not hold**, so nothing escalates: the most a device can give another
  is a copy of what it has. A widen of anything else by a device is `403 grant_forbidden`, naming the host command.
- **Narrowing is never harder than widening.** The route demands `pairing.use`, so any device holding that
  — and a step-up — can narrow. A device with no `pairing.use` (the default) cannot reach the route at all;
  its own grants are narrowed at the machine or by a device that may manage devices.
- **`configure` implies `use` on the result**: turning `configure` on turns `use` on with it, turning `use`
  off turns `configure` off, and a field naming both reads as the narrowing.
- **Judged field by field, refused whole.** One illegal widen refuses the whole patch before anything is
  written, and before any step-up is asked — a widen no step-up could buy must not ask for a passkey first.
- **It reaches open streams.** After a change the connection registry re-asks every open stream
  (`recheckAll`, then `ApiSocketDispatcher.reauthorize`), so a narrowed terminal closes rather than running on.
- **It is audited** through the same journal as the daemon-wide grants (`state/grant-audit.jsonl`,
  `fy daemon config history`), one change per axis as `<deviceId>/capability.axis=on|off`, attributed to
  the actor.
- `PairedDevicesView.mayWiden` tells a screen which axes **this** caller may turn on, so a toggle that
  would be refused says so before it is pressed. `CapabilityGrantView.deviceGranted` tells a governed
  device what its own record says, so a panel can say which half withheld an axis.

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
| one device's own grants    | `<FY_HOME>/state/devices.json`, each record's `grants`; `fy device`        |
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

| refusal              | what the sentence says to do                                               |
| -------------------- | -------------------------------------------------------------------------- |
| `granted`            | nothing — the caller was served                                            |
| `not-granted`        | `fy daemon config set <capability> --use` / `--configure`, on the host     |
| `device-not-granted` | `fy device grant <device> <capability> --use` / `--configure`, on the host |
| `step-up-required`   | confirm with the passkey on this device; the app does it and retries once  |
| `undetermined`       | `fy daemon config` on the host, to see and repair the document             |

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

- **An SSH tunnel to the daemon port is a governed caller**, like any browser: it is a loopback peer, and a
  loopback peer proves nothing about the owner. Only the admin token does.
- **The host's command line is ungoverned, so an unattended, unlocked host is unprotected.** Anybody at that
  keyboard can open a terminal, read the admin token and change everything; the step-up does not defend it.
  That is the same door the recovery path depends on — a lost phone, a lost passkey (`fy passkey window
<device>` re-opens a device's passkey window for ten minutes) or a device narrowed to nothing is repaired
  at the machine — and there is no version of this that is both unbypassable and recoverable. Recoverable
  is the one that was chosen. A browser tab left open on the host is no longer the exception: it is governed.
- **A step-up is per device and per app session, and bounds nothing about what the confirmed act does.**
  Within its window a step-up covers any number of `configure` acts and any number of `terminal.use`
  streams. It says "the person holding this device agreed recently", not "this particular diff was read".
  The per-change confirmation that bound an act to one staged change is gone, and the fleet's apply and
  sign-in now rest on the window alone.
- **A remote warden can never step up.** A step-up is a passkey held by a paired device, and a warden has
  no device, so `warden.configure` and every other step-up demand is unreachable to it from off the host.
  It is named here so nobody reads the refusal as a fault.
- **`configure` has no route of its own for `terminal` or `browser`, and one READ for `pairing`.**
  Those subsystems have no host settings the API can change today, so their configure axis governs
  whether a remote caller may re-grant that capability — and, for `pairing`, whether it may read the
  security log (`GET /v1/audit`, see [audit.md](audit.md)). It is not decoration — it is the
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
  Its `live` frames (`?live=1`, a working turn's verb, clock start and token counts) are read off
  the same pane and transcript `GET /v1/sessions/:id/snapshot` and `/logs` already return at the same
  `operator` minimum, so they widen nothing.
- **The transcript image route (`GET /v1/sessions/:id/transcript-images/:handle`) reads the same
  transcript as `/logs`, at the same `operator` minimum, and widens nothing.** It carries no
  capability of its own and is not `noStore`, exactly like `/logs` — an image is bytes of that
  transcript the log already summarises as a marker, so whoever may read the log may fetch the image.
  A handle only names a record the daemon re-parses with the session's own harness parser; it can
  never address arbitrary bytes of the file, and a handle outside that transcript is a 4xx with a
  code. The image is served as `private, max-age=31536000, immutable` with a strong etag, so a
  browser keeps it per device.
- **The log page route (`GET /v1/sessions/:id/log-page`) reads the same transcript as `/logs`, at the
  same `operator` minimum, and widens nothing.** It is the chat's tail and every page of history older
  than it, rendered and scrubbed exactly as `/logs` is, so whoever may read the tail may scroll back
  through the rest. Its `start` is a byte offset into the transcript and its `file` an opaque digest of
  the file's path and identity — positions, never content, and never the path itself.
- **The log search route (`GET /v1/sessions/:id/log-search`) reads the same transcript as `/logs`, at
  the same `operator` minimum, and widens nothing.** It searches every record, not just a tail, so it
  answers no more than scrolling all the way back already shows. A match is decided on the SCRUBBED
  text and its snippet is cut from it, so the search cannot be used to ask whether a secret value
  appears in the transcript, and no snippet carries one.
- ~~Web Push enrolment is governed by `pairing`.~~ **Closed by B5.** A device enrolling **itself** — reading
  the key, enrolling, listing and un-enrolling its own enrolments — needs no capability and no step-up,
  because it grants nothing: it lets this daemon reach the device that asked, and only it. A default
  device (`fleet.use` only) therefore still gets alerts. Seeing every device's enrolments, or revoking one
  another device filed, is device management and is decided by `pairing.use`, asked of the same grant
  layer every governed route is decided by. A caller on the host sees all of them.

  **The honest cost, stated rather than discovered:** switching `pairing` off for remote callers no longer
  stops a paired device enrolling itself for notifications. That is the intended shape — notifications are
  not a credential — and revoking the device still takes its enrolments with it. Enrolling still needs a
  passkey step-up from a governed device, and the endpoint must be a browser push service: the host sends
  requests to it ([design/zero-trust.md](design/zero-trust.md) B5).

- **The secret routes needed no capability before B5**, so a device paired before it could run a command
  with a stored secret without the operator ever being asked. They now demand `secrets` (see the capability
  seven section); a device paired before B5 reads as the default, `fleet.use` only, so it lost that access
  on upgrade and must be widened deliberately.

## Installing from a catalog file

Catalog installs use the same split as the session MCP add below: `filesystem` governs a write into a
project folder and `fleet` governs a runtime write, each with a preview (`use`) and an apply
(`configure`). The seven routes are listed in [catalogs.md](catalogs.md#installing-from-a-file). An
apply from a governed caller demands a fresh step-up proved for the act `catalog-install`
(`STEP_UP_ACTS.catalogInstall`), claimed at admission and not given back, for every install and every update. Removing needs
only the capability. A ferret may preview and list but is refused an install or a remove, whatever its
grants say.

## Adding an MCP server for one ferret

Actions › Add MCP server… writes in one of two places, and each is governed by the capability that
already owns that place. A route declares exactly one capability, so each scope has its own route
(`packages/daemon/src/lib/runtime/mounts/session-mcp.ts`):

| Route                                       | Capability             | What it does                                                           |
| ------------------------------------------- | ---------------------- | ---------------------------------------------------------------------- |
| `GET /v1/sessions/:id/mcp`                  | `filesystem.use`       | lists the project `.mcp.json`'s servers, or why there is none          |
| `POST /v1/sessions/:id/mcp/project/preview` | `filesystem.use`       | the diff a project add would make, and the file's etag; writes nothing |
| `POST /v1/sessions/:id/mcp/project`         | `filesystem.configure` | writes the previewed change into the repository's `.mcp.json`          |
| `POST /v1/sessions/:id/mcp/login/preview`   | `fleet.use`            | the runtime, profile and ferret count a login add would reach          |
| `POST /v1/sessions/:id/mcp/login`           | `fleet.configure`      | adds an MCP component and appends it to the runtime's profile          |

- **`filesystem.configure` now also gates a project `.mcp.json` write.** It is a write into the
  person's repository, so it lands only at the root of a folder the daemon already knows — a
  registered project or a managed worktree, the longest one holding the ferret's folder. A ferret
  anywhere else has no project scope. The write is a compare-and-swap against the etag the preview
  showed, never follows a symbolic link, and keeps the file's mode. A governed caller confirms it with
  the same passkey step-up every `configure` act needs.
- **`fleet.configure` gates the login add**, which is two reviewed changes (`component.put`, then
  `profile.put`) applied through the same catalogue service and governance as Settings › Machines, so
  it is not a second way to change the fleet.
- Both adds are recorded in the security log as `fleet.configured` (`action: mcp-add`, with `scope`),
  naming the session and the server, never its command, address or environment. The previews are not.
- No secret value crosses either route: a project file may reference `${NAME}`, a login may reference
  `${secret:NAME}`, and a value that looks like a raw key is refused by both ends.
