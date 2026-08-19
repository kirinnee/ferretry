---
id: fleet-authority-unification
title: Should the fleet's proposal flow become the capability system?
---

# Should the fleet's proposal flow become the capability system?

**Status: DECIDED by the owner, and now BUILT. §9 is what shipped and where this document was wrong.**
**§0–§8 were verified against `origin/main` at `27509573` (`Brew cask update for ferretry version v0.176.0`)
and are left as they were written**, because a decision record that quietly rewrites itself to match the
code teaches the next reader that nothing was ever in doubt. Every line number below is that commit's;
several have moved, and two of its factual claims are corrected in §9.4.

It answers the owner's question:

> cant you make the fleet same as the capability/authority system?

Short answer: **yes for half of it, and the other half must not be touched — but not for the reason you would
expect.** The obstacle is not that the fleet is special. It is that the capability system, as it stands
today, would say **yes** to the request the fleet exists to refuse. §0 records what the owner decided to do
about that.

---

## 0. The decision, and what it overrides

**Decided by the owner, 2026-08-17.** Verbatim:

> fleert configure on should be default!

This is the answer to §8's question, and it **overrules one half of §8's recommendation**. Recorded here at
the top rather than at the end, because every later section was written before it and reads differently now.

| §8 recommended                                                            | the owner decided                                           |
| ------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `fleet.configure` **default-OFF** for governed callers                    | **REJECTED** — it stays **default-ON**, like the other five |
| per-change confirmation, bound to one exact diff, where a password exists | **ACCEPTED** — kept intact                                  |
| the transaction half survives untouched                                   | **ACCEPTED**                                                |
| the authorization half dissolves into the capability model                | **ACCEPTED**                                                |

**The rejection is the more doctrinal answer, not a lapse from it, and §3.2 was wrong to imply otherwise.**
`docs/grants.md:8-19` and `:59` already state that defaults are permissive and the operator password is the
opt-in layer. Default-OFF for one capability would have made `fleet` the single exception to a rule the
other five keep — the patchwork the owner has repeatedly ruled against, arriving in the disguise of caution.

**On a passwordless machine there is therefore no fleet prompt at all.** Not a confirmation with nothing
behind it: a control that cannot refuse is theatre, and this codebase is explicit that a refusal must name a
remedy a person can actually perform (`grants/policy.ts:147-179`). Where a password exists, the per-change
confirmation is real and is the operator password bound to that diff.

**The consequence was put to the owner before they confirmed it, and they accepted it:** with the
authorization half gone and no operator password set, a paired device can provision the host — writing
executable wrappers into the user's home — with no per-change step. §5.1 states exactly what that exposes
and what genuinely bounds it, and §6 records the one property that is lost outright rather than moved.

---

## 1. The case against unification, first

**On a default install, the capability layer alone permits a remote paired phone to reconfigure the fleet.
The proposal flow is the entire thing standing in the way.**

That is measured, not inferred. `decideCapability` was called directly with the shipped defaults, a governed
(non-loopback) caller, and no operator password:

```
DEFAULT fleet.configure                = {"use":true,"configure":true}
remote, no password              ->  {"allowed":true,"refusal":"ungated"}
remote, password set, no unlock   ->  {"allowed":false,"refusal":"locked"}
```

The chain that produces the first line, in order:

| step                          | where                                                   | answer for a remote paired device       |
| ----------------------------- | ------------------------------------------------------- | --------------------------------------- |
| credential minimum `operator` | `api/dispatcher.ts:313-314` — `tokenClass !== 'warden'` | **passes** (a device is not a warden)   |
| `privilegedOnly`              | not declared on any fleet route                         | **not asked**                           |
| `capability: fleet.configure` | `grants/policy.ts:42-49` default, `policy.ts:126`       | **allowed**, reported as `ungated`      |
| the inline check              | `runtime/mounts/fleet.ts:1087-1089`                     | **403** — the only refusal in the chain |

So `POST /v1/fleet/apply` from a stolen phone is refused by a bare `if` in a handler, and by nothing else.
The same is true of the proposal apply path: the route is reachable (`fleet.ts:1185`, `minimum: 'operator'`),
and what stops the device is `proposals.consume` demanding a host-minted code (`fleet.ts:638-641`,
`fleet/proposals.ts:213-253`).

This matters because the naive reading of "make the fleet the same as the capability system" is _delete the
proposal flow and declare `capability: { capability: 'fleet', axis: 'configure' }`_. Those declarations are
**already there** — on every fleet route (`fleet.ts:1084`, `:1169`, `:1186`). Deleting the proposal flow
would not move authority into the capability system; it would remove the only authority that is actually
being enforced, and a paired browser would provision the host on the strength of having paired. That is
arbitrary code execution: an apply writes executable wrappers into the user's home
(`fleet.ts:694` → `packages/fleet/src/adapters/file-provisioner.ts`) and prunes files carrying Ferretry's
marker — `prune` is the plan's one destructive operation (`fleet/src/lib/provisioning.ts:33`, `:85`).

