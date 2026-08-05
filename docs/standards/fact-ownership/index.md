---
id: fact-ownership
title: Fact Ownership
---

# Fact Ownership

Ferretry is several programs, and nothing automatically notices when two of them disagree. The daemon
and the PWA are different bundles on different release trains, so an installed daemon and an open
browser tab can be weeks apart. The CLI and the daemon are different packages with no dependency
between them, so an artefact one creates and the other classifies has nothing checking both. Every one of them holds facts the others
also hold — where the state home is, what the six capabilities are called, which address a device may
dial, what a notification kind is — and **holding a fact twice does not make the two copies agree**.

This page owns that problem: **where a fact is allowed to be defined, and how a second definition is
detected.**

It builds on [Software Design Philosophy](../software-design-philosophy/index.md) — a fact with two
owners is failed locality across a process boundary, where understanding one program requires knowing
what a different program decided and then hoping. [Contracts](../contracts/README.md) is the mechanism
half: a list of gates. This is the principle those gates serve — and the test a proposed gate has to
pass before it earns a line, since most of the rules below are closed by a type rather than a script.

---

## The defect, stated once

> **One fact, two definitions, and no mechanism that can notice they disagree.**

Both definitions pass their own tests, because each half owns its own fixture. That is what makes this
class different from an ordinary bug: there is no failing test to find, no exception to read, and the
symptom is almost always a benign-looking empty case — no accounts, no notifications, no relay, no
permission, a QR code that scans and does nothing.

