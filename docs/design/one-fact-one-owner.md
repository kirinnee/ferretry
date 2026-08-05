---
id: one-fact-one-owner
title: One fact, one owner — the refactor plan of record
---

# One fact, one owner

**Status: proposal, and the plan of record for the halt. Nothing here is built.**
**Verified against `origin/main` at `52dc6a20` (`release: 0.160.1`).**

Development is halted. Every feature unit has stopped: push (#302, open, green), the pairing UI
follow-up (#300, open), the wildcard-advertisement fix. This document is the only workstream.

It answers the owner's two instructions. The first:

> relook at the WHOLE thing and make sure its all generalize, unfied and not too complicated, not
> patchwork over patchwork over patchwork.
>
> there should be a standard model/framework (daemon settings, client settings, capabilities), all
> these should be an overarching framework, and NOT patch work -- thats a big leading to bugs

and the second:

> please halt all development, and fix up everything (do a full refactor and clean up, conform to all
> the doctrines first ok?)
>
> also i WANT to support multiple relay type! please ensure that works.

Six teammates contributed verified findings while halted: hadi, mika, cinthia, temperance, frederick.
Their evidence is folded in and attributed. Every claim below was re-checked against `52dc6a20` by
content, including my own from the previous revision — one of which had already been fixed. See §11.

---

## 0. Verdicts

1. **The dead QR is the top priority and it is one line.** `publicUrl: value.publicUrl ?? bindUrl`
   (`daemon/src/lib/runtime/config.ts:315`). The default bind is loopback, so **the default
   configuration mints `url=http://127.0.0.1:7431/`** and on the phone that address is the phone. No
   misconfiguration required. §2.
2. **Multiple relay carriers: the owner has decided, and it is specified in §6.** I argued against it
   and was overruled. My argument is preserved verbatim as the recorded cost of the decision (§6.1),
   because that is what hadi asked for and because the cost is the work.
3. **Daemon settings and capabilities are one surface.** `grants` is one field of
   `config/daemon.json` and the only one with a complete lifecycle. Give the other nine the same one.
4. **Client settings are genuinely a different model** sharing only a mechanism, currently written out
   by hand twelve times. Forcing them into the daemon model would be a false unification.
5. **Authorization is two layers plus a category error, not three.** `RouteScope` welds credential
   class to arrival privilege into a total order that cannot express what #295 needed. §5.
6. **The doctrines are largely followed, and the drift is concentrated in `packages/pwa/src/lib`** — the
   one package with no cross-process agreement problem at all. Measured over 634 files with the glob
   stated so it is reproducible, after hadi caught my first sweep using a broken pathspec. **The
   patchwork the owner is complaining about is not doctrine drift**: no doctrine article says anything
   about two programs agreeing on one fact, which is the failure that keeps shipping. The deliverable
   therefore includes a new doctrine article. §7.
7. **The fix for a duplicated fact is sometimes to SPLIT it, not to collapse it.** temperance's
   `mayGrant`/`governed` case proves it. A refactor that only merges will over-merge. §4.5.
8. **A pairing link must say who can redeem it, not merely exist.** The advertisement has three
   answers, not two — cinthia caught my first draft contradicting itself and hadi confirmed it. §2.4.

---

## 1. The defect, stated once

> **One fact, two definitions, and no mechanism that can notice they disagree.**

Both halves pass their own tests, because each half owns its own fixture. The failure is always silent
and always reads as a benign empty case — no accounts, no notifications, no relay, no permission, no
working QR.

The repository already knows this. `docs/standards/contracts/README.md` says of the state home:
"Every one of them passed its own tests, because each writer owned its own fixture." The insight is
correct and its application stopped at three contracts.

### 1.1 The survey — fourteen instances

| #   | The fact                                | Definition A                              | Definition B                                                 | Status                         |
| --- | --------------------------------------- | ----------------------------------------- | ------------------------------------------------------------ | ------------------------------ |
| 0   | **the address another device may dial** | `publicUrl ?? bindUrl` (a default)        | `reachableOffHost` (a predicate); pairing consults neither   | **LIVE — the owner's blocker** |
| 1   | the fleet manifest's shape              | `@ferretry/fleet` `FleetManifestSchema`   | a second schema in `daemon/lib/core/inventory.ts`            | fixed (#288)                   |
| 2   | when a state home may be used           | the daemon                                | three CLI write paths                                        | fixed (#293)                   |
| 3   | the six capabilities                    | `DAEMON_CAPABILITIES`                     | `CapabilityGrantsDocumentSchema` spells all six again        | **live**                       |
| 4   | the push surface                        | `protocol/lib/push.ts` + PWA enrolment    | no daemon route exists                                       | **live** (#302 halted)         |
| 5   | the pairing route table                 | the code                                  | my own summary of it, which was wrong                        | **live** (no gate)             |
| 6   | the hosted relay's address              | PWA reads the advertisement               | daemon did not                                               | **fixed (#301)** — see §11     |
| 7   | "may this caller do this thing"         | `RouteScope`                              | `TokenClass`, `CapabilityGrants`, **and an inline check**    | **live**                       |
| 8   | **"is this loopback"**                  | five predicates in four packages          | no two of the first three agree on membership                | **live**                       |
| 9   | the set of client settings              | `SETTINGS_DEFINITIONS` (8 rows)           | 12 independent `localStorage` modules                        | **live**                       |
| 10  | the notification kinds                  | `PushNotificationKindSchema`              | `NOTIFICATION_KINDS` in the PWA                              | **live**                       |
| 11  | the contract registry                   | the `all` loop in `cli-contracts.sh` (17) | the table in `docs/standards/contracts/README.md` (13)       | **live**                       |
| 12  | the grants doctrine                     | §"LOCALITY is the layer"                  | §"the password is the layer" — same file                     | fixed in #300 (halted)         |
| 13  | the word "capability"                   | 6 governed capabilities                   | `['daemon-api']` in pairing; unhonoured config keys in fleet | **live**                       |
| 14  | **"this code is reached"**              | `composition-reachability` (module)       | `composition-invocation` (field) — neither sees a **method** | **live**                       |

Findings 0, 8 and 14 are new since the previous revision. Findings 6 and 12 were fixed _during_ this
session, which is itself evidence (§11).

### 1.2 Finding 8 — the predicate the whole security model rests on has five definitions

`docs/grants.md` says loopback is the entire basis of the authorization model. Here is that predicate,
on `52dc6a20`:

| #   | site                                                       | membership                            | input domain                   |
| --- | ---------------------------------------------------------- | ------------------------------------- | ------------------------------ |
| 1   | `daemon/src/lib/runtime/config.ts:19` `LOOPBACK_HOSTS`     | `127.0.0.1` `::1` `localhost` `[::1]` | a configured **host spelling** |
| 2   | `daemon/src/adapters/api/bun-api-server.ts:92` `LOOPBACK`  | `127.0.0.1` `::1` `::ffff:127.0.0.1`  | a socket's **peer address**    |
| 3   | `relay/src/lib/connection.ts:52` (inline)                  | `localhost` `127.0.0.1` `[::1]`       | a **URL hostname**             |
| 4   | `pwa/src/features/onboarding/hosted-relay.ts:121` (inline) | `localhost` `127.0.0.1` `[::1]`       | a **URL hostname**             |
| 5   | `protocol/src/lib/address.ts:18` `LOOPBACK`                | `127.0.0.1`                           | the **default host**           |

No two of 1–3 agree. Sites 3 and 4 are character-for-character identical **across a package boundary**
— and `packages/pwa` already depends on `@ferretry/relay`, so the copy is avoidable today.

**And each one is individually correct.** That is the important part, and it is why this survived
review. Site 2 must include `::ffff:127.0.0.1`, because that is what a dual-stack Bun socket actually
reports, and must exclude `localhost`, because a peer address is never a name. Site 1 must include
`localhost`, because an operator writes names. The two are right _because their input domains differ_
— and nothing in the code says so. There is no shared owner, and no name that tells a reader which
domain they are in.

So the fix is not "somebody was sloppy". It is:

> **One fact with two legitimate input domains needs two named functions, not five anonymous sets.**

`#301` already got halfway there by introducing `isLoopbackHost()` beside site 1. §5.4 finishes it.

---

## 2. The blocker: the advertised address

### 2.1 What happens

```
https://ferretry.pages.dev/pair#v1;url=http%3A%2F%2F127.0.0.1%3A7431%2F;code=R5MT-2TZZ;fp=fy_daemon_…
```

The owner scans this. The PWA opens on the phone, parses `url=`, and dials the **phone's own
loopback**. Nothing happens, and nothing says why.

The chain, every link verified:

1. `config.ts:315` — `publicUrl: value.publicUrl ?? bindUrl`
2. `bindUrl = daemonAddress(host, port)`, and `host` defaults to `127.0.0.1` (`config.ts:219`)
3. `bin/fyd.ts:3571` — `daemonUrl: config.publicUrl` is handed to `PairingService`
4. `pairing/service.ts:393` — `url.hash = \`v1;url=${encodeURIComponent(daemonUrl)};…\``
5. no loopback check exists anywhere on the path — frederick checked all three renderers
   (`cli/src/lib/pair/render.ts`, `controller.ts`, `daemon/src/lib/pairing/service.ts`, and the PWA
   Add-a-device panel) and found none.

**The default configuration cannot deliver the journey `docs/pairing.md` describes.** frederick, who
wrote that document this week, states the miss plainly: it declares six GAPs and none of them is _the
defaults cannot produce this at all_. A document internally consistent and still wrong about the
product.

### 2.2 Why this is exactly the thesis

`publicUrl` is **two facts in one field**: _where I listen_ and _where I can be reached_. The `??` is
the weld. The docblock five lines above it even separates the two meanings — "`publicUrl` is what this
daemon is REACHED at" — and then defaults one to the other.

mika's framing is the best one and I am adopting it:

> The grant layer already separates _how a request arrived_ from _what address is written down_:
> `ApiRequest.loopback` is carrier-derived and `tunnelApiRequest` forces it `false`. **The pairing link
> is that same distinction applied to an OUTBOUND value instead of an inbound one** — and it was never
> made.

So this is not a new idea. It is a proven principle applied to the one direction nobody applied it to.

### 2.3 The blast radius — four derivation sites, two packages

cinthia mapped this before halting and I re-verified all four:

1. `config.ts:315` — the load path. **The default case, which is the owner's bug.**
2. `config.ts:343` — `configuredAt()`, the port-move path.
3. `config.ts:397` — `overriddenBy()`, the `--host`/`--port` path.
4. `protocol/src/lib/address.ts:60` — `recordedDaemonAddress()`, the **client** side, which reads
   `host`+`port` out of the document verbatim with no validation, substituting `127.0.0.1` when `host`
   is absent. Different package, different coverage ledger — it will not fall out of a daemon-side fix.

Plus the wildcard variant: `host: '0.0.0.0'` derives `http://0.0.0.0:7431`, and reverting `host`
afterwards silently invalidates every link minted while it was set.

### 2.4 The fix: one owner, in the protocol, as a decision

The one owner must sit **above** the pairing service, because frederick verified that the protocol
_enforces_ the weld and it cannot be worked around downstream:
`PairingCodeMintResponseSchema.superRefine` refuses any response whose `pairUrl` fragment is not
exactly `url=<daemonUrl>;code=…;fp=<daemonId>`. That is the right invariant — a link must not disagree
with the daemon it names — and it means no layer below the config can advertise a different address.

New module, `packages/protocol/src/lib/advertisement.ts`, following the `state-home-layout.ts` shape
exactly: the **decision**, pure and total, in the one package all three consumers already depend on.

```ts
export type AdvertisementRefusal = 'loopback-bind' | 'wildcard-bind' | 'no-port';

export type Advertisement =
  /** An address a DIFFERENT device can dial. */
  /** A different device can dial this. Mint the link and draw the QR. */
  | { readonly kind: 'address'; readonly url: string; readonly origin: 'operator' | 'derived' }
  /**
   * Correct for a browser ON this machine, dead off it. Mint the link and SAY SO.
   *
   * NOT a refusal. A loopback-only daemon is a working daemon and its address is genuinely right for
   * the caller who can use it — one person, one laptop, a browser on `127.0.0.1` is the common case
   * `docs/grants.md` is built around. What is wrong is handing that address to somebody who cannot
   * use it WITHOUT SAYING SO.
   */
  | { readonly kind: 'local-only'; readonly url: string }
  /** There is nothing to hand out at all. Refuse and name the fix. */
  | { readonly kind: 'none'; readonly refusal: AdvertisementRefusal };

export function decideAdvertisement(input: {
  /** An operator's own `publicUrl`. ALWAYS wins, never second-guessed — see below. */
  readonly operatorPublicUrl?: string;
  readonly host: string;
  readonly port?: number;
}): Advertisement;
```

Three rules, and the first is the one temperance warned about:

- **An operator-set `publicUrl` always wins and is never validated against the bind.** A daemon behind
  a reverse proxy or a tunnel legitimately advertises an address it does not bind — that is precisely
  why `advertisesForeignAddress()` exists. Reachability must never be re-derived from
  `publicUrl !== bindUrl`; that reads a correct proxy deployment as broken.
- **A loopback host is `local-only`.** `isLoopbackHost` decides, from the single owner §5.4 creates.
- **A wildcard host (`0.0.0.0`, `::`) or a missing port is `none`.** The daemon serves perfectly on a
  wildcard; what is undefined is only which address to _hand out_.

**Why three answers and not two.** My first draft had two, and cinthia caught that it contradicted
itself — hadi verified the contradiction in the document rather than taking either of our words for it.
The two rules were "a loopback host derives no advertisement" and "minting refuses when there is no
advertisement", whose composition refuses **every default single-machine install** — which is the exact
outcome I had just rejected boot-refusal for, and which my own comment calling a loopback-only daemon "a
working daemon" contradicts. Moving the refusal from boot to mint would not have saved the default
install; it would only have changed when it broke.

It is also the asymmetry cinthia spotted in my own argument: §2.2 says the outbound value deserves the
same distinction `ApiRequest.loopback` makes inbound. Inbound has local / remote / relayed. Two-way
outbound was not that distinction carried through; three-way is.

### 2.5 Say who can redeem it — refuse only when nobody can

The doctrine, sharpened by cinthia from what I first wrote:

> **Never mint a link without saying who can redeem it.**

That is strictly better than "never mint a link that cannot be redeemed", because it fixes the owner's
blocker without over-refusing: the QR stops being silently dead and starts saying who it is for.
frederick's framing of the underlying rule stands — the grant surface refuses to draw a widening switch
a remote caller can never move, and pairing drew a QR that could not be redeemed.

Concretely, on `PairingCodeMintResponseSchema`:

| advertisement | `daemonUrl` / `pairUrl` | what `fy pair` and the Add-a-device panel do                                                                                             |
| ------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `address`     | present                 | draw the QR, as today                                                                                                                    |
| `local-only`  | present                 | show the link, **do not draw a QR**, and say plainly that only a browser on this machine can redeem it — with the one-line fix beside it |
| `none`        | absent, `refusal` set   | no link at all; state the refusal and the fix                                                                                            |

- The response gains `reach: 'any-device' | 'local-only'`, present **iff** `daemonUrl` is, and
  `refusal` present **iff** it is not.
- The `superRefine` becomes: `pairUrl` present **iff** `daemonUrl` present, and when present the
  fragment must match. **frederick's invariant is kept** — a link cannot disagree with the daemon it
  names — and the missing one is added.
- The fix sentence is the same in all three surfaces: _"set `publicUrl` to the address other devices
  reach this machine at, e.g. `http://192.168.1.10:7431`"_. frederick confirms the browser already has
  what it needs (`pairingSeedFromUrl` parses `url=`, `pairingDaemonHost` extracts the host), so this is
  a few lines in one place.
- **No new exit code.** cinthia flagged that `cli/src/lib/daemon/unit-file.ts:119` hardcodes
  `RestartPreventExitStatus=78 69` and launchd has no equivalent, so a third code needs both templates
  changed together or a supervisor respawns forever. Deciding at the mint rather than at the boot means
  there is no third code at all. That is the second reason to prefer it, and it survives the three-way.

#### 2.5.1 The trap — do not condition the mint on the requester's carrier

cinthia's warning, verbatim, because it belongs where somebody would reach for the shortcut:

> **Do not condition the mint on the requester's own carrier.** `ApiRequest.loopback` tells you who is
> MINTING, not who will REDEEM — and the common case is a person at the machine minting a code to scan
> with their phone. The minter is loopback and the redeemer is not. That shortcut would re-mint exactly
> the owner's dead QR and look correct in every local test.

This is the single most likely wrong implementation of Wave 0, and it would pass every test written by
somebody working on one machine. The advertisement is a property of the **daemon's configuration**, never
of the request asking for it.

#### 2.5.2 The pattern, for the fact-ownership article

hadi noted it and it is worth carrying: I caught cinthia generalising a wildcard-only rule to loopback,
and then made the same error in the opposite direction within the hour. Two people, same mistake, both
directions.

> **A rule derived from one member of a set must be re-tested against every other member before it
> becomes the rule.** `host` has three interesting values — loopback, wildcard, a real address — and a
> rule checked against one of them is a third of a rule.

### 2.6 The relay does not rescue this, and that is load-bearing

cinthia's constraint, from the relay unit they shipped:

> **PAIRING CAN NEVER BE RELAYED.** A relayed session is opened with the device grant `POST /v1/pair`
> has not issued yet, so first contact is always direct.

So `reachableOffHost` and `decideAdvertisement` answer **different questions** and must stay separate:

| question                                                     | who asks                    | does a relay count?            |
| ------------------------------------------------------------ | --------------------------- | ------------------------------ |
| can anything off this host reach me at all?                  | `fyd --check` grant posture | **yes** — the daemon dials out |
| can a device dial me directly, right now, for first contact? | the pairing mint            | **no** — never                 |

temperance offered to join them and I am declining the join. This is §4.5's rule in action: **two facts
sharing one sub-fact**. Single-source the sub-fact (`isLoopbackHost`), keep the two questions distinct.
Merging them would make the pairing mint accept a relay that cannot carry it.

---

## 3. The three surfaces, as one model

### 3.1 Daemon settings and grants are one surface

`grants` is **one of ten fields** in `DaemonConfigDocumentSchema`, and the only one with a protocol
schema, a route, a CLI verb, an audit journal, a provenance column, an in-memory enforcement cache and
a fail-closed refresh. The other nine have a schema, a first-boot writer, and `--print-config`. There
is **no `/v1/config` route of any kind** — I checked all 109 daemon route paths.

The naming has already collided: **`fy daemon config` does not configure the daemon.** It is mounted
from `cli/src/lib/grants/commands.ts:28` and reads "read and change what a caller NOT on this host may
do". Somebody typing `fy daemon config set port 7500` finds a command with exactly that name doing
something else.

> **Every field of the daemon configuration document gets the lifecycle `grants` already has, or a
> written statement that it does not and why.**

A contract, satisfiable field by field, shippable incrementally.

### 3.2 Client settings are NOT the same thing

Four load-bearing differences: no second party must agree; the authority rules invert (the reader owns
their theme, nothing may narrow it); the persistence is untrustworthy by nature, so "damaged state is
not empty state" is doctrine for the daemon and _wrong_ for a browser preference; and the blast radius
is a text scale rather than a security event.

But the _mechanism_ is duplicated twelve times — `drafts` · `connections` · `controls` ·
`theme-preferences` · `side-pane-preferences` · `md-compose` · `notification-preferences` ·
`push-enrolment` · `stt/stt-settings` · `store.tsx` · `onboarding-progress` · `setup-handoff` — each
with its own `fy-…-vN` key, its own `browserStorage()` with its own `try/catch`, its own field-by-field
`typeof` parser, and mostly its own store class with `#listeners`/`snapshot()`/`subscribe`.

They do not even agree on behaviour: `parseThemePreference` falls back **per field** so one corrupt
value does not reset the others; `parseSidePanePreferences` resets **everything** on a version
mismatch. Two answers to "what did a partially-bad document mean", neither chosen.

And `zod` is already a direct dependency of `packages/pwa`, used in **three** files. Twelve hand-rolled
parsers are twelve bypasses of the repo's own [Validation](../standards/validation/index.md) standard,
in the package that already has the dependency.

Proposal: one `BrowserDocument<T>` — one storage port, one `try/catch`, one zod parse, one subscribable
snapshot, one decision about partial damage — and the catalog row owns its document, collapsing the
8-row and 12-module enumerations into one. **A shared mechanism with an unshared model.**

### 3.3 What all three genuinely share

Not a schema, not a reader, not a scope. This:

> **For any effective value, a reader can ask five questions and get an answer: what is it, who chose
> it, where is it written, who may change it, and what happens when it cannot be read.**

| obligation          | daemon settings        | grants           | client settings        |
| ------------------- | ---------------------- | ---------------- | ---------------------- |
| what is it          | `--print-config`       | `GET /v1/grants` | the control renders it |
| who chose it        | ✅                     | ✅ `origin`      | ❌                     |
| where is it written | ✅                     | ✅               | ❌                     |
| who may change it   | ⚠️ nobody, via any API | ✅               | ✅ the reader          |
| unreadable ⇒ what   | ✅ boot refuses        | ✅ deny loudly   | ❌ silent default      |

The framework the owner asked for is this table with no ✗ in it. Finite, checkable, independently
shippable.

---

## 4. Where a fact is allowed to be defined

### 4.1 The rule

**R1 — Definition.** Any fact two independently-deployable programs must agree on is defined **once**,
in `@ferretry/protocol`, as a **decision** — a parser or a function that answers the question — never a
constant each side interprets under its own rule. `state-home-layout.ts` is the worked example; §2.4
is the next application.

**R2 — Derivation.** A second enumeration of a protocol-owned set must be **derived** from it. Where a
literal spelling is needed for type exactness, it must be proved **exhaustive** by the compiler, never
merely **sound**.

> `strictObject` and `as const satisfies readonly T[]` prove **soundness** (no wrong member). They do
> not prove **completeness** (no missing member) — and completeness is the failure that ships.

Both live instances are compiler-fixable with no gate at all:

```ts
// CapabilityGrantsDocumentSchema — a seventh capability becomes a COMPILE ERROR here.
const CAPABILITY_GRANT_FIELDS = {
  fleet: grantSchemaFor('fleet'),
  terminal: grantSchemaFor('terminal'),
  browser: grantSchemaFor('browser'),
  filesystem: grantSchemaFor('filesystem'),
  warden: grantSchemaFor('warden'),
  pairing: grantSchemaFor('pairing'),
} as const satisfies { readonly [K in DaemonCapability]: ReturnType<typeof grantSchemaFor> };
```

The apologetic four-line comment at `config.ts` claiming TypeScript cannot catch this is wrong, and it
gets deleted. `NOTIFICATION_KINDS` takes the same treatment via a key map with the array derived.

**R3 — Honesty about the unhonoured.** A schema may accept a key this build does not honour, but it
must **say so mechanically**. `packages/fleet/src/lib/capabilities.ts` already does exactly this —
`unimplementedCapabilities(config)` compares each entry against the schema's own default and refuses
`fy fleet apply` with the list. Its docblock states the principle better than I can:

> Accepting a key is not the same as honouring it, and the difference used to be invisible — a fleet
> could be told to pool its sessions across accounts, apply cleanly, and pool nothing, with no line of
> output saying so.

Generalised, that mechanism is the fix for finding #4: `protocol/lib/push.ts` is a schema the build
does not honour, and it would have been one row in a list and one line of output.

**R4 — Prefer a total record to a partial one at a boundary.** mika's finding.
`PushPreferencesSchema` is `z.record(PushNotificationKindSchema, z.boolean())`, which in zod v4 demands
every enum member — and mika had written a fail-open policy, with a paragraph explaining it, for a
state the schema had already made unrepresentable. Same shape as `CapabilityGrantsSchema` requiring all
six. **A boundary schema that forces every member deletes a class of "what did silence mean" logic
downstream, and the domain must not re-litigate it.**

**R5 — Detection.** What R1–R4 cannot make compiler-visible gets a contract, and the contract registry
is itself gated.

### 4.2 `route-agreement` — approved in principle, and here is the design

**Fails when a client asks for a path the daemon does not serve, or serves with a different verb.**

Closes finding #4 (`/v1/push/*` called since it landed, served by nothing) and finding #5 (I told a
teammate `DELETE /v1/pair/code/:pairingId` existed because I had seen the path; it was `GET`).

Following `daemon-scope.ts` and `composition-reachability.ts` — a real lexical pass in TypeScript with
comments and string bodies handled first, not a grep:

1. extract every `{ method, path }` from `daemon/src/lib/runtime/mounts/**`;
2. extract every quoted `/v1/…` literal with its adjacent verb from `pwa/src` and `cli/src`;
3. a client path matches when a route pattern matches it, treating `${…}` or a segment after a literal
   prefix as satisfying a `:param`;
4. **report both directions** — a client path with no route is a shipped 404; a route nothing reaches
   is dead or undocumented and costs an allowlist line with a reason.

**Seed the allowlist from `main`** so the existing drift is visible rather than absorbed — mika's
explicit request, and the repo's established pattern (the list can only shrink).

**mika's second clause, which changes the gate's honest claim.** `packages/pwa` has **no service
worker**, so even with the daemon routes live, `pushManager.subscribe` cannot be reached in a real
browser. A route-agreement gate proves the two **ends** of a call agree; it cannot prove the client is
**capable** of making it. So the doctrine needs a second clause about client runtime prerequisites, or
a unit ships a validated wire that nothing can dial. The gate's own documentation must state this limit
rather than let "route agreement passed" read as "the feature works".

### 4.3 `docs-integrity`

**Fails on a merge conflict marker in any tracked file, in any formatted disguise.** The `>>>>>>>` in
`docs/grants.md` survived because `treefmt` rewrote it into a **valid Markdown blockquote**; a gate that
only matches the raw form misses the next one identically.

```bash
markers='^(<{7}|={7}|>{7})( |$)|^(> ){7}[0-9a-f]{7,}'
```

Wire it with `files: '.*'`. It is the cheapest contract in the repository. #300 already carries the
resolution and a gate; fold that PR in rather than duplicating it.

### 4.4 `contract-registry`

**Fails when the `all` loop, the README table and the pre-commit wiring disagree.** Today: 17 contracts
run, 13 documented, prose says "ten"; undocumented are `daemon-default-address`, `nix-packages`,
`release-daemon`, `released-version`; and `pages-config.sh`, `relay-config.sh`, `typecheck.sh` have no
row. The registry of the mechanism that prevents enumeration drift has enumeration drift.

### 4.5 The diagnostic, and the anti-rule

temperance's contribution, and it is the most important guard on this whole refactor:

> **A workaround being necessary is the signal that one fact is missing an owner.**

They reached it the hard way. `mayGrant` and `governed` looked like two spellings of one fact; they
argued against adding the second and were wrong. The tell was that a workaround — deriving posture from
per-capability unanimity — was _needed_. The resolution was **not** to delete one, but to make them
answer different questions: _may this caller widen THIS capability_ versus _where did this caller come
from_.

> **Anti-rule: the fix for a duplicated fact is sometimes to SPLIT it correctly rather than to collapse
> it.** A refactor measured by "how many things did we merge" will over-merge and produce a worse
> system than the patchwork.

§2.6 declines a join on exactly this ground. §5.4 splits one predicate into two.

### 4.6 What we should NOT gate

`docs/standards/contracts/README.md` already says it: "If an invariant fits in one file, a type or a
test is the better home for it."

- **No `capability-enumeration` gate.** §4.1's `satisfies` fix makes it a compile error.
- **No gate over what a grant _means_.** Three existing contracts grep doc comments and it has already
  bitten — the word "process" in a `src/lib` comment fails the `arch` contract. That teaches authors to
  delete explanations, which is the opposite of what this codebase needs.

---

## 5. Authorization, collapsed

### 5.1 Four mechanisms, not three

| mechanism           | where                         | how it is actually used                                                     |
| ------------------- | ----------------------------- | --------------------------------------------------------------------------- |
| `TokenClass`        | `api/actor.ts`                | `admin` · `warden` · `device`                                               |
| `RouteScope`        | `api/route.ts`                | of 109 routes: ~101 `admin`, 4 `warden`, 2 `public`, **2 `host`**           |
| `CapabilityGrants`  | `protocol/lib/grants.ts`      | 6 × 2; **8 of 12 axes are demanded by a route**                             |
| **an inline check** | `mounts/session-attach.ts:45` | `if (!context.request.loopback) throw ApiError(403, …, 'attach_not_local')` |

The fourth row is the smell in its purest form. Locality is expressed **three ways**: `scope: 'host'`
(really "admin token only"), a capability demand whose grant applies only to non-loopback callers, and
a bare `if` inside a handler with its own status code — invisible to the route table, invisible to
`GrantsView`, so the UI cannot explain it before somebody clicks. `docs/grants.md` is explicit that a
greyed control with nothing beside it is the dead end the grant model exists to remove.

### 5.2 The category error

`RouteScope` is a **total order over two independent axes**:

|          | credential minimum | requires privileged arrival |
| -------- | ------------------ | --------------------------- |
| `public` | none               | no                          |
| `warden` | any authenticated  | no                          |
| `admin`  | operator-class     | no                          |
| `host`   | operator-class     | **yes, by proxy**           |

`host` means `tokenClass === 'admin'`, used as a stand-in for "on the machine". It is a _sound_ proxy
today — a relayed request always carries a device token — but it is still a proxy, and it has already
produced one wrong answer:

> `POST /v1/pair/code` used to be `host`-scoped … So the UI could not add a second device even while
> running _on_ the machine, and "add a device" had no home outside a terminal. — `docs/grants.md`

**No total order over two independent axes can express "operator credential, any arrival"**, which is
what the pairing UI needed. The tier was abandoned because the type was wrong.

### 5.3 The proposal

```ts
export interface ScopedRoute extends RoutePattern {
  readonly minimum: 'none' | 'authenticated' | 'operator';
  /** Replaces `scope: 'host'` AND every inline loopback check. Declared, so a UI can be TOLD. */
  readonly privilegedOnly?: true;
  readonly capability?: CapabilityDemand; // unchanged
}
```

```
serve iff  credential.class satisfies route.minimum
       and (route.privilegedOnly !== true or arrival.privileged)
       and (arrival.privileged or grantsAllow(route.capability))
```

- `RouteScope` is **deleted**. `public`→`none`; `warden`→`authenticated`; `admin`→`operator`;
  `host`→`operator` + `privilegedOnly`. The pair that could not be expressed now can.
- The inline check in `session-attach.ts` is **deleted** and becomes `privilegedOnly: true`.
- `TokenClass` **unchanged** — it owns "which secret authenticated" and nothing else can answer it.
- `CapabilityGrants` **unchanged in meaning** — it owns what the **operator** decided, as distinct from
  what a **developer** decided. Merging an operator's decision into a developer's would be the false
  unification here, and I decline it.

**Declared behaviour change, for the owner to approve explicitly rather than as a side effect:**
`POST /v1/grants/password` becomes `minimum: 'operator', privilegedOnly: true`. Today it is
`scope: 'host'`, which is admin-token-only and _not_ loopback-only. Not a live hole; it becomes a
stated guarantee instead of a coincidence.

**The owner's law survives.** "local turns things on; remote may configure or narrow, never widen":
"local" becomes "arrived on a privileged carrier" — the same boolean, better named. The widen refusal
in `CapabilityGrantService.patch` depends on patch _content_, not on the route, so it stays where it
is, untouched.

### 5.4 One owner for "is this loopback" — two functions, not one

Finding 8's resolution. In `@ferretry/protocol`:

```ts
/** A host SPELLING, as an operator writes one: names included. */
export function isLoopbackHost(host: string): boolean;
/** A socket's PEER ADDRESS, as a transport reports one: IPv4-mapped IPv6 included, names never. */
export function isLoopbackPeer(address: string): boolean;
/** A bind that names every interface, so no advertisement can be derived from it. */
export function isWildcardHost(host: string): boolean;
```

Two functions because the input domains genuinely differ — which is why the five sets differed, and why
each was locally right. Naming both makes using the wrong one impossible.

`#301` already introduced `isLoopbackHost` beside `LOOPBACK_HOSTS` in `config.ts`. **The model exists;
it is in the wrong package and four places bypass it.** Move it to `@ferretry/protocol`, add
`isLoopbackPeer` for the transport's domain, and delete the four copies. Pin it with a contract in the
shape `daemon-default-address` already uses: no production file outside the owner may spell
`'127.0.0.1'`.

---

## 6. Multiple relay carriers — the owner's requirement, specified

The owner wants this. It is a requirement, not an option. §6.1 records the cost, because hadi asked
that my argument be preserved as the cost of the decision rather than deleted; §6.2 onward is the work.

### 6.1 The recorded cost (my argument, preserved)

`PairingResponseSchema` (`protocol/lib/pairing.ts`) carries `deviceToken`, `daemonId`, `daemonName` and
`capabilities` — **and no carrier at all**. Grepping all of `packages/protocol/src/lib/` finds no wire
shape that publishes a relay address to a client. `PairingCodeMintResponseSchema` publishes exactly one
carrier — `daemonUrl`, the direct address.

So a client discovers a rendezvous **independently**, from its own build-time discovery origin, and the
two ends meet only by coincidence of picking the same one. A daemon on relay A and a browser
discovering relay B never meet. **Redundancy does not fall out.** It costs a new wire field, a client
try-order, a disagreement rule, and a compatibility story. That was the argument against; it is now
the specification.

### 6.2 Configuration: a bounded discriminated union

```jsonc
"carriers": [
  { "kind": "bind",  "host": "127.0.0.1", "port": 7431 },        // LISTENS — attack surface
  { "kind": "relay", "source": "discovery" },                     // the hosted default, resolved at runtime
  { "kind": "relay", "url": "wss://my-relay.example", "enabled": true }
]
```

- **at most one `bind`.** A daemon has one listening socket; more is a different feature.
- **at most four `relay` entries.** Bounded so "expose more" is not free. Each is a **dial-out**, so it
  adds no inbound surface — which is why the cap can be generous while `bind` stays at one.
- **the list is a discriminated union, not uniform records.** A UI or CLI that renders a listen and a
  dial-out as two identical rows makes exposure the easy default. The `kind` carries the consequence.
- `{ kind: 'relay', source: 'discovery' }` makes the hosted default **an ordinary entry** rather than a
  special case, which subsumes the discovery-versus-configured-block branching that exists today.
  `config/daemon.json`'s explicit block keeps winning: an operator's entry is never overwritten.
- `host`/`port`/`relay` remain readable as the **legacy spelling** of a one-bind, one-relay list,
  normalised on read. **Nothing derived is persisted** — the existing rule, respected.

### 6.3 The wire field

The daemon publishes its carrier set to the device at the one moment guaranteed to be direct —
redemption:

```ts
export const DaemonCarrierSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('direct'), url: z.url() }),
  z.strictObject({ kind: z.literal('relay'),  url: SocketEndpointSchema }),
]);

// PairingResponseSchema gains:
carriers: z.array(DaemonCarrierSchema).max(8).readonly().default([]),
```

On `PairingResponse` rather than only on the mint response, because the mint response is read by the
**host** UI and the redemption response is read by the **device**, which is who needs it. Plus
`GET /v1/carriers` (`minimum: 'authenticated'`) so a paired device can refresh without re-pairing.

**A relay URL is not a secret**, so publishing it to a device it has already been authorised to pair
with discloses nothing the rendezvous does not already know. The daemon **fingerprint** stays out of
anything a reader might paste into an issue — the existing rule, preserved.

### 6.4 Older client, newer daemon

This needs stating because it is a real trap. `PairingResponseSchema` is a `strictObject`, so an older
client parsing a newer daemon's response **fails on the unknown key**. Adding a field to a
device-facing response is therefore a breaking change, not an additive one.

The repository already has the mechanism: `packages/protocol/src/lib/version-skew.ts`. The rule belongs
there, written down:

> **A key added to a device-facing `strictObject` ships in the same release as the client that reads
> it, or it is a breaking change.** The pairing fragment is already versioned (`v1;…`); a second version
> is the escape hatch if one is ever needed.

Recommendation: land it now, while the population of paired devices is small enough that "same release"
is achievable, and record the rule so the next such field is not an outage.

### 6.5 Client try-order — deterministic, and not a health check

The existing contract in `docs/relay-protocol.md` §13 is preserved verbatim: _the carrier is chosen by
trying it, not by a health check._

1. every `direct` carrier, **in the order the daemon published them**;
2. then each `relay`, in published order;
3. only a **transport** failure advances. A `503` is an answer — the daemon is reachable and saying so
   — and stops the walk;
4. the winner is remembered for the life of the connection. **A round in which nothing worked is not
   remembered** — it served no request, so there is no answer to keep.

**Published order is the daemon's preference, which is the operator's**, and that is the right
authority. No client-side scoring and no latency race: a race makes the choice nondeterministic and
unexplainable, and `ActiveCarrierCard` has to be able to say _why_ a carrier won.

### 6.6 The disagreement rule

One sentence: **the daemon is authoritative; the client's copy is a cache.**

| disagreement                                  | behaviour                                                                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| daemon dropped a relay the client still holds | the handshake finds no daemon at that rendezvous; the client advances. Not an error — a miss. The stale entry is pruned on the next successful connection.    |
| daemon added a relay the client lacks         | the client never tries it. Fixed by refreshing from `GET /v1/carriers` after any successful connection and **replacing** the stored set.                      |
| nothing published is reachable                | report every attempt with its cause, name the rendezvous origins tried, do not name the fingerprint. `0` is never a close code. Existing contract, preserved. |

### 6.7 What multi-relay unlocks, honestly

Once the wire field exists the benefit is real and larger than redundancy: a self-hosted relay for a
LAN plus the hosted one for elsewhere; and — with §2's advertisement split — a **direct LAN carrier up
alongside the relays**, which is what pairing needs, since pairing can never be relayed. That last one
is the strongest argument for the owner's instruction and it is worth recording as the reason.

Privilege stays **binary**, per §5. A relay carrier answers `false` unconditionally; a bound socket
answers per connection. **Multiple relays do not weaken the rule — they instantiate it N times.**

---

## 7. Doctrine conformance — measured, not assumed

The owner asked for conformance to `docs/standards/`. I measured it. **The file set is stated so this
is reproducible rather than trusted** — my first attempt used a `**` git pathspec that silently matched
only 479 of 634 files, excluding `fleet`, `protocol` and `relay` entirely and 76 of 84 `pwa` lib files.
hadi spot-checked one number, it did not hold, and re-running found a second wrong one. The corrected
sweep is:

```bash
git ls-files "packages/*/src/lib/*" | grep '\.ts$' | grep -v tests    # 634 files, all six packages
```

| doctrine                                                          | rule probed                              | result on 634 files                                                                                                                                                                       |
| ----------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SOLID — zero private methods                                      | `private`/`#` members                    | **159 occurrences in 38 files (6%).** Largely conformant; the concentration is `pwa/lib/stt/browser-recognition.ts` 19, `pwa/lib/relay-session.ts` 17, `daemon/lib/relay/link.ts` 13      |
| SOLID — no singletons                                             | `export const x = new …`                 | **one**, `pwa/src/lib/drafts.ts:189` `documentDraftStore`. **A knowing, documented exception** — the composer needs a value at module load, before any React context exists. See below    |
| Datetime — never read the ambient clock in domain code            | `Date.now()` / argless `new Date()`      | **9 reads, and every one is an injectable default** (8 default parameters in 6 `pwa/src/lib` files, plus `options.now ?? (() => new Date())`). **Zero required ambient reads.** See below |
| Three-layer — no adapter imports from `src/lib`                   | already gated by `cli-contracts.sh arch` | Conformant by construction                                                                                                                                                                |
| Validation — never write the interface **and** the schema by hand | both for one name in one file            | **6 files**: the four `daemon/src/lib/session/*/settings.ts`, `session/resume/types.ts`, `pwa/lib/account-picker-catalog.ts`                                                              |
| Validation — parse-don't-validate at boundaries                   | zod at raw-input boundaries in the PWA   | **12 hand-rolled parsers.** The largest single drift; §3.2                                                                                                                                |
| Functional — railway over throwing                                | `throw new`                              | 165 (daemon 89, cli 38, pwa 29, fleet 8, protocol 1). Needs a per-case read, not a number — the doctrine permits throwing at a terminal boundary and `ApiError` is one                    |

**Two results deserve a sentence rather than a cell, because both are doctrine questions rather than
defects — and the doctrine should answer them so nobody re-litigates them.**

- **The clock.** Every read is a default parameter, so every call site can inject one and every one is
  testable. But a default that reads the ambient clock is still an impure default, and it puts the
  impurity in the module rather than at the composition root. `docs/standards/datetime/index.md` says
  "never read the ambient clock in domain code. Take a clock as a dependency." An overridable default
  _is_ a dependency and _also_ a read. **The doctrine must say which**, explicitly. My reading: it is
  conformant, because the property the rule exists to protect — testability without freezing global
  time — is fully present. hadi asked for the position to be stated rather than assumed, and this is it.
- **The singleton.** `documentDraftStore` is the survivor of a real defect the `daemon-scope.sh`
  `invalidate` pass caught: `DaemonDraftStore` used to be a module default inside `composer.tsx`, which
  made it the one daemon-scoped store the connection registry could not reach, so unpairing left a
  daemon's drafts in `localStorage` for the next pairing that minted the same id to read back. Moving it
  here fixed that and left a documented module-level instance behind. It is in no allowlist, because
  no gate asks. **"No Singletons" has no exception clause for a framework that needs a value at module
  load** — so either the doctrine names that exception or the value moves into `createAppStore`. A
  decision either way; not something to leave implicit.

**The honest headline, and it is the answer to the owner's complaint:**

> **The doctrines are largely followed, and where they are not, the drift is concentrated in
> `packages/pwa/src/lib`.** All 9 clock defaults, the one singleton, the two largest private-member
> counts and all 12 hand-rolled parsers are there.
>
> **The patchwork the owner is complaining about is somewhere else entirely.** It is that none of the
> eight doctrine articles says anything about the failure that keeps shipping: **two programs agreeing
> about one fact.**

That the two problems live in different places is what makes the argument strong rather than weak. The
PWA's lib has style drift and **no** cross-process agreement problem — it talks to one reader. The
daemon/protocol/CLI seam has near-perfect doctrine conformance and **every** agreement failure in §1.1.
A refactor aimed only at doctrine conformance would tidy the PWA and fix none of the fourteen findings.

`docs/standards/contracts/README.md` is the closest, and it frames itself as a _list of gates_ rather
than a _principle_ — which is exactly why the principle was applied three times and then stopped. The
owner asked for an overarching framework. In this repository, doctrine is how a framework is expressed.
So the deliverable includes:

**A new doctrine article: `docs/standards/fact-ownership/index.md`**, holding R1–R5 of §4, the
soundness-vs-completeness rule, temperance's workaround diagnostic, the split-don't-over-merge
anti-rule, the input-domain rule from finding 8, and the re-test rule from §2.5.2. Linked from
`CLAUDE.md`'s doctrine table beside the other eight, because a rule that is not in the table is a rule
nobody reads.

Its worked examples should be the ones from this session where the author of a rule broke it, because a
rule with that attached is harder to wave away: temperance argued for collapsing `mayGrant`/`governed`
and supplied the diagnostic that proves they were wrong; cinthia and I made the
generalise-from-one-member error in opposite directions within an hour; and this document itself got
three things wrong (§11.1).

### 7.1 Two doctrine claims that are not true as written

Both from mika, and both change what a doctrine may honestly say.

1. **"Reachability is the proof" is true only at the coarsest granularity.** `PushService.notify` —
   the fan-out consulting each device's preferences and pruning dead endpoints — had **no production
   caller**, because `register` called the transport directly. Every gate passed: the module was
   reachable through its _other_ methods. `reachability-allowlist.txt` already records the sibling case
   (`SessionResumeService` was an uncalled factory for four units). **Three instances, three
   granularities: unreachable module, uncalled factory, uncalled method.**

   > **Built, tested, 100% covered and dead survives every gate this repository has.**

   State the limit in the doctrine, and assess whether a method-level pass is feasible. hadi calls this
   the single most important item in their message and I agree.

2. **"Check the wire, not the schema" needs a second clause.** `packages/pwa` has no service worker, so
   push cannot be dialled in a real browser even with the routes live. A gate that proves two ends
   agree cannot prove the client is capable of the call. §4.2.

### 7.2 The toolchain finding — explicitly not mine to fix

`git commit` printed `Passed` for all fourteen hooks and created nothing: pre-commit is installed in
migration mode against the shared `.git`. **A green hook run is not evidence that a commit happened**,
and the workaround everybody reaches for is `--no-verify`, which makes CI the only real gate. The fix is
a one-line `pre-commit install -f` against a repository a dozen live agents are committing into. hadi
is putting it to the owner. I am not touching it, and I note it here only because it affects how any
conformance claim in this refactor should be believed.

---

## 8. Deletions

A cleanup that only adds has failed. Everything below stops existing.

| deleted                                                                        | where                                                                                                 | replaced by                                           |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| the inline loopback check                                                      | `mounts/session-attach.ts:45` and its bespoke `attach_not_local`                                      | `privilegedOnly: true` on the route                   |
| `RouteScope` and the `scope` field                                             | `api/route.ts`, 109 route declarations                                                                | `minimum` + `privilegedOnly`                          |
| four loopback predicates                                                       | `bun-api-server.ts:92`, `relay/connection.ts:52`, `pwa/hosted-relay.ts:121`, `protocol/address.ts:18` | `isLoopbackHost` / `isLoopbackPeer` in the protocol   |
| the "TypeScript does not catch it" comment                                     | `runtime/config.ts`                                                                                   | the `satisfies` mapped type, which does               |
| `publicUrl ?? bindUrl` at three sites                                          | `config.ts:315`, `:343`, `:397`                                                                       | `decideAdvertisement`                                 |
| the unvalidated client derivation                                              | `protocol/address.ts:60` `recordedDaemonAddress`                                                      | the same decision, one owner                          |
| twelve hand-rolled parsers, twelve `browserStorage()` copies, ~9 store classes | `pwa/src/lib/*`                                                                                       | one `BrowserDocument<T>`                              |
| the implicit 8-row ↔ 12-module mapping                                         | `settings-catalog.ts` + storage modules                                                               | catalog rows owning their document                    |
| the merge conflict and one of two contradictory paragraphs                     | `docs/grants.md`                                                                                      | #300, folded in                                       |
| "the ten workspace/CLI/release contracts"                                      | `docs/standards/contracts/README.md`                                                                  | the real count, gated                                 |
| the singular `relay` block and `host`/`port` top-level keys                    | `config.ts`                                                                                           | `carriers`                                            |
| "an operator edits `config/daemon.json` today"                                 | `docs/relay-protocol.md` §13                                                                          | `fy daemon carrier add \| ls \| rm`                   |
| three hardcoded counts                                                         | `provenance.test.ts` capability lists, `pwa/harness/screenshot.ts` `!== 10`                           | derived from the enums that already exist (frederick) |

---

## 9. The migration sequence

Every step ships alone, reverts alone, and deletes something. No big-bang rewrite.

### Wave 0 — the blocker (first, before anything else)

| step   | does                                                                                                                                                                                                                                                                          | deletes                                        |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **0a** | `decideAdvertisement` in `@ferretry/protocol` + `isLoopbackHost`/`isLoopbackPeer`/`isWildcardHost` moved there from `#301`'s `config.ts`                                                                                                                                      | the four loopback copies                       |
| **0b** | the three `config.ts` derivation sites and `recordedDaemonAddress` read the one decision                                                                                                                                                                                      | `publicUrl ?? bindUrl` ×3                      |
| **0c** | the mint response carries `reach: 'any-device' \| 'local-only'` or a `refusal`; `superRefine` becomes present-iff-present; the three surfaces draw a QR, a said-so local link, or the fix — never a silent dead QR. **Do not condition on the requester's carrier (§2.5.1).** | the undialable QR                              |
| **0d** | `docs/pairing.md` states the constraint: **never mint a link without saying who can redeem it**                                                                                                                                                                               | frederick's asserted-but-undeliverable journey |

### Wave 1 — detection (no behaviour change)

**1a** fold in #300 (`docs-integrity` + the conflict resolution) · **1b** `contract-registry` and the
four undocumented contracts · **1c** `route-agreement`, allowlist seeded from `main`, with mika's
client-prerequisite limit written into the gate's own docs.

### Wave 2 — the compiler, before more gates

**2a** exhaustive key maps for `CapabilityGrantsDocumentSchema` and `NOTIFICATION_KINDS` · **2b**
generalise `unimplementedCapabilities` (R3) so an accepted-but-unhonoured schema prints itself, which
makes finding #4 visible until #302 lands.

### Wave 3 — the authorization collapse (three commits)

**3a** add `minimum` + `privilegedOnly` **alongside** `scope`, derive `scope` from them, and one test
asserts the derivation over the whole 109-route table — zero runtime change, trivially revertible ·
**3b** move `session-attach`'s inline check onto its route (and `/v1/grants/password`, if the owner
approves §5.3) · **3c** the dispatcher reads the new fields; **`RouteScope` is deleted.**

3a is the trick that keeps this from being patchwork: two representations coexist for exactly one
commit, with a test proving they agree, and then the old one is gone.

### Wave 4 — carriers, including multi-relay

**4a** `carriers` parsed alongside the legacy keys, normalised on read; `Arrival` documented as the
generalisation of `loopback`; N relay links instead of one · **4b** the wire field on
`PairingResponse` + `GET /v1/carriers` + the `version-skew` rule · **4c** client try-order and the
disagreement rule · **4d** `fy daemon carrier add|ls|rm`; `fy daemon grants` with `fy daemon config`
kept as an alias · **4e** remove the legacy `host`/`port`/`relay` keys.

### Wave 5 — the doctrine article and client settings

**5a** `docs/standards/fact-ownership/index.md`, linked from `CLAUDE.md`; the two doctrine limits from
§7.1 written down · **5b** `BrowserDocument<T>` + two documents migrated, deciding once what partial
damage means · **5c** the remaining ten · **5d** catalog rows own their documents + the
`settings-catalog` contract.

Wave 5b–d is the largest and least urgent. It must not block Waves 0–4.

---

## 10. Preserved invariants

If a step above appears to touch one of these, the step is wrong.

- **Carrier-derived privilege.** Never re-derived from a peer address, a `Host` header or a URL.
  `tunnelApiRequest` keeps hardcoding `loopback: false`, and the #289 policy test — which builds a
  relayed request presenting every loopback-looking signal it can — must pass **unmodified**.
- **The secret store's use-never-read contract.** No getter, no route, no report. The operator password
  verifier stays out of `config/daemon.json`.
- **Fail-closed everywhere.** `undetermined` ⇒ deny. A capability route on a guardless dispatcher ⇒
  deny. A failed refresh clears the answer rather than keeping a stale one. An unparseable document
  refuses the boot. Damaged state is never empty state.
- **Permissive defaults with the operator password as the opt-in layer.**
- **The widen/narrow asymmetry and the one-way door**, including `mayGrant` on the wire so a UI warns
  _before_ the door closes, and revoking never being harder than granting.
- **The capability list stays closed at six.** It must not grow to mirror the route table. mika's
  decision to serve push under `{ capability: 'pairing', axis: 'use' }` rather than adding a seventh is
  **correct under this model** and #302 should land as written.
- **`TokenClass`** — three values, one job, untouched.
- **Nothing derived is ever persisted.**
- **An operator's `publicUrl` is never second-guessed** — `advertisesForeignAddress` exists because a
  proxy deployment is legitimate.
- **Pairing is never relayed**, and the carrier chosen by trying rather than by a health check.
- **The two-name model, `@ferretry/protocol` as the single source, and every existing contract.**
- **Client settings stay browser-local.** No `clientSettings` in the protocol, no sync.

---

## 11. Verification, and a finding about this document

Verified against `origin/main` at **`52dc6a20`**, by content.

| claim                                          | how                                                                                                                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| the default mints a loopback pairing link      | `config.ts:315` `publicUrl: value.publicUrl ?? bindUrl`; `config.ts:219` host default; `bin/fyd.ts:3571` `daemonUrl: config.publicUrl`; `pairing/service.ts:393` embeds it in the fragment |
| no loopback check anywhere on that path        | frederick checked three renderers; I re-grepped `packages/daemon/src/lib/pairing/` for `loopback\|127.0.0.1\|unreachable` — no matches                                                     |
| four derivation sites                          | `config.ts:315`, `:343`, `:397`; `protocol/address.ts:60`                                                                                                                                  |
| five loopback predicates                       | `config.ts:19`, `bun-api-server.ts:92`, `relay/connection.ts:52`, `pwa/hosted-relay.ts:121`, `protocol/address.ts:18`                                                                      |
| `reachableOffHost` exists and counts the relay | `provenance.ts:164`, and it now takes a `RelayCarrierSource` so a discovered relay counts                                                                                                  |
| pairing publishes no carrier                   | `PairingResponseSchema` in `protocol/lib/pairing.ts`; `rg 'relayUrl\|rendezvous' packages/protocol/src/lib/*.ts` finds only a doc comment                                                  |
| the inline authorization check                 | `mounts/session-attach.ts:45`                                                                                                                                                              |
| 17 contracts run, 13 documented                | the `all` loop vs the README table, diffed with `comm`                                                                                                                                     |
| doctrine probes                                | `git ls-files "packages/*/src/lib/*" \| grep '\.ts$' \| grep -v tests` — **634 files, all six packages** — piped to `rg`; counts in §7. Do **not** use a `**` pathspec; see below          |
| both loopback domains are correct today        | temperance re-checked both: `bun-api-server.ts:92` includes the IPv4-mapped form and excludes `localhost`; `isLoopbackHost` is already named and single-sourced by #301                    |
| no `/v1/config` route                          | 109 distinct `/v1` paths in `mounts/`, none matching `config\|settings\|daemon`                                                                                                            |

### 11.1 Three ways this document was wrong, and what each one teaches

Recorded rather than quietly corrected, because the document's whole argument is that silent
disagreement is the enemy.

**1. A claim that was true and then was not.** The previous revision asserted the daemon does not read
the hosted-relay advertisement. True at `5316ae4a`, **false six hours later**: `#301` landed it,
symmetric with the PWA via `__FY_RELAY_DIRECTORY__` and pinned by `scripts/validate/relay-config.sh`.
`#301` also introduced `isLoopbackHost`, which turns §5.4 from an invention into an extension. I caught
it only because `CLAUDE.md` changed under me. hadi hit the identical thing — their first grep for
`reachableOffHost` missed it because they had not pulled.

> **A design document that cites line numbers rots at the rate the repository moves.** Cite decisions
> and file paths in the argument; keep line numbers in an appendix stamped with the SHA they were
> checked at.

**2. A measurement that was wrong because the file set was wrong.** §7 originally claimed "zero
`Date.now()` in lib" and "zero singletons". Both were artefacts of
`git ls-files "packages/*/src/lib/**/*.ts"`, which matched **479 of 634** files and silently dropped
`fleet`, `protocol`, `relay` and 76 of 84 `pwa` lib files. The truth is 9 clock reads (all injectable
defaults) and 1 documented singleton. hadi spot-checked the clock number before relaying it, it did not
hold, and re-running the corrected sweep found the singleton too.

> **A conformance claim is only as good as its stated file set.** The glob is now in the appendix so
> the next reader can reproduce the numbers instead of trusting them. And a `**` git pathspec does not
> mean what a shell glob means: `*` already crosses `/`, so `a/*/b/**/c` silently under-matches.

This one matters most, because "the patchwork is not doctrine drift" is load-bearing for the owner's
decision, and hadi was right that one wrong count in the evidence weakens an argument that deserves to
be believed. The corrected numbers do not overturn the conclusion — they sharpen it, because the drift
turns out to be concentrated in the one package with no agreement problem at all.

**3. A finding I under-counted.** I first reported `pairing` as having no route demand. It has one;
my pattern matched only inline literals and `mounts/pairing.ts` uses a named `PAIRING_DEMAND` constant.
The surviving finding is the narrower one in §5.1.

All three are the same failure the document is about, committed by the document: **a claim and the
thing it describes, with nothing checking that they agree.** Three teammates checking my work is what
caught them, which is the argument for the gates in §4 rather than against them.