The capability model states this limitation about itself, in the file that implements it:

> WHAT THIS DOES NOT REDUCE, and the honest thing to say about these defaults: locality bounds what a remote
> caller may GRANT, and says nothing about what an already-granted capability may DO. `terminal.use` is
> arbitrary code on the host, and `fleet.use` composes changes that write executables. A paired device is
> trusted with those by default, so pairing — not this layer — is where that decision is actually made.
> — `grants/policy.ts:35-40`

The fleet proposal flow is that sentence's exception. It is the one capability in the product that declined
to be default-permissive, and it built its own machinery to say so because the capability layer had no way
to express it.

**The unification therefore forces a choice about that exception, and it cannot be made silently.** This
document originally framed it as a single option — make `fleet` the capability whose remote `configure` is
default-DENY — and §3.2 went as far as claiming there was no other answer. **That framing was too narrow and
§3.2 is corrected there:** it assumed the exposure had to be prevented, and never enumerated the option of
accepting it. The owner accepted it (§0). Everything below still describes the exposure exactly as measured;
what changed is that it is now a known and agreed cost rather than a blocker, and §5.1 is where that cost is
stated in full.

---

## 2. The actual defect: two things wearing one name

The proposal flow is not one system. It is two, and only one of them duplicates the capability model.

**An authorization** — who may turn a reviewed change into host state. Codes, TTLs, attempt budgets,
`fy fleet authorize`. This is the same question `docs/grants.md` answers, asked again in a second
vocabulary. It is the part that should be unified.

**A transaction** — stage a change, preview every write, record what the inputs were, refuse if they moved,
apply the exact reviewed artifact or roll back. This is optimistic concurrency control and atomicity. It is
**not an authority question at all**, no capability toggle can express it, and it must survive untouched.

Everything the original complaint is about lives in the first column. Everything load-bearing lives in the
second:

| property                                               | where                                                                  | authority or transaction | can the capability model hold it?                      |
| ------------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------ |
| a device may not apply                                 | `fleet.ts:1087-1089`, `:638-641`                                       | authority                | yes — §3                                               |
| a device may not write the fleet environment           | `fleet.ts:1049-1050`                                                   | authority                | yes — §3                                               |
| approval is bound to ONE exact change                  | `proposals.ts:199-205`, `:224-248`                                     | authority                | **partly** — §3.2                                      |
| approval expires in 120s, 5 wrong tries                | `protocol/fleet-authorization.ts:26-27`                                | authority                | yes, and it is already there twice — §3.1              |
| a HUMAN agreed, not a script                           | `cli/src/lib/fleet/controller.ts:259-263`                              | authority                | **no** — §6, an accepted loss                          |
| the reviewed artifact is what lands                    | `proposals.ts:58-64`, `fleet.ts:550-552`                               | **transaction**          | no, and it must not try                                |
| revision conflict refuses a moved config               | `fleet.ts:665-679`, `proposals.ts:53`                                  | **transaction**          | no                                                     |
| `MISSING_CONFIG_REVISION` distinguishes absent fleet   | `proposals.ts:44`, `fleet.ts:506-512`                                  | **transaction**          | no                                                     |
| per-asset revision refuses a moved asset               | `fleet.ts:579-601`, `:672-678`                                         | **transaction**          | no                                                     |
| compare-and-swap at the write itself                   | `fleet/src/lib/provisioning.ts:123-137`, `file-provisioner.ts:418-429` | **transaction**          | no — and it is **not in the proposal flow** (§2.1)     |
| rollback boundary                                      | `fleet/src/adapters/mutation-journal.ts:342`                           | **transaction**          | no — and also not in the proposal flow (§2.1)          |
| `MAX_OPEN_PROPOSALS = 8`, 15-minute TTL, 16 tombstones | `proposals.ts:23`, `:25`, `:29`                                        | resource bound           | no — a bound on server memory, unrelated to permission |
| asset edits cannot ride an `initialize`                | `fleet.ts:513-521`                                                     | **transaction**          | no — two commit boundaries cannot be one outcome       |

### 2.1 Two of them are not the proposal flow's at all

Worth stating separately because it changes the size of the risk. The two properties a reviewer would most
fear losing — the compare-and-swap and the rollback — are **owned by `@ferretry/fleet`, not by the proposal
store**:

- the write itself refuses a document whose digest moved (`provisioning.ts:137`, checked at
  `file-provisioner.ts:418` and `:429`, after the entry is captured so there is no window);
- rollback is `mutation-journal.ts:342`, reached from `provisioner.apply` (`fleet.ts:691-701`).

`fleet.ts:665-679`'s `assertCurrent` is a **second, earlier copy** of the first check, and the code says so:
_"The expectation travels with the write as well as being checked up front, because only the write can check
it without a gap"_ (`fleet.ts:491-493`). So deleting the proposal store would cost the friendly early
refusal and lose neither the guarantee nor the rollback. That is a materially smaller blast radius than the
table's transaction column first suggests.