The repository knew this before it had a name for it.
[Contracts](../contracts/README.md#workspace-cli-and-release-contracts) records the state-home
disagreement shipping **three times in the same shape** — `logs/`, the daemon's own `start()`, and
`fy fleet init`, the last of which permanently refused a fleet an owner had just provisioned — and
says of all three:

> Every one of them passed its own tests, because each writer owned its own fixture.

That insight produced three contracts and then stopped, because it was recorded as a list of gates
rather than as a rule. A gate list answers "what do we check"; it never answers "what class of thing
must be checked", so the next fact of the same class arrives with nobody looking for it. This article
is the missing half.

---

## Why this article exists, in one incident a reader can check

The refactor plan this article came out of (`docs/design/one-fact-one-owner.md`) surveyed sixteen
instances of the defect above. The most useful evidence in it is not any of the sixteen. It is what
happened to the plan itself.

**The document contradicted itself, in the summary of its own argument against contradicting
yourself.** A measurement-based claim was retracted in the two sections that argued it and left
standing in the opening verdict — the first thing a reader sees. For three commits the headline
asserted what the body withdrew. Six people worked on that document and three of them were
re-verifying its numbers specifically. Nobody caught it. It was found by accident, while re-reading
the neighbouring section for an unrelated reason.

Two things follow, and both are load-bearing.

**A document is a second definition.** The pairing route table exists in the code and again in a
summary of the code, and the summary was wrong: a teammate was told a route existed with a verb it did
not have, because somebody had seen the path and supplied the method from memory. The contract registry
exists in the `all` loop of `cli-contracts.sh` and again as a table in this tree, and the two drifted —
the registry of the mechanism that prevents enumeration drift had enumeration drift. Prose that
describes a fact is subject to every rule below, exactly as a constant is. This is not a metaphor for
the rule; it is an instance of it.

**No gate catches two paragraphs that disagree.** `conflict-markers.sh` finds a conflict marker in any
formatted disguise, which is a real and cheap win — it exists because `treefmt` once rewrote a raw
marker into a valid Markdown blockquote and eleven checks passed the result. But a marker is a syntactic
artefact. Two readable, well-formed, opposed statements are not, and nothing in this repository can
find them. `docs/grants.md` reached `main` carrying a heading that named the operator password as the
security layer, and a sentence in the same file stating that the primary layer is locality and **not**
the password. Both were well-formed Markdown. Both were wrong together for as long as nobody read them
in one sitting.

The point is not that anybody was careless. It is that **careful people, working specifically on this
failure mode, with the rule in front of them, produced it anyway.** That is the argument for making
agreement mechanical rather than intentional, and it is the one argument here that needs no code
reading to check.

---

## R1 — Definition: one fact, one owner, expressed as a decision

> **Any fact two independently-deployable programs must agree on is defined once, in
> `@ferretry/protocol`, as a _decision_ — a parser or a function that answers the question — never as
> a constant each side interprets under its own rule.**

The emphasis on _decision_ is the whole rule; single-sourcing a constant is the easy half and it is not
enough. `packages/protocol/src/lib/state-home-layout.ts` is the worked example: it exports the version,
the marker filename, the file mode **and `decideLayout()`**, which is what a caller actually asks. Had
it exported only the version literal, every caller would still have written its own answer to "may I
use this home", and a client applying its own weaker rule could adopt a genuinely foreign directory —
trading one silent failure for a worse one. That is why
`cli-contracts.sh state-home-layout-claim` pins the decision and not the literal.

The same rule read backwards tells you where the owner goes: **above every consumer, in the package
they all already depend on.** Not in the first package that needed it. A fact welded into a lower layer
cannot be worked around from above — the pairing mint could not advertise a correct address no matter
what it did, because the protocol schema refuses any response whose link disagrees with the daemon it
names. That refusal is the right invariant; it simply means the fact has to be decided before the
schema sees it.

### The tell that a fact is missing an owner

> **A workaround being necessary is the signal that one fact is missing an owner.**

Earned the hard way. `mayGrant` and `governed` looked like two spellings of one fact, and the teammate
who argued for collapsing them was wrong. The tell was that a workaround — deriving a posture from
per-capability unanimity — was _needed_ at all. Nobody writes that unless the question they want to ask
has no owner to ask.

When you find yourself deriving something the system should have told you, stop and name the fact you
are deriving. Then decide whether it is missing an owner or, as below, whether it is two facts.

---

## R2 — Derivation: prove completeness, not merely soundness

A second enumeration of a protocol-owned set must be **derived** from it. Where a literal spelling is
needed for type exactness, it must be proved **exhaustive by the compiler**.

> `strictObject` and `as const satisfies readonly T[]` prove **soundness** — no wrong member. They do
> not prove **completeness** — no missing member. Completeness is the failure that ships.

A wrong member is caught the first time anybody looks. A missing member reads as a correct list. Reach
for a mapped type, which makes the omission a compile error at the declaration:

```ts
// A seventh capability is now a COMPILE ERROR here, not a runtime surprise somewhere else.
const CAPABILITY_GRANT_FIELDS = {
  fleet: grantSchemaFor('fleet'),
  terminal: grantSchemaFor('terminal'),
  // …
} as const satisfies { readonly [K in DaemonCapability]: ReturnType<typeof grantSchemaFor> };
```

**Prefer this to a gate.** [Contracts](../contracts/README.md) already says that an invariant fitting in
one file belongs in a type or a test; an enumeration a mapped type can close does not need a script,
and a script is the more expensive of the two to keep honest.

---

## R3 — Honesty about what a build does not honour

A schema may accept a key this build does not act on. It must **say so mechanically**, in output an
operator sees, not in a comment.

`packages/fleet/src/lib/capabilities.ts` is the model. `unimplementedCapabilities(config)` compares
each entry against the schema's own default and refuses `fy fleet apply` with the list, so a
configuration that merely carries defaults is unaffected and one that _asks_ for something is answered.
Its own docblock states the rule better than an abstraction would:

> Accepting a key is not the same as honouring it, and the difference used to be invisible — a fleet
> could be told to pool its sessions across accounts, apply cleanly, and pool nothing, with no line of
> output saying so.

The generalisation: **a validated wire that nothing serves is the same defect as two disagreeing
definitions**, with the second definition being the empty set. A push schema shared by both ends, with
no daemon route behind it, is a fact whose second owner is a silence.

---

## R4 — Prefer a total record to a partial one at a boundary

A boundary schema that demands every member of an enum deletes a class of "what did silence mean"
reasoning downstream — and the domain must not then re-litigate it.

This was found the expensive way: a fail-open policy was written, with a paragraph explaining it, for a
state the schema had already made unrepresentable. Two answers to one question, one of them dead code
that read as a deliberate safety decision. `z.record(KindSchema, z.boolean())` in zod v4 requires every
key; `CapabilityGrantsSchema` requires all six. Where the total form is available, take it, and delete
the downstream branch rather than leaving it as documentation of a state that cannot occur.

---

## R5 — Detection, because a rule nobody enforces is a comment

Whatever R1–R4 cannot make compiler-visible gets a contract, and a new contract follows
[Contracts § Adding a contract](../contracts/README.md#adding-a-contract) — including proving it
**fires** on a planted violation, because a gate that never fails is indistinguishable from one that
does nothing.

What this class already has on `main`:

| Fact                                    | Owner                                                         | What notices a second definition            |
| --------------------------------------- | ------------------------------------------------------------- | ------------------------------------------- |
| the state home's layout decision        | `protocol/src/lib/state-home-layout.ts`                       | `cli-contracts.sh state-home-layout-claim`  |
| the default state home path             | derived from the product name                                 | `cli-contracts.sh state-home-default`       |
| the log directory inside the state home | shared between the CLI and the daemon                         | `cli-contracts.sh state-home-log-directory` |
| the default daemon address              | `protocol/src/lib/address.ts`                                 | `cli-contracts.sh daemon-default-address`   |
| the product and binary names            | `package.json` × 2 ([Architecture](../architecture/index.md)) | `cli-contracts.sh name-single-source`       |
| a daemon's data, per daemon, in the PWA | `daemonSessionKey()` and `DaemonConnection`                   | `daemon-scope.sh`                           |

Read that table as a shape, not as a list to memorise: every row is one fact, one named owner, and one
mechanism that fails a commit. **A row with an owner and no mechanism is an intention**, and a
mechanism whose fact has no named owner is a gate nobody can satisfy on purpose. `conflict-markers.sh`
is deliberately not in the table: it refuses an artefact rather than pinning a fact, which is why
[Contracts](../contracts/README.md) has to argue separately for why it earns its place.

---

## The anti-rule: sometimes SPLIT rather than collapse

> **The fix for a duplicated fact is sometimes to split it correctly rather than to collapse it. A
> refactor measured by how much it merged will over-merge, and produce a worse system than the
> patchwork it replaced.**

This is the guard on everything above, and it is not a hedge. `mayGrant` and `governed` were resolved
by making them answer **different** questions — _may this caller widen this capability_ versus _where
did this caller arrive from_ — not by deleting one. Two questions that share a sub-fact are
single-sourced at the **sub-fact**, and left distinct above it.

### One fact, two legitimate input domains, needs two named functions

The sharpest case is the predicate the authorization model rests on. "Is this loopback" was written
five times across four packages, and no two of the first three agreed on membership:

| site                       | membership                            | input domain                   |
| -------------------------- | ------------------------------------- | ------------------------------ |
| the daemon's config loader | `127.0.0.1` `::1` `localhost` `[::1]` | a configured **host spelling** |
| the Bun API server         | `127.0.0.1` `::1` `::ffff:127.0.0.1`  | a socket's **peer address**    |
| the relay connection       | `localhost` `127.0.0.1` `[::1]`       | a **URL hostname**             |

**And each one is individually correct.** The socket must accept the IPv4-mapped form, because that is
what a dual-stack listener actually reports, and must reject `localhost`, because a peer address is
never a name. The config loader must accept `localhost`, because an operator writes names. They are
right _because their input domains differ_ — and nothing in the code said so, which is why the fourth
and fifth copies got written.

> **One fact with two legitimate input domains needs two named functions, not five anonymous sets.**
> `isLoopbackHost(host)` and `isLoopbackPeer(address)` make using the wrong one impossible; one merged
> `isLoopback()` would make it inevitable.

The general form: before collapsing two definitions, check whether they differ **because their inputs
differ**. If they do, the duplication was a symptom of a missing name, and merging destroys a
distinction the system needs.

---

## Rules for the reasoning that finds these

The defect is silent, so it is found by argument and by measurement rather than by a stack trace. Both
of those have failure modes of their own, and every rule below was earned by somebody in this
repository getting it wrong — usually somebody who had just written the rule they broke.

### A rule derived from one member of a set must be re-tested against every other member

`host` has three interesting values: loopback, a wildcard, and a real address. A rule checked against
one of them is a third of a rule. Two teammates each generalised a wildcard-only rule to loopback, **in
opposite directions, within an hour** — one over-refusing every default single-machine install, the
other passing an address nothing off the host can dial. Neither error was visible in the case its
author had in mind.

Enumerate the set, then walk it. Where the set is small enough to write down, write it down beside the
rule.

### State the file set, the pattern, and the unit

A conformance claim is only as good as its probe, and a probe is three separate things that can each be
wrong:

```bash
# the FILE SET — stated, so the next reader reproduces the number instead of trusting it
git ls-files "packages/*/src/lib/*" | grep '\.ts$' | grep -v tests    # 634 files at 00b733d0, all six packages

# the PATTERN — and the UNIT it counts, because rg -c counts matching LINES, not occurrences
rg -c '^\s*(private\s|(readonly\s+)?#[A-Za-z])'
```

> **An under-match reads as compliance.** Treat any zero, or any suspiciously clean count, as a bug in
> the probe until a per-package breakdown says otherwise.

That is the dominant failure mode, not the exception. In the survey behind this article every
measurement error was in a sweep and none was in the code, and most were under-matches: a `**` git
pathspec that silently dropped three whole packages and most of a fourth; a pattern for private members
that missed every `private` keyword because `private` is followed by a space; a pattern for
module-level singletons that a type annotation or an underscore was enough to hide from. Each returned
a smaller, tidier number, and each read as a clean bill of health.

> **State the probe, or two runs of "the same" measurement are not the same measurement.**

A distinct mechanism, and it does not look like an error at the time: two turns, two patterns, neither
written down, and both numbers faithful to what they actually measured. Nothing was wrong except that
the comparison was void. When two correct probes disagree, the instinct is to find the wrong one; the
answer is sometimes that both are right and the reconciliation is the finding — one pattern counted
`readonly #field` and the other did not, and the difference was exactly the delta.

The enumeration of those errors lives in one place, in the source document, and is deliberately not
repeated here. A count restated in three articles is this article's own subject matter.

### A claim about the code rots at the rate the code moves

One finding in that survey was true when it was written and false six hours later, because the fix
landed while it was being reviewed — and it was caught only because `CLAUDE.md` happened to change
under its author. So: **cite decisions and file paths in the argument, and stamp any count or
coordinate taken from the code with the commit it was checked at.** A line number in prose is a claim
with a shelf life of days; a path and a name survive a refactor, and a stamped number tells the next
reader which probe to re-run rather than whether to trust you.

### A tool answering is not a tool agreeing

The tool ran, exited zero, and printed something. That is not evidence it answered the question you
asked. Every one of these has cost time in this repository:

| you meant                     | the tool did                                                              |
| ----------------------------- | ------------------------------------------------------------------------- |
| `rg -r` to search recursively | `--replace`, so a symbol that exists prints as absent                     |
| a `**` glob in a git pathspec | `*` already crosses `/`, so `a/*/b/**/c` silently under-matches           |
| "did this ship?"              | `git branch --contains` answers ancestry; a squash merge rewrites the SHA |
| a formatter tidying a file    | `treefmt` rewrote a conflict marker into a valid Markdown blockquote      |

The habit that catches all four: **make the tool fail once on purpose.** Plant the thing you are
searching for and confirm the probe finds it, exactly as a new contract must be proved to fire.

---

## What a gate may honestly claim

A gate's documentation is a claim about coverage, and an overstated claim is worse than no gate,
because it moves the fact into the "already handled" column.

**Reachability proves reach at one granularity only.** `composition-reachability.sh` proves a module is
used; `composition-invocation.sh` proves a world field is read. Neither sees a **method**. Three
instances, three granularities: an unreachable module; a world field nothing invoked
(`SessionResumeService`, through four wiring units); and — found in review of a unit still in flight —
a fan-out method with no production caller, because its sibling called the transport directly. The
third would pass every gate this repository has, since the module is reachable through its other
methods.

> **Built, tested, 100% covered and dead survives every gate this repository has.**

**Agreement between two ends is not capability at either end.** A gate that proves a client path
matches a served route proves the two ends agree about the wire. It cannot prove the client is able to
make the call. The live example: `packages/pwa` registers a service worker at `sw.<release>.js`, and
**no source file and no build step in this repository emits that script** — so `pushManager.subscribe`
cannot succeed in a real browser however many routes are live and however well the two ends agree about
them. Any gate of that family must state this limit in its own documentation, or "route agreement
passed" will be read as "the feature works".

Both limits are stated here rather than in the gates' own sections because they are properties of the
class, not of the two scripts.

---

## Two settled questions

Recorded so nobody re-litigates them. Both were measured over the file set above.

**An overridable ambient-clock default is conformant** — the read must sit in the signature, every
call site must be able to override it, and the value must be local to this program. The rule, its three
conditions and its probe are in
[Date/Time Handling § An overridable default IS a dependency](../datetime/index.md#an-overridable-default-is-a-dependency).

**A module-load instance that stays injectable is a named exception to "No Singletons"** — when a
framework forces the timing, the value stays injectable, its lifecycle owner holds a reference, and the
declaration says why. The four conditions and the one value that meets them are in
[SOLID Principles § The one exception](../solid-principles/index.md#the-one-exception-a-value-a-framework-needs-at-module-load).

Each ruling is owned by the article whose rule it modifies, and the two sentences above are a signpost
rather than the rule. If a signpost and its article ever disagree, **the owning article wins** — and
the disagreement is a defect of exactly the kind this page is about. That is R1 applied to this page.

---

## Quick Checklist

Before adding a fact:

- [ ] Does a second program need to agree with me about this? If yes, it belongs in
      `@ferretry/protocol`.
- [ ] Am I exporting a **decision** — the function callers actually want — or only a constant they will
      each interpret?
- [ ] Is the owner above every consumer, in a package they all already depend on?
- [ ] Can a missing member of this set be a compile error? Prefer a mapped type to a gate.
- [ ] Does this build honour every key the schema accepts, or does something say out loud that it does
      not?

Before collapsing two definitions:

- [ ] Do they differ because their **inputs** differ? Then name both; do not merge.
- [ ] Am I writing a workaround? Then name the fact that has no owner, and give it one.
- [ ] Did I derive this rule from one member of a set? Walk the rest of the set before it becomes the
      rule.

Before claiming conformance:

- [ ] Is the file set stated? The pattern? The unit it counts?
- [ ] Is the number suspiciously clean? Assume the probe, not the code.
- [ ] Did I prove the probe fires on a planted violation?
- [ ] Does the gate's own documentation state what it cannot see?

---

## Related Articles

- [Contracts](../contracts/README.md) — the mechanisms that enforce this, and how to add one
- [Repository Architecture](../architecture/index.md) — the two-name model, this rule's oldest
  instance
- [Software Design Philosophy](../software-design-philosophy/index.md) — locality, and why a
  second owner destroys it
- [Data Validation](../validation/index.md) — parse-don't-validate, where a fact enters a program
- [SOLID Principles](../solid-principles/index.md) — dependency management inside a package
- [Testing Conventions](../testing/index.md) — why passing tests are not evidence of agreement
