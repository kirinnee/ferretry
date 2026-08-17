---
id: fleet-authority-unification
title: Should the fleet's proposal flow become the capability system?
---

# Should the fleet's proposal flow become the capability system?

**Status: proposal. Nothing here is built, and this document deliberately changes no production code.**
**Verified against `origin/main` at `27509573` (`Brew cask update for ferretry version v0.176.0`).** Every
claim about current behaviour below cites a file and line at that commit.

It answers the owner's question:

> cant you make the fleet same as the capability/authority system?

Short answer: **yes for half of it, and the other half must not be touched — but not for the reason you would
expect.** The obstacle is not that the fleet is special. It is that the capability system, as it stands
today, would say **yes** to the request the fleet exists to refuse.

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

**The unification is therefore possible only if the owner accepts one specific consequence: `fleet` becomes
the capability whose remote `configure` is default-DENY.** Everything else in this document follows from
that single decision. §7 states it as the decision to make.

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
| a HUMAN agreed, not a script                           | `cli/src/lib/fleet/controller.ts:259-263`                              | authority                | **no** — §3.2                                          |
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

## 3. What the capability model already has, and the one thing it lacks

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

So on a passwordless machine there are exactly three options, and no fourth:

1. **`fleet.configure` is OFF for governed callers by default.** A person at the machine turns it on — which
   is already the model's one-way door (`service.ts:223-231`). Remote apply then needs no per-change step,
   and the cost is that once on, it stays on until revoked.
2. **Keep a host-transcribed code.** The `fy_fprop_` vocabulary survives and the owner's complaint stands.
3. **Require an operator password before remote fleet configure is possible at all** — the password stops
   being optional for this one capability.

(1) and (3) compose: default OFF, and turning it on is where the machine's owner is told what they are
enabling. (2) is the status quo.

---

## 4. What a person sees afterwards

Target state, assuming decision (1) from §3.2 plus the per-change confirmation when a password exists:

**On the machine (loopback), which is the common case and the owner's complaint.** The Fleet panel shows the
numbered change manifest exactly as it does now (`fleet-change-review.tsx`), and one **Apply** button. No
`fy_fprop_` id on screen, no "Host authority" section, no command to copy, no code field, no hourglass, no
120-second sentence — `fleet-change-review.tsx:424-501` and the `approval` arm of `AUTHORITY_COPY`
(`fleet-configuration-surface.tsx:179-181`) are deleted. This is the same answer `isGovernedCaller` has
given for every other capability since it shipped (`policy.ts:83-85`).

**From a phone, with `fleet.configure` off.** The Fleet panel is read-only and says what the grants
vocabulary already says everywhere else — the operator has not granted the UI permission to change this, and
the remedy names the command (`policy.ts:169-170`). Turning it on is refused with the existing one-way-door
sentence (`service.ts:264-268`). One vocabulary, and the fleet stops being the panel with its own words.

**From a phone, with `fleet.configure` on and a password set.** The staged change is shown, and applying
asks for the operator password — the same unlock prompt the grants surface already has, against this diff.
No second code, no second lockout, no second TTL.

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
2. **Pairing alone is not provisioning.** Under (1) the grant is off, so a paired device is refused by the
   capability layer — a **declared** refusal the UI can render before a click, rather than the invisible
   inline `if` at `fleet.ts:1087`. This is strictly better observability for the same answer.
3. **Widening is a local act.** Untouched, and it is what makes (1) safe: a governed caller can never turn
   `fleet.configure` on, with or without the password (`service.ts:264-268`, `policy.ts:214-221`). A stolen
   phone cannot restore an access its owner revoked.
4. **An undetermined document refuses.** Untouched (`policy.ts:116`). A daemon that cannot read its grants
   does nothing with the fleet.

**The honest cost, stated so it is agreed to rather than discovered.** Under (1) with no password, a phone
whose operator has turned `fleet.configure` on can apply **any** number of fleet changes until the grant is
revoked. Today it can apply exactly one, and only one a human transcribed a code for. **That is a real
reduction in per-change control, and it is the price of one vocabulary.** Three things bound it: the grant
is off by default; turning it on happens at the machine, where the person can be told exactly what they are
enabling; and revocation is never gated (`policy.ts:206-212`, `service.ts:216-221`). Whether that trade is
acceptable is the owner's call, not this document's — see §7.

**One property is lost outright and cannot be recovered:** "a human, not a script, agreed to this exact
change" (`controller.ts:261-263`). A grant is a document; anything holding the credential acts on it. If
that property is required, decision (2) — keep the code — is the only answer, and the friction stays.

---

## 6. Migration

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

## 7. The decision this document asks for

The engineering is not the hard part. The trade is, and it cannot be made by a refactor:

**Do we accept that `fleet.configure` for a caller who is not on this host becomes a grant that is turned on
once at the machine, instead of an approval transcribed for each individual change?**

- **Yes** → the fleet joins the capability system completely. One vocabulary, one refusal grammar, one
  unlock, no `fy_fprop_` ids on any screen. Per-change control is lost for remote callers, bounded by
  default-off, local-only widening, and ungated revocation. §6 is the work.
- **No** → the per-change approval is load-bearing and stays. Then the honest unification is the smaller one:
  keep the code for governed callers, but delete the four inline checks in favour of declared route axes so
  the refusal is visible to `GrantsView` and the UI can explain it before a click (§2.2), and align the two
  refusal vocabularies. The owner's original complaint about friction is then answered only for loopback
  callers, which is a strict subset of this and needs none of §6.

**Recommendation: Yes, with (1) and (3) from §3.2 together** — `fleet.configure` default-OFF for governed
callers, and the per-change confirmation retained as an operator-password step whenever a password exists.
That gives one mental model, keeps the strongest available remote guarantee for operators who want it, and
puts the decision where the model already puts every other one: at the machine, once, by the person who owns
it. The reason it is not unconditional is §5's last paragraph — "a human, not a script" genuinely dies here,
and somebody should say out loud that they are fine with that before the code is written.

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