### 2.2 This is the fifth mechanism the plan of record's table is missing

`docs/design/one-fact-one-owner.md` already treats "may this caller do this thing" as a duplicated fact
(row 7, line 115, status **live**) and §5.1 (line 577) enumerates the mechanisms as four, calling the fourth
— a bare `if` in a handler — _"the smell in its purest form"_ because it is _"invisible to the route table,
invisible to `GrantsView`, so the UI cannot explain it before somebody clicks"_ (`:584`, quoted from `:586-590`).

That specific inline check has since been paid off: `session-attach.ts:45` became `privilegedOnly: true`
(`session-attach.ts:69`, `grants.ts:195`), and §5.3's route declaration landed (`api/route.ts:46`, `:99-100`,
enforced at `dispatcher.ts:137-138`).

**The fleet's four checks are now the only place a handler re-decides the axis the route table already
declares.** `tokenClass` — the value `minimum` is enforced from at `dispatcher.ts:308-318` — appears inside a
handler in exactly one mount: `fleet.ts` (`:437`, `:638`, `:1049`, `:1087`). Grepping `tokenClass` across
every other file in `runtime/mounts/` returns nothing. The three other handlers that read `request.loopback`
(`pairing.ts:104`, `:130`, `grants.ts:92`) pass it to a projection or a rate-limit key and decide no
authority with it.

**Stated precisely, because the broader claim would be false:** the fleet is not the only mount with an
inline 403. Six others have one, and they were each checked — `push.ts:127-129` (an actor must be a paired
device), `attention.ts:82-85` (actor provenance) and `terminals.ts:168-169` (a named policy function over the
credential) are genuinely inline caller decisions on a _different_ predicate than the route table's;
`task-boards.ts:300-309` verifies a separate board-admin capability token; and `pairing.ts:75` and
`session-filesystem.ts:176` are a failed credential redemption and a content policy respectively, not caller
authority at all. None of those are in scope here, and none of them duplicate the capability model the way
the fleet's parallel approval system does — but a reader should not come away believing the fleet is the only
handler in the daemon that decides something.

So row 7 is still live, and the fleet is the largest remaining reason. This document is that part of the
row's work, and it inherits that document's anti-rule (line 557):

> **Anti-rule: the fix for a duplicated fact is sometimes to SPLIT it correctly rather than to collapse it.**
> A refactor measured by "how many things did we merge" will over-merge and produce a worse system than the
> patchwork.

The split proposed here is authority/transaction. Collapsing both into a capability toggle is the
over-merge, and it is the thing that would hand a phone the host.

---

## 3. What the capability model already has, and the two things it lacks

### 3.1 Three of the five authority properties are duplicates outright

| the fleet's version                                                 | the capability system's version                                      |
| ------------------------------------------------------------------- | -------------------------------------------------------------------- |
| a code that expires in **120s** (`fleet-authorization.ts:26`)       | an unlock that expires in **300s** (`protocol/grants.ts:137`)        |
| **5** wrong codes, then the proposal takes none (`:27`)             | **5** wrong passwords, then a **900s** lockout (`grants.ts:138-139`) |
| the attempt budget is per-PROPOSAL (`proposals.ts:231`)             | the attempt budget is per-DAEMON, deliberately (`policy.ts:240-247`) |
| the code is minted at the host and typed into the browser           | the password is known by the operator and typed into the browser     |
| refusals: `fleet_proposal_unauthorized`, `_expired`, `_consumed`, … | refusals: `not-granted`, `locked`, `rate-limited`, `undetermined`, … |

Two rate limiters, two TTLs, two secret grammars, two refusal vocabularies, one question. The fleet's
per-proposal budget is arguably the better-scoped of the two, and `policy.ts:240-247` explains at length why
the grants ledger is per-daemon instead — but a person configuring one panel should not have to hold both
models in their head, and today the fleet panel and the grants panel refuse in words that share nothing.

### 3.2 The two irreducible differences: one exact diff, and a human rather than a script

The owner's guess is right, and it is the first of the two survivors. A capability toggle authorises **a class of action
for a window**: `fleet.configure` on, unlock held, 300 seconds, any number of applies. An approval
authorises **one exact artifact**: minted against a specific `fy_fprop_…` id
(`proposals.ts:199-205`), consumed in the same synchronous step as the authority check so two concurrent
applies cannot both pass (`proposals.ts:208-212`, `fleet.ts:622-625`), and describing the change in a
server-derived sentence the person reads before agreeing (`proposals.ts:65-66`, `fleet.ts:553`).

There is a second, quieter one worth naming: **the approval is deliberately unspendable by a script.**
`fy fleet authorize` refuses `--json`, and the reason is stated where it is enforced:

> an approval code is a bearer secret for the couple of minutes it lives, and a machine-readable mint is one
> a script can spend without the human this approval exists to ask — `cli/src/lib/fleet/controller.ts:261-263`

A capability grant has no equivalent. It is a document, and anything holding the credential can act on it
for as long as it is on.

**Can per-change binding live inside the capability model?** Yes, as a property of the demand rather than a
parallel credential — a route may declare that a governed caller needs confirmation of _this_ change, and
the confirmation is the operator password entered against the rendered diff. What the diff _is_ stays in the
transaction (the staged change already holds it: `proposals.ts:58-64`). What the capability layer adds is
"and a governed caller must re-prove the password against this specific staged change before it applies",
which is one more branch in `decideCapability`'s shape, not a second credential system.

**Where it does not fit, honestly:** that construction requires an operator password to exist. On a machine
with none — the default, and the case `policy.ts:126` answers with `ungated` — there is no secret to bind a
diff to, and no act performed in the browser can prove somebody is at the host. The 8-character code proves
locality by being _transcribed from the host's own terminal_. Nothing in the capability model does that,
and nothing can: the model's own locality signal is carrier-derived and a remote caller never has it
(`policy.ts:77-81`, `relay/tunnel.ts:331-332`).

So on a passwordless machine there are **four** options:

1. **`fleet.configure` is OFF for governed callers by default.** A person at the machine turns it on — which
   is already the model's one-way door (`service.ts:223-231`). Remote apply then needs no per-change step,
   and the cost is that once on, it stays on until revoked.
2. **Keep a host-transcribed code.** The `fy_fprop_` vocabulary survives and the owner's complaint stands.
3. **Require an operator password before remote fleet configure is possible at all** — the password stops
   being optional for this one capability.
4. **Accept the exposure.** `fleet.configure` stays permissive like the other five, a passwordless machine
   gates nothing, and an operator who wants the per-change gate gets it by setting a password.

(1) and (3) compose: default OFF, and turning it on is where the machine's owner is told what they are
enabling. (2) is the status quo. **(4) is what the owner chose — see §0.**

> **Correction, left visible rather than edited away.** This section originally read "exactly three options,
> and no fourth", and option 4 was the one it did not list. The omission was not an oversight of a mechanism
> but of a stance: the enumeration silently assumed the exposure had to be _prevented_, so "accept it, and
> keep the capability model's own defaults" was never on the page. That assumption was mine and not the
> product's — `docs/grants.md:59-73` had already made the opposite choice for all six capabilities, and
> `grants/policy.ts:15-40` says out loud that a paired device is trusted with `fleet.use` by default and that
> pairing, not this layer, is where the decision is made. An enumeration that ends in "and no fourth" is a
> claim about the whole space, and this one was wrong.

---

## 4. What a person sees afterwards

Target state under the decision in §0 — option 4 plus the per-change confirmation wherever a password exists.
There are exactly three things a person can meet, and the fleet no longer has a vocabulary of its own in any
of them:

**On the machine (loopback), which is the common case and the owner's complaint.** The Fleet panel shows the
numbered change manifest exactly as it does now (`fleet-change-review.tsx`), and one **Apply** button. No
`fy_fprop_` id on screen, no "Host authority" section, no command to copy, no code field, no hourglass, no
120-second sentence — `fleet-change-review.tsx:424-501` (the `approval` arm at `:453-500`) and the `approval`
arm of `AUTHORITY_COPY` (`fleet-configuration-surface.tsx:179-181`) are deleted. This is the same answer
`isGovernedCaller` has given for every other capability since it shipped (`policy.ts:83-85`).

**From a phone, on a machine with no operator password — the DEFAULT.** The same panel, the same single
**Apply** button, and nothing else in the way. This is the case the decision changed: under the rejected
recommendation the panel would have been read-only until somebody walked to the machine. There is
deliberately **no prompt**, because there is no secret behind one — the capability layer already reports this
state as `ungated` rather than `granted` precisely so a surface can say once, beside the control, that
nothing is standing behind it (`policy.ts:120-126`). The honest UI here is that one sentence, not a dialog.

**From a phone, on a machine with an operator password set.** The staged change is shown, and applying asks
for the operator password — the same unlock prompt the grants surface already has, bound to this diff. No
second code, no second lockout, no second TTL. This is the per-change confirmation, and it is the whole of
what an operator buys by setting a password.

**And if the operator has narrowed `fleet.configure` themselves,** the panel is read-only with the standard
sentence and remedy (`policy.ts:169-170`), and turning it back on from that phone is refused by the existing
one-way door (`service.ts:264-268`). Narrowing stays available to everyone, always, and never needs the
password — revoking must never be harder than granting.

**What stays on screen either way:** the numbered write manifest, the asset-edit list with byte counts, the
staleness refusal when the host moved under the change, and every apply outcome
(`committed`, `rolled-back`, `initialized`, `initialization-partial`, …). Those are the transaction, and they
are the part of the panel that is actually earning its space.

---

## 5. What must not regress, and how

> A paired browser must still not be able to provision a host on the strength of having paired.

Four properties carry that today. Each survives, and here is the mechanism:

1. **Locality is carrier-derived and a relayed request is never local.** Untouched — `tunnelApiRequest` sets
   `loopback: false` unconditionally (`relay/tunnel.ts:331-332`), the Bun transport sets it from the socket
   (`adapters/api/bun-api-server.ts:402`), and nothing re-derives it. The proposal here reads the same
   boolean through `isGovernedCaller` and adds no new source. A `Host` header, an `x-forwarded-for` or a
   `127.0.0.1` in a URL must remain incapable of moving it, which is what
   `packages/daemon/tests/unit/grants/policy.test.ts:42-74` already pins.
2. **Pairing alone is not provisioning — this one does NOT survive, and §0 accepted that.** It is the whole
   content of the decision, so it is stated here rather than left implicit: on a default install a paired
   device will be able to provision the host. See §5.1.
3. **Widening is a local act.** Untouched (`service.ts:264-268`, `policy.ts:214-221`). A governed caller can
   never turn a capability on, with or without the password, so a stolen phone cannot restore an access its
   owner has revoked. Under the decision this is what makes revocation a real remedy rather than a
   suggestion: an operator who revokes `fleet.configure` from the machine has shut a door the phone cannot
   reopen.
4. **An undetermined document refuses.** Untouched (`policy.ts:116`). A daemon that cannot read its grants
   does nothing with the fleet.

### 5.1 What the decision exposes, exactly

**Stated in full so it is agreed to rather than discovered.** With the authorization half dissolved and no
operator password set — the default state of a fresh install — **any paired device can apply any number of
fleet changes, with no per-change step.** A fleet apply writes executable wrappers into the user's home and
`prune` removes files carrying Ferretry's marker (`fleet/src/lib/provisioning.ts:33`, `:85`), so this is
arbitrary code execution on the host by a credential the daemon issued.

Today that same device can apply **exactly one** change, and only one for which a human transcribed a code
off the host's terminal. **The reduction in per-change control is real, it is larger than the rejected
recommendation's, and the owner accepted it knowingly.**

What genuinely bounds it, with the overclaims removed:

- **Reaching the daemon at all requires pairing**, and a pairing code lives 120 seconds with a 5-attempt
  budget (`protocol/src/lib/pairing.ts:8-9`). So the exposed case is not "any phone on the internet"; it is a
  device that was deliberately paired, which in practice means **a lost or stolen already-paired device**, or
  somebody who obtained a live code.
- **Revocation is never gated and never harder than granting.** The `pairing` capability deliberately governs
  device revocation on its `use` axis rather than `configure`, precisely so that nothing stands between a
  person and a stolen phone at the moment it matters (`runtime/mounts/pairing.ts:77-88`), and one device's
  access is taken away by `DELETE /v1/pair/devices/:deviceId` (`:211-223`).
- **An operator who wants the per-change gate can have it** by setting a password, which is the model's
  stated shape — the opt-in layer, not the default (`docs/grants.md:167`).

**One bound that is NOT available, and must not be written into the threat model:** physical proximity.
It would be natural to argue that pairing requires somebody near the machine, so an attacker had to be on the
local network once. **That is no longer true at this commit.** `docs/relay-protocol.md:1071-1080` records
relayed pairing as **built** and retires the previous "first contact is always direct" prohibition; `:1473-1486`
names the error in the old reasoning — the out-of-band enrolment path was always the QR, which pins the
daemon's fingerprint before any carrier is dialled. The remaining requirement is possession of a
120-second code, and reading one aloud over a call satisfies it.

---

## 6. The accepted loss: "a human, not a script"

**This is not a footnote and must not become one.** One property of the current design cannot be expressed in
any capability form, is not being moved or replaced, and dies with the authorization half. The owner's
decision is recorded against it here so that a later reader cannot mistake this change for pure
simplification.

**The property.** `fy fleet authorize` refuses `--json`, and the reason is stated where it is enforced:

> an approval code is a bearer secret for the couple of minutes it lives, and a machine-readable mint is one
> a script can spend without the human this approval exists to ask — `cli/src/lib/fleet/controller.ts:261-263`

So today a fleet change applied from a browser requires **a person, at a terminal, reading a screen**. Not a
credential — an act of attention that no automation holds. `fy fleet authorize` is the one verb in the CLI
that refuses to be scriptable, and it refuses on purpose.

**Why nothing in the capability model can carry it.** A grant is a document, and an unlock is a bearer token
with a 300-second life (`protocol/src/lib/grants.ts:137`). Anything holding the credential can act on either,
as many times as it likes, for as long as they last. The per-change confirmation that §0 keeps narrows _which
change_ is authorised; it cannot make the authoriser a human rather than a process, because the only evidence
it takes is a secret, and a secret in a config file is exactly what a script has. There is no version of
"prove you are a person" available to this layer, and inventing one would be the second authority system all
over again.

**Status: accepted loss, and now REALISED — the verb is deleted (§9.1).** The property below is no longer
available in this product, and this section is the only remaining record that it ever existed. The owner
decided (§0) that one vocabulary is worth more than this property. That
is a legitimate trade — the property costs the friction the owner complained about in the first place, and it
protects against a threat model (a script with the device credential and no human nearby) that the same
decision has already accepted in a larger form via §5.1. It is recorded because a design that quietly drops
its own strongest guarantee teaches the next reader that it never mattered.

**If it is ever wanted back**, it cannot come back as a capability. It would have to return as what it is: an
out-of-band act at the host, which is option 2 of §3.2 and brings the `fy_fprop_` vocabulary with it.

---

## 7. Migration

**`fy fleet authorize` is shipped, and the route it dials is reached.** It is absent from
`scripts/validate/route-agreement-allowlist.txt`, which means the gate currently sees agreement between the
CLI dial (`cli/src/lib/fleet/gateway.ts:46`, `:71-73`) and the served route (`fleet.ts:1167`). The allowlist
**may only shrink** — _"a stale entry … is a hard failure, so closing a gap costs the line in the same
change"_ (`route-agreement-allowlist.txt:4-6`) — and adding an `unserved` line is growth, not shrinkage.

**Consequence: the route and the CLI verb must be deleted in ONE change.** Deleting the route first makes a
shipped `fy` dial a 404 with no line permitted to record it; deleting the verb first leaves the route
`unreached` with no line permitted to record that either.

The rest of the removal list, so the size is visible up front:

| what                                                                                       | where                                                                                                           |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `POST /v1/fleet/proposals/:id/authorize` and `authorizeProposal`                           | `fleet.ts:1155-1175`, `:603-617`, `:148-150`                                                                    |
| `fy fleet authorize` — command, controller, gateway, port                                  | `commands.ts:140-155`, `controller.ts:259-268`, `gateway.ts:46`, `:71-73`, `ports.ts:131`                       |
| `FLEET_APPROVAL_TTL_SECONDS`, `_MAX_ATTEMPTS`, `FleetApprovalCodeSchema`, the mint schemas | `protocol/src/lib/fleet-authorization.ts:26-30`, `:38-45`, `:104-113`                                           |
| `mayApplyWithApproval` and `approvalCommand` — **a wire break**; the PWA reads both        | `protocol/src/lib/fleet-changes.ts:27-29`, `fleet-change-model.ts:88-98`                                        |
| the approval half of the proposal store: `authorize`, `consume`, the attempt ledger        | `proposals.ts:199-253`, `:68`, `:82`                                                                            |
| the `approval` arm of the review surface and the authority badge                           | `fleet-change-review.tsx:424-501` (the `approval` arm at `:453-500`), `fleet-configuration-surface.tsx:179-181` |
| the inline device refusals, replaced by declarations                                       | `fleet.ts:1049-1050`, `:1087-1089`, `:437`, `:638`                                                              |

**Not affected:** `consumeAsHost` (`proposals.ts:256-262`) becomes the only consume path;
`MAX_OPEN_PROPOSALS`, the 15-minute TTL and the tombstones stay as resource bounds; the whole transaction
column of §2's table stays; the two `unreached` fleet lines in the allowlist
(`PUT /v1/fleet/environment`, `POST /v1/fleet/apply`, lines 89-90) are untouched unless those routes are
also deleted, in which case their lines must go in the same change.

**One correction to the framing that produced this work.** The original brief treated
`PUT /v1/fleet/environment` and `POST /v1/fleet/apply` as part of the friction. They are not reachable from
the browser at all: the PWA's only dial of the environment path is a `GET`
(`fleet-environment-settings.tsx:33-40`), and nothing dials `POST /v1/fleet/apply`
(`route-agreement-allowlist.txt:89-90`). The friction the owner met is entirely on the proposal routes.

**Protocol tests enumerate every exported schema**, so deleting the approval schemas deletes their cases
too; leaving one behind fails the protocol suite rather than passing quietly.

---

## 8. The decision, as asked and as answered

The engineering was never the hard part. The trade was, and it could not be made by a refactor:

**Do we accept that `fleet.configure` for a caller who is not on this host stops being an approval
transcribed for each individual change?**

**Answered: yes — and more fully than this document recommended.** §0 has the ruling and the exact
verbatim wording. The two answers, and which one was taken:

- **Yes** → the fleet joins the capability system completely. One vocabulary, one refusal grammar, one
  unlock, no `fy_fprop_` ids on any screen. Per-change control is lost for remote callers. **TAKEN**, with
  `fleet.configure` staying **default-ON** — so it is bounded by pairing, local-only widening and ungated
  revocation (§5.1), but **not** by a default-off grant. §7 is the work.
- **No** → the per-change approval is load-bearing and stays. Then the honest unification is the smaller one:
  keep the code for governed callers, but delete the four inline checks in favour of declared route axes so
  the refusal is visible to `GrantsView` and the UI can explain it before a click (§2.2), and align the two
  refusal vocabularies. **NOT taken.**

**What this document recommended, for the record, and where it was overruled.** The recommendation was yes
with options (1) and (3) of §3.2 — `fleet.configure` default-OFF for governed callers plus the
password-bound per-change confirmation. The owner kept the confirmation and rejected default-OFF. On
reflection the rejection is the better reading of the product's own doctrine: the recommendation would have
made `fleet` the one capability that starts closed, which is the exception-shaped patchwork the owner has
consistently ruled against, and §3.2's enumeration had quietly excluded the option they chose.

**What the recommendation was right about survives:** the authority/transaction split (§2), the per-change
confirmation where a password exists (§3.2), and the insistence that the loss in §6 be named out loud rather
than absorbed. That last one is why this section ends where it does — the decision is made, the cost is
written down beside it, and the next reader can disagree with the trade without having to rediscover it.

**Next: implementation is NOT authorised by this document.** §7 is the work; whether and when it happens is a
separate call. **It was authorised separately and is now built — see §9.**

---

## 9. As built

**Everything §0 decided shipped, and one thing §7 did not anticipate had to be built rather than deleted.**
This section is written against the change that implemented it, not against `27509573`.

### 9.1 What went

- `POST /v1/fleet/proposals/:proposalId/authorize`, `authorizeProposal`, and the `FleetProposalStore`'s
  entire approval half — `authorize`, the code-checking `consume`, the per-proposal attempt ledger and
  `normalizeApprovalCode`. `consumeAsHost` is now simply `consume`, takes only an id, and decides nothing
  about a caller.
- `packages/protocol/src/lib/fleet-authorization.ts`, deleted outright. `FleetProposalIdSchema` survived it
  and moved into `fleet-changes.ts`, because a staged change still has a handle; a handle was never a
  credential, and having it live in a file named for authorization is what made it read like one.
- `fy fleet authorize` — **removed outright, not deprecated.** The verb's whole purpose was to mint a
  credential that no longer exists, and a stub would have been a second place describing the capability
  model. The route and the verb went in ONE change, as §7 requires: the route-agreement allowlist may only
  shrink, so neither half has a line it is permitted to record on its own.
- The four inline `tokenClass === 'device'` refusals in `runtime/mounts/fleet.ts`. Each route's declared
  `fleet` axis is now the whole answer, which is what makes the refusal visible to the route table and to
  `GrantsView` — §2.2's point, and the last handler in the daemon that re-decided its own route's axis.
- The Fleet panel's "Host authority" block: the `fy fleet authorize fy_fprop_…` command to copy, the
  approval-code field, the 120-second sentence, the "Check for approval" button and the **Approval
  required** badge.
- `minimum: 'admin-token'` is now declared by **no route at all**. The authorize route was the only one.
  The class stays in `CredentialMinimum` because the ladder is the daemon's contract rather than a census
  of today's table, but the count is pinned in `surface.test.ts` so its return would be deliberate.

### 9.2 What was built

The per-change confirmation §0 kept, and §3.2 sketched, did not exist and had to be written:

- `CallerGovernance` on the route context, minted by the authorization boundary for every route that
  declares a capability, carrying `governed`, `passwordSet`, `confirmChange`, and a `decide` that reports
  the operator's answer for **any** axis — so `GET /v1/fleet/permissions` can say whether `configure` would
  be allowed without demanding it. It is the `wardenRemedy` shape: a handler cannot mint one, and it only
  ever adds a step.
- `requiresChangeConfirmation` in `grants/policy.ts` — governed **and** a password exists — and
  `CapabilityGrantService.confirmChange`, which spends one of the SAME five tries an unlock spends and
  **mints nothing**. That last part is the whole difference from an unlock: an unlock is a bearer value
  good for five minutes and any number of `configure` demands, while this is spent inside the one request
  that carries it, which is what binds it to a single diff.
- `FleetProposalApplyRequestSchema.operatorPassword`, held to `OperatorPasswordSchema` — the same schema
  the unlock is held to, because it is the same secret rather than a new one.
- `FleetPermissions` reshaped from `{ mayApplyDirectly, mayApplyWithApproval, approvalCommand }` to
  `{ mayApply, applyRefusal, confirmation }`. `applyRefusal` is the shared `GrantRefusal`, so the fleet
  panel words a refusal exactly as the grants panel beside it does.

### 9.3 What §7's removal list missed

Found by grep rather than by the survey, and each would have failed a gate:

- `packages/cli/bin/fy.ts` — the composition root that constructed the authorization gateway.
- `packages/cli/tests/integration/fleet/shared-history.test.ts`, which builds a real `FleetController`.
- Three prose sites a symbol grep does not reach: the `fy fleet --help` overview, which advertised
  `authorize` as one of two daemon-crossing verbs; the `FleetController` class comment, which said "two of
  them cross to it" and named it; and `FLEET_PROPOSALS_PATH`, left with no consumer.

### 9.4 Where this document was wrong

**§5.1's exposure is narrower than stated, and the reason post-dates the document.** It says that on a
passwordless machine "any paired device can apply any number of fleet changes, with no per-change step".
That is still exactly what `decideCapability` answers — but a passwordless machine **cannot pair a device
at all**: `PairingService.mint` refuses without an operator password, in its own sentence, and
`packages/cli/src/lib/daemon/first-password.ts` offers to set one at the moment somebody starts the
daemon. So the state §5.1 describes is not reachable by pairing.

**It was still reachable by one route, and that route has since been closed.** When this section was
written an operator could pair a device and then run `fy daemon password clear`, which did not revoke
devices: the machine kept its paired devices, reported `fleet.configure` as `ungated`, and applied with
no per-change step. That was a state its owner had asked for explicitly, with `PASSWORD_CLEAR_WARNING`
in front of them, rather than the default state of a fresh install — which is what §5.1 called it.

**The owner then ruled that the verb should not exist, and it was removed.** Setting an operator
password is now one-way; nothing takes one off a machine. So the state §5.1 describes has no remaining
route into it at all: a machine without a password cannot pair, and a machine that has paired cannot
become one without a password. The cost, accepted knowingly, is that somebody who sets a password and
never pairs a device has no way back to a passwordless machine — recorded in `docs/grants.md` beside
the narrower alternative that was offered and not taken (refusing removal only while paired devices
exist). **This paragraph is left as a record of an exposure that was found, argued and closed rather
than rewritten to look as though it never existed**, which is the same standard §3.2's correction set.

**§4's first bullet reads as though loopback alone settles it.** It says the local case "is the same answer
`isGovernedCaller` has given for every other capability since it shipped". `#358` landed after this document
and changed that: a browser on the machine is a paired device and is governed **until it unlocks**. The
target state §4 describes is therefore what a local browser meets _after_ one unlock, not on arrival — and
that unlock is now offered by the Fleet panel itself, which is the half of the shipped bug §4 could not
have predicted. The panel had no unlock prompt at all, so a local browser met `grant_locked` **and** the
approval block, and had no way through either.

**§3.2 is right that the per-change confirmation "is one more branch in `decideCapability`'s shape, not a
second credential system", but it is not a branch in `decideCapability`.** `decideCapability` answers a
demand; whether a confirmation is owed is a fact about the caller, so it is a sibling function over the
same evaluation. The distinction matters only to somebody reading for the code, which is why it is recorded
here rather than edited into §3.2.

---

## Appendix A: the loopback exemption, measured and then abandoned

The first version of this work was to exempt loopback callers from the proposal dance and change nothing
else. It was superseded by the owner's question, and it is **not proposed here**. The measurement is kept
because it is the evidence for §1 and §4, and because it establishes the current behaviour precisely.

Three tests were written against unmodified `main` (`27509573`) and run before any source change:

```
(fail) a caller who is standing at the machine > should let the host own browser apply its change with no approval at all
(fail) a caller who is standing at the machine > should tell the host own browser exactly what it tells the host own admin token
(fail) a caller who is standing at the machine > should let the host own browser re-apply and change profile environment
 71 pass  3 fail
```

They establish, by observation rather than by reading:

- a loopback browser **is** forced through the full approval flow today;
- the cause is **not** the admin-token minimum and **not** the capability layer — the routes are
  `minimum: 'operator'`, which a device satisfies (`dispatcher.ts:313-314`), and the capability layer answers
  `granted` for a loopback caller before any grant is consulted (`policy.ts:112`). The cause is the inline
  `tokenClass === 'device'` refusals and `proposals.consume` (`fleet.ts:1087`, `:638-641`);
- the fix is three lines of predicate and needs no wire change, which is why it was tempting and why it is
  the wrong layer: it would have left the fleet with its own authority system and added a fifth spelling of
  locality to it.

The abandoned patch and both raw runs are retained outside the repository as session evidence; they are not
part of this proposal and no production file in this branch is modified.

## Appendix B: what this document does not propose

- **No change to pairing.** The pairing surface has its own loopback reasoning
  (`runtime/mounts/pairing.ts:1-35`) and it is not in scope.
- **No change to the authorize route's absent loopback guard** while that route still exists. The rationale
  at `fleet.ts:1156-1165` is sound: the code confers strictly less than the caller already holds, so
  requiring loopback would only break a legitimate remote admin using `FY_URL` and `FY_TOKEN`.
- **No seventh capability.** The list stays closed at six (`grants/policy.ts:42-49`,
  `docs/grants.md:55-57`); the fleet already has its row.
- **No change to the transaction.** Staging, previewing, revision conflict, compare-and-swap, rollback and
  the resource bounds are not authority and are not touched.
