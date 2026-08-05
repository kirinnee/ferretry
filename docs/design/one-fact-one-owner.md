---
id: one-fact-one-owner
title: One fact, one owner — configuration, capabilities and authorization as one model
---

# One fact, one owner

**Status: proposal. Nothing here is built. The owner agrees the model first.**

This answers the owner's instruction:

> relook at the WHOLE thing and make sure its all generalize, unfied and not too complicated, not
> patchwork over patchwork over patchwork.
>
> there should be a standard model/framework (daemon settings, client settings, capabilities), all
> these should be an overarching framework, and NOT patch work -- thats a big leading to bugs

He is right about the diagnosis, and the survey found more instances than the seven he noticed. He is
also right in a way that makes the fix **smaller** than a new framework: three of the four mechanisms
this needs already exist in the repository, each applied in exactly one place. The proposal is to
apply them everywhere and gate the application — not to invent an abstraction.

## The four verdicts, up front

1. **Daemon settings and capabilities are one surface, not two.** `grants` is a field of
   `config/daemon.json`. It is the only field of that document that has been given a complete
   lifecycle. The unification is to give the other nine fields the same lifecycle.
2. **Client settings are genuinely a different thing.** Different owner, different trust, no
   cross-process agreement. Forcing them into the daemon model would be a false unification. What they
   share with it is a _mechanism_, currently written out by hand twelve times.
3. **Authorization is not three layers. It is two layers and a category error.** `RouteScope` welds
   _credential class_ to _arrival privilege_ into one total order. No total order over two independent
   axes can express what #295 needed, which is why a route had to be moved between tiers. Split them
   and there are two layers with clean authorship: the daemon's contract, and the operator's overlay.
4. **Multiple relays are not worth their cost today, and I am arguing the owner out of the list.**
   hadi's correction is decisive and I verified it. `PairingResponseSchema`
   (`packages/protocol/src/lib/pairing.ts:57`) carries `deviceToken`, `daemonId`, `daemonName` and
   `capabilities` — and no carrier at all. Nothing in `packages/protocol/src/lib/` publishes a relay
   address to a client. Both ends must independently pick the same rendezvous, so a daemon on relay A
   and a browser discovering relay B never meet. Multi-relay needs a new wire field, a client
   try-order and a defined disagreement behaviour. **But the shape should be a list from day one**, so
   that work is additive rather than a breaking change — see §4.4.

The load-bearing idea the owner and hadi both reached for survives, in its sharpened form:
**reachability and privilege are different axes.** They are already separate in the _authorization_
code and welded in the _configuration_. That is where the fix belongs.

---

## 1. The defect, stated once

Every serious failure in the survey has the same shape:

> **One fact, two definitions, and no mechanism that can notice they disagree.**

Both halves pass their own tests, because each half owns its own fixture. The failure is always silent
and always reads as a benign empty case — no accounts, no notifications, no relay, no permission.

The repository already says this, in `docs/standards/contracts/README.md:61-74`, about the state home:
"Every one of them passed its own tests, because each writer owned its own fixture." The insight is
correct and its application stopped at three contracts.

### 1.1 The survey

The owner's seven, verified against `origin/main` by content, plus what a deliberate sweep added.
Verification method for each claim is in the appendix.

| #   | The fact                        | Definition A                              | Definition B                                                      | Status                        |
| --- | ------------------------------- | ----------------------------------------- | ----------------------------------------------------------------- | ----------------------------- |
| 1   | the fleet manifest's shape      | `@ferretry/fleet` `FleetManifestSchema`   | a second schema in `daemon/lib/core/inventory.ts`                 | **fixed** (#288)              |
| 2   | when a state home may be used   | the daemon                                | three CLI write paths                                             | **fixed** (#293)              |
| 3   | the six capabilities            | `DAEMON_CAPABILITIES`                     | `CapabilityGrantsDocumentSchema` spells all six again             | **live**                      |
| 4   | the push surface                | `protocol/lib/push.ts` + PWA enrolment    | no daemon route exists                                            | **live** (mika landing a fix) |
| 5   | the pairing route table         | the code                                  | my own summary of it                                              | **live** (no gate)            |
| 6   | the hosted relay's address      | PWA reads a runtime advertisement         | daemon needs an operator to hand-type the same string             | **live**                      |
| 7   | "may this caller do this thing" | `RouteScope`                              | `TokenClass`, `CapabilityGrants`, **and an inline handler check** | **live**                      |
| 8   | **the set of client settings**  | `SETTINGS_DEFINITIONS` (8 rows)           | 12 independent `localStorage` modules                             | **live**                      |
| 9   | **the notification kinds**      | `PushNotificationKindSchema` (protocol)   | `NOTIFICATION_KINDS` in the PWA                                   | **live**                      |
| 10  | **the contract registry**       | the `all` loop in `cli-contracts.sh` (17) | the table in `docs/standards/contracts/README.md` (13)            | **live**                      |
| 11  | **the grants doctrine**         | `docs/grants.md` §"LOCALITY is the layer" | `docs/grants.md` §"the password is the layer" — same file         | **live, corrupt**             |
| 12  | **the word "capability"**       | 6 governed capabilities                   | `['daemon-api']` in pairing; unimplemented config keys in fleet   | **live**                      |

#### 1.2 The one that should end the argument

`docs/grants.md` **on `origin/main` right now** contains an unresolved merge conflict. Not a stale
paragraph — the markers are in the file:

- line 1 is a table row fused onto the `# Capability grants` heading, so the document has no H1;
- line 59 is `<<<<<<< HEAD`, line 66 is `=======`;
- line 143 is `> > > > > > > 141154ed (feat(pwa): add a device to one daemon from the browser)`.

That third line is the part worth pausing on. `treefmt` reformatted `>>>>>>> 141154ed` into a **valid
Markdown blockquote**, and every gate in the repository passed it. The result is that the document
defining the authorization model carries two contradictory claims two lines apart:

```
## Permissive by default; the password is the layer          ← line 137 (heading)
...
**The primary security layer is locality, not the password.** ← line 145
```

A doctrine document that contradicts itself is the same failure mode as two enumerations, and it is
worse, because it is what the next teammate reads before they write code. mika is resolving it in the
push PR. **The repair is not the fix. The absence of any gate over `docs/` is the fix.**

#### 1.3 The one that shows the enumeration problem is not about capabilities

`scripts/validate/cli-contracts.sh` runs 17 contracts. `docs/standards/contracts/README.md`
documents 13 and its prose says "the ten workspace/CLI/release contracts below". Undocumented:
`daemon-default-address`, `nix-packages`, `release-daemon`, `released-version`. Three validator
scripts (`pages-config.sh`, `relay-config.sh`, `typecheck.sh`) have no row in the validators table.

The registry of the mechanism that prevents enumeration drift has enumeration drift. That is not
irony; it is the strongest available evidence that this class of bug is structural rather than a
matter of care.

### 1.4 Three before/after cases, since two are already right

**#288 — the manifest. Fixed correctly, and it is the template.**

_Before:_ `daemon/lib/core/inventory.ts` declared its own manifest schema requiring an `agent` field
the provisioner never wrote. Every real manifest parsed as an empty fleet while `fy fleet ls` listed
the accounts from the same bytes.

_After:_ the daemon imports `FleetManifestSchema` from `@ferretry/fleet` and derives `agent` from
`wrapper` via `wrapperName()`. There is now nothing on disk a manifest could contradict, because the
second declaration does not exist. `FleetManifestUnreadableError` distinguishes _absent_ (legitimate)
from _present and unparseable_ (damage).

**#293 — the state home. Fixed correctly, and it is the rule.**

_Before:_ the decision "may this directory be used" lived in the daemon. Three CLI paths created
state in a home without claiming it, manufacturing exactly the arrangement the daemon refuses —
permanently.

_After:_ `packages/protocol/src/lib/state-home-layout.ts` holds the **decision** (`decideLayout`), not
merely the version number. Both writers call the same pure function.
`cli-contracts.sh state-home-layout-claim` forbids either package from spelling the marker filename.

The comment in that file is the rule this document generalises:

> So the DECISION lives here, not merely the version number. A client that wrote the marker under its
> own rule would be free to adopt a directory that is genuinely somebody else's.

**#3 — the capabilities. Live, and the compiler can fix it.**

_Before (today):_ `DAEMON_CAPABILITIES` is the source. `CapabilityGrantsSchema` and `GrantsPatchSchema`
derive from it — correctly, with `Object.fromEntries(DAEMON_CAPABILITIES.map(…))`. But
`CapabilityGrantsDocumentSchema` in `daemon/src/lib/runtime/config.ts:188-202` spells all six keys
out, and its own comment admits the consequence:

> a capability missing from this object is refused when an operator writes it AND absent from what
> `readGrants` returns, while `CapabilityGrants` says it is there. TypeScript does not catch the
> second — a strict object widens on the way out.

A teammate hit exactly this. **The comment is right that `strictObject` does not catch it and wrong
that TypeScript cannot.** `satisfies` over a mapped type does:

```ts
// Every capability must have a key here, and the compiler says so. The literal keys are kept, so
// the parsed type stays exact — which was the whole reason for spelling them out.
const CAPABILITY_GRANT_FIELDS = {
  fleet: grantSchemaFor('fleet'),
  terminal: grantSchemaFor('terminal'),
  browser: grantSchemaFor('browser'),
  filesystem: grantSchemaFor('filesystem'),
  warden: grantSchemaFor('warden'),
  pairing: grantSchemaFor('pairing'),
} as const satisfies { readonly [K in DaemonCapability]: ReturnType<typeof grantSchemaFor> };

export const CapabilityGrantsDocumentSchema = z.strictObject(CAPABILITY_GRANT_FIELDS).prefault({});
```

_After:_ a seventh capability is a **compile error** in this file. The apologetic comment is deleted.
No gate, no shell script, no reviewer.

**The general principle this exposes** — and it is the most reusable result in the document:

> `strictObject` and `satisfies readonly T[]` prove **soundness** (no wrong member). They do not prove
> **completeness** (no missing member). Every fact in this codebase that is "a set spelled twice" is
> currently protected by a soundness check and unprotected against the failure that actually happens.

`NOTIFICATION_KINDS` in `pwa/src/lib/notification-preferences.ts:23` is the same bug wearing the same
disguise:

```ts
export const NOTIFICATION_KINDS = [
  'attention',
  'question',
  'failed',
  'completed',
] as const satisfies readonly PushNotificationKind[];
```

Add a fifth kind to `PushNotificationKindSchema` and this list stays valid and silently short — the
PWA renders four toggles for five kinds and the fifth is unconfigurable. Fix, same shape:

```ts
// A key map, so the compiler demands every kind; the array is derived, not authored.
const NOTIFICATION_KIND_ORDER = {
  attention: 0,
  question: 1,
  failed: 2,
  completed: 3,
} as const satisfies Record<PushNotificationKind, number>;
export const NOTIFICATION_KINDS = Object.keys(NOTIFICATION_KIND_ORDER).sort(
  (a, b) => NOTIFICATION_KIND_ORDER[a] - NOTIFICATION_KIND_ORDER[b],
) as readonly PushNotificationKind[];
```

**Two of the twelve findings are compiler-preventable and neither needs a gate.** Reach for the
compiler first; a shell contract is for facts that cross a boundary the compiler cannot see.

---

## 2. The three surfaces, as one model

### 2.1 What is actually there

|               | **daemon settings**                  | **capabilities (grants)**                          | **client settings**              |
| ------------- | ------------------------------------ | -------------------------------------------------- | -------------------------------- |
| where         | `<FY_HOME>/config/daemon.json`       | the `grants` key of that same file                 | ~12 `localStorage` keys          |
| owner         | the machine's operator               | the machine's operator                             | the person holding the browser   |
| schema        | `DaemonConfigDocumentSchema` (zod)   | `CapabilityGrantsDocumentSchema` (zod)             | 12 hand-rolled `typeof` parsers  |
| defaults      | per field, in the schema             | `DEFAULT_CAPABILITY_GRANTS`                        | per module, per field            |
| read path     | `DaemonConfigStore.load()`           | `GrantDocumentPort.read()` + in-memory cache       | a bespoke store class per key    |
| write path    | first boot only, plus `record(port)` | `POST /v1/grants`, `fy daemon config set`          | a setter per store               |
| provenance    | `--print-config` origin              | `CapabilityGrantView.origin`                       | none                             |
| audit         | none                                 | `state/grant-audit.jsonl` + `GET /v1/grants/audit` | none                             |
| damaged state | boot refuses                         | `undetermined` → deny, loudly                      | falls back to defaults, silently |
| scoping       | one daemon                           | one daemon                                         | 10 global, 2 per-daemon          |

Reading that table sideways is the answer.

### 2.2 Verdict: daemon settings and grants are one surface

`grants` is not a third thing. It is **one of ten fields** in `DaemonConfigDocumentSchema`, and it is
the only one that has a schema in `@ferretry/protocol`, a route, a CLI verb, an audit journal, a
provenance column, an in-memory enforcement cache and a fail-closed refresh.

The other nine — `host`, `port`, `publicUrl`, `corsOrigins`, `secretsFile`, `healthIntervalSeconds`,
`transcriptReconcileSeconds`, `usage`, `relay`, `analyticsPricing`, `projectRoots`,
`secretEnvironment` — have a schema, a first-boot writer and `--print-config`. **There is no route and
no command that changes any of them.** I checked all 109 daemon route paths: there is no `/v1/config`
of any kind. The relay documentation says so in as many words (`docs/relay-protocol.md`, §13: "A `fy`
verb to write the daemon's `relay` block — an operator edits `<state home>/config/daemon.json`
today").

And the naming has already collided: **`fy daemon config` does not configure the daemon.** It is
mounted from `packages/cli/src/lib/grants/commands.ts:28` and its description is "read and change what
a caller NOT on this host may do". Somebody typing `fy daemon config set port 7500` finds a command
with exactly that name that does something else.

So the unification for these two is not a new abstraction. It is:

> **Every field of the daemon configuration document gets the lifecycle `grants` already has, or an
> explicit written statement that it does not and why.**

That is a _contract_, satisfiable field by field, shippable incrementally, and it names the work
instead of describing it.

### 2.3 Verdict: client settings are NOT the same thing — and forcing them would be worse

The temptation is to say "settings are settings" and put a `clientSettings` object in the protocol.
Do not. Four differences are load-bearing:

1. **No second party must agree.** The defining property of daemon settings is that a _client_ and a
   _daemon_ have to read one fact the same way. A browser's text scale has exactly one reader. The
   entire reason `@ferretry/protocol` exists does not apply.
2. **The owner is different, so the authority rules invert.** The operator owns daemon settings and a
   remote caller may only narrow them. The reader owns their own theme and nothing may narrow it.
3. **The persistence is untrustworthy by nature.** `localStorage` can be absent (private mode),
   cleared without notice, or written by another tab. Daemon configuration is a file whose absence is
   a fact and whose corruption refuses a boot. "Damaged state is not empty state" is doctrine for the
   daemon and is _wrong_ for a browser preference — a cleared `fy-theme-v1` genuinely is a reader with
   no preference.
4. **Blast radius.** A wrong grant is a security event. A wrong text scale is a wrong text scale.

But the _mechanism_ is duplicated twelve times, and that is the real defect here. Every one of these
modules independently implements the same four things:

`drafts.ts` · `connections.ts` · `controls.ts` · `theme-preferences.ts` ·
`side-pane-preferences.ts` · `md-compose.ts` · `notification-preferences.ts` ·
`push-enrolment.ts` · `stt/stt-settings.ts` · `store.tsx` ·
`features/onboarding/onboarding-progress.ts` · `features/onboarding/setup-handoff.ts`

Each has: its own `fy-…-vN` key, its own `browserStorage()` with its own `try/catch`, its own
field-by-field `typeof` parser, and (for most) its own store class with `#listeners`, `snapshot()` and
`subscribe`. They do not even agree on behaviour: `parseThemePreference` falls back **per field** so
one corrupt value does not reset the others, while `parseSidePanePreferences` resets **everything** on
a version mismatch. Two answers to "what does a partially-bad document mean", in two files, neither
wrong, neither chosen.

And `zod` is already a direct dependency of `packages/pwa` — used in exactly three files
(`relay-session.ts`, `account-picker-catalog.ts`, `features/fleet/fleet-api.ts`). The repository's own
[Validation](../standards/validation/index.md) standard is parse-don't-validate with zod. Twelve
hand-rolled parsers are twelve bypasses of the house rule, in the package that has the dependency
installed.

Finally, the catalog drift (finding #8): `SETTINGS_DEFINITIONS` in
`features/settings/settings-catalog.ts` enumerates 8 user-visible settings for the page and the
command palette. The storage modules enumerate 12 documents. The mapping between them is implicit and
lives in nobody's head twice: `text-size` and `theme` are both inside `fy-theme-v1`; `density` and
`chat-width` are both inside `fy-controls-v1`; `composer-enter-key` has no storage module of its own
at all. Add a setting and forget the catalog row, and the palette cannot find it — no test fails.

**Proposal: one `BrowserDocument<T>` in `packages/pwa/src/lib`, and the catalog owns the mapping.**

```ts
// One storage port, one try/catch, one zod parse, one subscribable snapshot, one place where
// "what does a partially-bad document mean" is decided. Not shared with the daemon: the answer
// there is "refuse the boot", and it must stay different.
export class BrowserDocument<T> {
  constructor(
    readonly key: string, // the sole owner of one `fy-…-vN` key
    private readonly schema: ZodType<T>,
    private readonly fallback: () => T,
    storage: WebStorage | undefined = browserStorage(),
  ) {}
  snapshot(): T;
  subscribe(l: () => void): () => void;
  commit(next: T): T;
  adopt(raw: string | null): T;
}
```

and each setting row declares its document, so the two enumerations become one:

```ts
{ id: 'theme', label: 'Theme', document: themeDocument, keywords: [...] }
```

This is a _shared mechanism with an unshared model_, which is the honest answer the brief asked for.

### 2.4 What all three genuinely share

Not a schema. Not a reader. Not a scope. This:

> **For any effective value, a reader can ask five questions and get an answer: what is it, who chose
> it, where is it written, who may change it, and what happens when it cannot be read.**

Call it the **provenance obligation**. It is the one thing all three surfaces are the same kind of
thing with respect to, and it is exactly where they currently differ:

| obligation          | daemon settings                    | grants                                  | client settings          |
| ------------------- | ---------------------------------- | --------------------------------------- | ------------------------ |
| what is it          | `--print-config`                   | `GET /v1/grants`                        | the control renders it   |
| who chose it        | ✅ `portIsRecorded`, origin column | ✅ `origin: 'default' \| 'config file'` | ❌                       |
| where is it written | ✅ `DaemonConfigStore.path`        | ✅ `docs/grants.md` table               | ❌                       |
| who may change it   | ⚠️ nobody, via any API             | ✅ the whole grant model                | ✅ trivially, the reader |
| unreadable ⇒ what   | ✅ boot refuses                    | ✅ `undetermined`, deny                 | ❌ silent default        |

The framework the owner asked for is this table with no ✗ in it. That is a finite, checkable amount of
work, and each cell is independently shippable.

---

## 3. Where a fact is allowed to be defined

### 3.1 The rule, in four clauses

**R1 — Definition.** Any fact that two independently-deployable programs must agree on is defined
**once**, in `@ferretry/protocol`, as a **decision** — a parser or a function that answers the
question — never as a constant each side interprets under its own rule.

> This is not new. It is what made #293's fix correct rather than a relocation, and
> `state-home-layout.ts` is the worked example. The rule is only being _named_ here.

**R2 — Derivation.** A second enumeration of a protocol-owned set must be **derived** from it. Where a
literal spelling is required for type exactness, the spelling must be proved **exhaustive** by the
compiler (`as const satisfies { readonly [K in Union]: … }`), never merely proved **sound**.

**R3 — Honesty about the unhonoured.** A schema may accept a key this build does not honour, but it
must **say so out loud, mechanically**. This is not an invention either:
`packages/fleet/src/lib/capabilities.ts` already does it —
`unimplementedCapabilities(config)` compares each entry against the schema's own default and refuses
`fy fleet apply` with the list. Its docblock states the principle better than I can:

> Accepting a key is not the same as honouring it, and the difference used to be invisible — a fleet
> could be told to pool its sessions across accounts, apply cleanly, and pool nothing, with no line of
> output saying so.

**That mechanism, generalised, is the fix for findings #4 and #6.** `protocol/lib/push.ts` is a schema
the build does not honour. The `relay` block's hosted asymmetry is a capability the daemon half does
not have. Both would be one row in a list and one line of output.

**R4 — Detection.** A fact R1–R3 cannot make compiler-visible gets a contract in `scripts/validate/`,
and the contract registry is itself gated.

### 3.2 The gates, concretely

Four new contracts, ordered by value. Each follows the house pattern in
`docs/standards/contracts/README.md:199-213`: one name, one branch, derive identifiers, assert on
structure, prove it fires on a planted violation.

#### `route-agreement` — the highest-value gate in this document

**Fails when a client asks for a path the daemon does not serve, or serves it with a different verb.**

This closes finding #4 (`/v1/push/*` called by the PWA, served by nothing) and finding #5 (I told a
teammate `DELETE /v1/pair/code/:pairingId` existed because I had seen the path; it was `GET`, and there
was no revoke at all) with one mechanism.

Shape, following `daemon-scope.ts` and `composition-reachability.ts` — a real lexical pass in
TypeScript, not a grep, with comments and string bodies handled first:

1. Extract every `{ method, path, scope }` triple from `packages/daemon/src/lib/runtime/mounts/**`.
2. Extract every quoted `/v1/…` path literal, with its adjacent `method:`/verb, from
   `packages/pwa/src` and `packages/cli/src`.
3. A client path matches when a route pattern matches it, treating a `${…}` interpolation or a path
   segment after a literal prefix as satisfying a `:param`.
4. Report both directions: a **client path with no route** is a shipped 404; a **route no client and
   no CLI reaches** is either dead or an undocumented surface, and gets an allowlist line with a
   reason.

Honest limitation, stated rather than discovered: a path assembled from a variable the pass cannot
follow demands an allowlist line rather than being assumed benign — the same fail-closed-about-itself
rule `daemon-scope.sh` already applies. Seed the allowlist from today's real gaps so it can only
shrink.

#### `docs-integrity` — the one that would have caught the live corruption

**Fails when any tracked file contains a merge conflict marker, in any of its formatted disguises.**

The `>>>>>>>` in `docs/grants.md` survived because `treefmt` turned it into a valid Markdown
blockquote. A gate that only looks for the raw form will miss the next one the same way.

```bash
# Every disguise: the raw markers, and the blockquote treefmt rewrites `>>>>>>>` into.
markers='^(<{7}|={7}|>{7})( |$)|^(> ){7}[0-9a-f]{7,}'
set +e
hits="$(git grep -nE "${markers}" -- . ':!scripts/validate/*')"
status=$?
set -e
[ "${status}" -eq 0 ] && printf '❌ merge conflict markers in tracked files:\n%s\n' "${hits}" >&2 && exit 1
[ "${status}" -gt 1 ] && echo "❌ failed to scan for conflict markers" >&2 && exit "${status}"
```

Wire it with `files: '.*'`. It is the cheapest contract in the repository and it is currently missing
while a corrupted doctrine document sits on `main`.

#### `contract-registry` — so the registry cannot drift again

**Fails when the `all` loop, the README table and the pre-commit wiring disagree.**

```
for each contract in the `all` loop:      it has a row in the README table
for each row in the README table:         it is in the `all` loop
for each scripts/validate/*.sh:           it is named in the README AND reachable from
                                          nix/pre-commit.nix or scripts/ci/*.sh
```

Today this fails on four undocumented contracts and three undocumented scripts. Fixing it is a
documentation commit; the gate is what stops the fifth.

#### `settings-catalog` — client-side, one enumeration

**Fails when a `BrowserDocument` exists that no catalog row names, or a catalog row names none.** Only
needed once §2.3 lands; before that there is nothing to hold together.

### 3.3 What we should NOT gate

A gate is not free. `docs/standards/contracts/README.md:12-14` already says it: "If an invariant fits
in one file, a type or a test is the better home for it." Two applications of that:

- **No `capability-enumeration` gate.** The `satisfies`-over-mapped-type fix in §1.4 makes it a
  compile error. A gate would be a second mechanism protecting a fact the compiler already protects.
- **No gate over what a grant _means_.** Three of the existing contracts grep doc comments, and it has
  already bitten: the word "process" in a `src/lib` doc comment fails the `arch` contract, and the
  `no-legacy-state` gate fails on the legacy daemon's name appearing in any comment under
  `packages/`. That teaches authors to delete explanations, which is the opposite of what this
  codebase needs. Prefer structural questions over lexical ones — which is what `daemon-scope.ts`
  already does deliberately.

---

## 4. The authorization model, collapsed

### 4.1 Four mechanisms today, not three

The brief named three. There are four, and the fourth is the most telling.

| mechanism           | where                         | what it answers                                    | how many values, and how used                                                                       |
| ------------------- | ----------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `TokenClass`        | `api/actor.ts:43`             | which secret authenticated                         | `admin` · `warden` · `device`                                                                       |
| `RouteScope`        | `api/route.ts:20`             | which class may reach this route                   | `public`·`warden`·`admin`·`host`; of 109 routes: ~101 `admin`, 4 `warden`, 2 `public`, **2 `host`** |
| `CapabilityGrants`  | `protocol/lib/grants.ts`      | what the operator agreed a non-local caller may do | 6 × 2; **8 of 12 axes are demanded by a route**                                                     |
| **an inline check** | `mounts/session-attach.ts:45` | is this caller on the machine                      | `if (!context.request.loopback) throw ApiError(403, …, 'attach_not_local')`                         |

That fourth row is the smell in its purest form. Locality is expressed **three different ways**:
`scope: 'host'` (which is really "admin token only"), a `capability` demand whose grant only applies
to non-loopback callers, and a bare `if` inside a handler with its own status code — invisible to the
route table, invisible to `GrantsView`, and therefore impossible for the UI to explain before somebody
clicks. `docs/grants.md` is explicit that a greyed control with nothing beside it is the dead end the
whole grant model exists to remove, and here is a route that produces exactly that.

### 4.2 The category error

`RouteScope` is a **total order over two independent axes**:

|          | credential minimum | requires privileged arrival |
| -------- | ------------------ | --------------------------- |
| `public` | none               | no                          |
| `warden` | any authenticated  | no                          |
| `admin`  | operator-class     | no                          |
| `host`   | operator-class     | **yes, by proxy**           |

`host` means "`tokenClass === 'admin'`", i.e. "the caller could read the admin token file", which is
used as a _stand-in_ for "the caller is on the machine". It is a sound stand-in today — a relayed
request always carries a device token (`tunnelApiRequest` attaches one and nothing else), so the two
answers coincide. But it is still a proxy, and the proxy has already produced one wrong answer:

> `POST /v1/pair/code` used to be `host`-scoped … So the UI could not add a second device even while
> running _on_ the machine, and "add a device" had no home outside a terminal.
> — `docs/grants.md`, on the #295 change

That is not a mis-tiering. **No total order over two independent axes can express "operator
credential, any arrival", which is what the pairing UI needed.** The tier had to be abandoned because
the type was wrong, and a `capability` demand was recruited to carry the locality half.

Meanwhile the _real_ locality signal already exists and is already correct:
`ApiRequest.loopback`, carrier-derived — set from the socket's real remote address by
`toApiRequest` (`adapters/api/bun-api-server.ts:398`, against `LOOPBACK = {'127.0.0.1','::1','::ffff:127.0.0.1'}`)
and hard-coded to `false` by `tunnelApiRequest` (`lib/relay/tunnel.ts`). This is the part of the design
that is unambiguously right and must survive untouched.

### 4.3 The proposal: three questions, no tiers

Every request is authorized by a triple. Each element answers a question no other element can, and
each has exactly one authority:

| element        | question                                       | decided by                    | forgeable |
| -------------- | ---------------------------------------------- | ----------------------------- | --------- |
| **arrival**    | how did this get here, and is that privileged? | the carrier that accepted it  | no        |
| **credential** | who is asking, with what class of authority?   | the token registry            | no        |
| **demand**     | what is this route asking to do?               | the route, declared beside it | n/a       |

A route declares two independent facts instead of one tier:

```ts
export interface ScopedRoute extends RoutePattern {
  /** The least authority a credential must carry. Replaces the ordering half of RouteScope. */
  readonly minimum: 'none' | 'authenticated' | 'operator';
  /** Set when this route may only be served to a privileged arrival. Replaces `scope: 'host'` AND
   *  every inline loopback check. Declared, so a UI can be TOLD before somebody clicks. */
  readonly privilegedOnly?: true;
  /** Unchanged: what the OPERATOR must additionally have agreed to. */
  readonly capability?: CapabilityDemand;
}
```

and one rule composes them, replacing all four mechanisms:

```
serve iff
      credential.class satisfies route.minimum
  and (route.privilegedOnly !== true or arrival.privileged)
  and (arrival.privileged or grantsAllow(route.capability))
```

**What collapses:**

- `RouteScope` is **deleted**. `public` → `minimum: 'none'`. `warden` → `minimum: 'authenticated'`.
  `admin` → `minimum: 'operator'`. `host` → `minimum: 'operator', privilegedOnly: true`. Four values
  become two orthogonal fields, and the pair that could not be expressed —
  `minimum: 'operator'` with no privilege requirement — is now expressible, which is precisely what
  #295 needed.
- The inline check in `session-attach.ts` is **deleted** and becomes `privilegedOnly: true` on its
  route. This is the only behaviour-visible consequence: the refusal moves from a bespoke
  `attach_not_local` to the boundary's own answer, and the route becomes visible to any surface that
  reads the route table.
- `TokenClass` is **unchanged**. It owns one thing exclusively — which secret authenticated — and
  nothing else can answer it.
- `CapabilityGrants` is **unchanged in meaning**. It owns one thing exclusively: what the **operator**
  decided, as distinct from what a **developer** decided. Merging an operator's decision into a
  developer's would be the false unification here, and I am declining it explicitly.

So the answer to "collapse three layers or justify three" is neither: **it is two layers plus a
category error plus an undeclared fourth mechanism.** Fix the type, delete the inline check, and there
are two layers with clean authorship.

**Deliberately declared behaviour change, for the owner to approve.** `POST /v1/grants/password`
becomes `minimum: 'operator', privilegedOnly: true`. Today it is `scope: 'host'`, which is
admin-token-only and _not_ loopback-only. This is not a live hole — a remote browser holds a device
token — but it becomes a stated guarantee instead of a coincidence. Say yes or no to this one
explicitly; it should not arrive as a side effect.

**The owner's law survives, and gets stronger.** `local turns things on; remote may configure or
narrow but never widen`:

- "local" becomes "arrived on a privileged carrier", which is the same boolean, differently named.
- `CapabilityGrantService.patch`'s widen refusal is untouched: it depends on the patch _content_, not
  on the route, so it stays where it is.
- Grants are consulted only when the arrival is not privileged. Unchanged.
- It gets stronger only in that `privilegedOnly` is now _declarable_, so a route that needs locality
  says so in the table rather than in a handler.

### 4.4 The carrier set — what survives, and what I am arguing against

The owner's input, via hadi:

> same daemon should be able to be exposed direct + multiple relays, no? that will allow many type of
> connection (localhost is privileged connection)

**"localhost is privileged" is not up for evaluation.** It merged in #289/#292 and is a constraint this
design preserves. Everything below is about the _set_.

#### (a) Does a carrier set subsume `RouteScope`'s `host` tier?

Yes — and §4.3 reaches the same conclusion independently, which is a good sign. `host` becomes
"requires a privileged arrival". Agreed.

#### (b) Does `loopback` become a property of the carrier? Almost — and the correction matters

**Trust is a property of the ARRIVAL, not of the carrier.** A single bound socket on `0.0.0.0` accepts
_both_ privileged and governed arrivals: `loopback: remoteAddress !== undefined && LOOPBACK.has(remoteAddress)`
is evaluated per connection. A per-_carrier_ trust level would therefore be **wrong** for the direct
carrier — it would have to be either "privileged", handing the LAN the machine, or "governed", locking
the owner out of their own laptop.

The correct generalisation is one sentence:

> **Each carrier is the sole authority for the privilege of the arrivals it accepts.** A relay carrier
> answers `false` unconditionally. A bound-socket carrier answers per connection, from the socket's
> real remote address.

This keeps hadi's non-negotiable intact **verbatim**: `tunnelApiRequest` still hard-codes
`loopback: false`, so the #289 test that builds a relayed request presenting `host: '127.0.0.1'`,
`x-forwarded-for: 127.0.0.1`, `origin: http://localhost:7432` and `?token=anything` still asserts
`loopback === false` and `governed === true`, with no change to the test or to the function under
test. The field need not even change shape — only its documentation changes from "is the peer on
loopback" to "did this arrive privileged, as the carrier decided". That is a rename-and-generalise,
not a rewrite, which is the whole point of a migration that is not itself patchwork.

#### (c) One privilege level, or several? **An honest binary. I am rejecting the gradient.**

- The only decision privilege makes is _may this caller widen_ — a one-way door, which is binary.
- LAN vs self-hosted relay vs hosted relay differ in **who might be listening** and **what the carrier
  can carry** — not in **what authority the caller has**. Authority is already answered by credential
  - grants. Modelling confidentiality as authority is how you get a fifth mechanism.
- A gradient needs an ordering and there is none. Is a self-hosted relay on a VPS more or less trusted
  than a LAN bind in a coffee shop? The question has no repo-wide answer, so any number we pick is a
  fiction some deployment contradicts. hadi is right that a false gradient is worse than an honest
  binary.

**A direct LAN arrival is GOVERNED, not privileged.** The entire justification for exempting loopback
is "somebody at the machine already has the machine", which is false of a LAN peer. This is also
already the shipped behaviour — `LOOPBACK` is three exact addresses — so it is a confirmation, not a
change.

Carriers _do_ differ, in ways that must be modelled as **capabilities, not trust**:

| carrier attribute      | what it is for                          | why it is not trust                                      |
| ---------------------- | --------------------------------------- | -------------------------------------------------------- |
| `opensInboundSocket`   | the **cost** of adding this carrier     | a bound socket is attack surface; a dialled relay is not |
| `carriesStreams`       | `/v1/events` and terminal streams (§14) | a capability the tunnel lacks, not a permission          |
| `canCarryFirstContact` | pairing needs direct first contact      | determines whether this carrier can enrol a device       |
| `observers`            | feeds `describeConnectionMethod`        | disclosure, already rendered                             |
| `privilegeOfArrivals`  | `'per-peer'` \| `'never'`               | the only one that touches authorization                  |

#### (d) Attack surface, and the safe default

Agreed with hadi's instinct: the default list is **loopback bind + the hosted relay**, with a
non-loopback bind strictly opt-in. Two additions.

**The list is not homogeneous, and the model must not pretend it is.** A relay entry is a _dial-out_;
a bind entry is a _listen_. A UI or CLI that renders them as two identical rows makes "expose more"
the easy default, which is exactly the failure hadi flagged. So the shape is a **discriminated union**,
not a list of uniform records, and the `bind` variant carries the consequence in its own name:

```jsonc
"carriers": [
  { "kind": "bind",  "host": "127.0.0.1", "port": 7431 },       // listens — attack surface
  { "kind": "relay", "url": "wss://…",    "enabled": true }     // dials out — no inbound socket
]
```

**And a real bug falls out of writing it this way.** Today `host`/`port` control _both_ what the daemon
listens on _and_, by derivation, what it advertises: `bindUrl = daemonAddress(host, port)` and
`publicUrl = value.publicUrl ?? bindUrl` (`runtime/config.ts:293-304`). So an operator following the
LAN-bind-to-pair workaround by setting `host: '0.0.0.0'` **also changes what every pairing link says**
— and `daemonAddress` returns `http://0.0.0.0:7431`, which is not an address any client can reach.
Unless they _also_ set `publicUrl`, the workaround mints unusable pairing links, and reverting `host`
silently invalidates any link minted while it was on.

That is the concrete payoff of hadi's sharpened idea, and it is worth stating plainly:

> **Reachability and privilege are not the axes that are welded. They are already separate in the
> authorization code.** What is welded is **reachability and advertisement**, in one `host` field. A
> carrier list separates them because a carrier has its own reachable address, and `publicUrl` stops
> being a derivation of "the one bind".

#### (e) Multiple relays: **not now, and the shape should still be a list**

hadi's correction is right and decisive. I verified it: `PairingResponseSchema` carries no carrier, and
`grep`ping all of `packages/protocol/src/lib/` finds no wire shape that publishes a relay address to a
client. `PairingCodeMintResponseSchema` publishes exactly one carrier — `daemonUrl`, the direct address
— and no relay. So a client discovers a rendezvous _independently_, from the build-time discovery
origin, and both ends meet only by coincidence of picking the same one.

Multi-relay therefore costs: a new wire field carrying the daemon's carrier set, a client try-order, a
defined behaviour when the two disagree, and a story for how a browser learns a _self-hosted_ relay it
was never told about. **That is more surface than redundancy is worth today**, when the single hosted
relay does not yet carry live updates or terminal streams and the daemon cannot even find it
automatically (finding #6). Redundancy does not "fall out"; I am recording it as a cost, and
recommending against building it now.

What I _do_ recommend: **ship the list shape with a bounded length, and populate it with at most one
relay.** A `carriers` array whose relay entries are capped at one today is a schema that grows without
a breaking change; a singular `relay` block is one that cannot. The cost of the list shape is a
`superRefine` and a sentence; the cost of getting there later from a singular block is a config
migration on every installed machine.

#### (f) So how much of the carrier idea is worth building?

Ranked, and the top item carries most of the value:

1. **Separate advertisement from bind** — fixes the `0.0.0.0` pairing-link bug and makes a LAN carrier
   something you _enable_ rather than a field edit you must remember to revert. **Build this.**
2. **`Arrival`, replacing `loopback`'s documentation** — makes "each carrier decides the privilege of
   its own arrivals" the stated rule. Nearly free; the code already behaves this way. **Build this.**
3. **`carriers` as a bounded discriminated union in the config document**, legacy keys normalised into
   it. **Build this**, one relay entry maximum.
4. **The daemon reads the hosted advertisement** (finding #6) — the missing half of an existing
   contract, and the thing that makes "direct + hosted relay" a default rather than a manual step.
   **Build this.**
5. **Multiple simultaneous relays.** **Do not build.** Costed above; revisit when the wire carries a
   carrier set for its own reasons.

---

## 5. Migration

Sequenced so every step ships alone, reverts alone, and deletes something. Nothing here is a rewrite.

### Wave A — detection first (no behaviour change, immediate value)

| step   | does                                                                                 | deletes                                                                                                   |
| ------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| **A1** | `docs-integrity` contract; repair `docs/grants.md`                                   | the merge conflict, the fused H1, and **one of the two contradictory paragraphs** — the owner picks which |
| **A2** | `contract-registry` contract; document the 4 missing contracts and 3 missing scripts | the "ten workspace/CLI/release contracts" sentence                                                        |
| **A3** | `route-agreement` contract, allowlist seeded from today's gaps                       | nothing yet — it _reports_ #4 and #5 rather than fixing them                                              |

A1 is a one-hour change that closes a live corruption on `main`. It goes first.

### Wave B — the compiler, before any more gates

| step   | does                                                                                                                                     | deletes                                                                                                              |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **B1** | exhaustive key maps for `CapabilityGrantsDocumentSchema` and `NOTIFICATION_KINDS`                                                        | the four-line comment at `runtime/config.ts:196-199` admitting TypeScript does not catch it                          |
| **B2** | generalise `unimplementedCapabilities` (R3): one list per package of "accepted, not honoured", surfaced by `fyd --check` and `fy doctor` | the silent gap between `protocol/lib/push.ts` and no push mount — it becomes a printed line until mika's routes land |

### Wave C — the authorization collapse (three commits, behaviour-preserving)

| step   | does                                                                                                                                                              | deletes                                                                                                       |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **C1** | add `minimum` + `privilegedOnly` to `ScopedRoute` **alongside** `scope`; derive `scope` from them; one test asserts the derivation over the whole 109-route table | nothing — this commit changes no runtime behaviour and is trivially revertible                                |
| **C2** | move `session-attach`'s inline check onto its route as `privilegedOnly: true`                                                                                     | the `if (!context.request.loopback)` at `mounts/session-attach.ts:45` and its bespoke `attach_not_local` path |
| **C3** | switch the dispatcher to read `minimum`/`privilegedOnly`                                                                                                          | **`RouteScope` and the `scope` field, entirely**                                                              |

C1 is the whole trick: two representations coexist for exactly one commit, with a test proving they
agree, and then the old one is deleted. That is how this stops being patchwork — the old shape does not
survive the migration.

`POST /v1/grants/password` gaining `privilegedOnly: true` lands in C2 **only if the owner says yes**.

### Wave D — carriers

| step   | does                                                                                                                                                                                                    | deletes                                                                                     |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **D1** | `carriers` parsed alongside `host`/`port`/`relay`, legacy normalised into it; `publicUrl` derived per carrier rather than from "the one bind"; `Arrival` documented as the generalisation of `loopback` | nothing yet                                                                                 |
| **D2** | the daemon reads the hosted advertisement through `HostedRelayAdvertisementSchema` — the same schema and discovery origin the PWA uses                                                                  | the asymmetry in finding #6                                                                 |
| **D3** | `fy daemon carrier add \| ls \| rm`; rename `fy daemon config` → `fy daemon grants`, keeping the old spelling as an alias                                                                               | the "an operator edits `config/daemon.json` today" sentence in `docs/relay-protocol.md` §13 |
| **D4** | remove the legacy `host` / `port` / `relay` top-level keys                                                                                                                                              | **the old spelling**                                                                        |

### Wave E — client settings

| step   | does                                                                                                                                                                        | deletes                                                                   |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **E1** | `BrowserDocument<T>` in `pwa/src/lib`; migrate two documents onto it (`theme-preferences`, `side-pane-preferences`) and **decide once** what a partially-bad document means | two hand-rolled parsers, two `browserStorage()` copies, two store classes |
| **E2** | migrate the remaining ten                                                                                                                                                   | ten more of each                                                          |
| **E3** | catalog rows own their document; `settings-catalog` contract                                                                                                                | the implicit mapping between 8 catalog rows and 12 storage keys           |

Wave E is the largest and the least urgent. It is a correctness-of-mechanism cleanup, not a bug fix,
and it should not block Waves A–D.

### 5.1 What I would NOT change, and why

Explicitly preserved. If a step above appears to touch one of these, the step is wrong.

- **Carrier-derived privilege.** Never re-derived from a peer address, a `Host` header or a URL. The
  #289 policy test must pass **unmodified**; `tunnelApiRequest` keeps its unconditional `false`.
- **The secret store's use-never-read contract.** No getter, no route, no report. Nothing in this
  document goes near it, and the operator password verifier stays out of `config/daemon.json` for the
  same reason.
- **Fail-closed doctrine.** `undetermined` ⇒ deny. A route naming a capability served by a guardless
  dispatcher ⇒ deny. A refresh that fails clears the answer rather than keeping a stale one. A
  document that cannot be parsed refuses the boot. Damaged state is never empty state.
- **Permissive defaults with the operator password as an opt-in layer.** The product's principle is
  that a person does as much as possible from the UI. Nothing here starts anybody behind a wall.
- **The widen/narrow asymmetry and the one-way door**, including `mayGrant` on the wire so a UI warns
  _before_ the door closes, and revoking never being harder than granting.
- **The capability list closed at six.** It must not grow to mirror the route table; a second copy of
  the route table is how the two stop agreeing. mika's decision to serve push under
  `{ capability: 'pairing', axis: 'use' }` rather than adding a seventh is **correct under this model**
  and should land as written.
- **`TokenClass`.** Three values, one job, untouched.
- **Nothing derived is ever persisted** (`runtime/config.ts:204-215`). The `carriers` work must respect
  this: a normalised legacy document is derived on read, not written back.
- **The two-name model, `@ferretry/protocol` as the single source, and every existing contract.**
- **Client settings staying browser-local.** No `clientSettings` object in the protocol. No sync.

### 5.2 What this does not fix

Stated so it is not discovered:

- Finding #12 — "capability" meaning three unrelated things (`DAEMON_CAPABILITIES`; pairing's
  `['daemon-api']`; fleet's unhonoured-config list) is a ubiquitous-language problem. Renaming two of
  them is cheap and touches a lot of files; I have not sequenced it and would do it opportunistically,
  not as a wave.
- The four grant axes with no host-changing route (`terminal`/`browser`/`filesystem`/`pairing`
  `configure`) are already a **declared GAP** in `docs/grants.md`. This model does not close them and
  does not need to — but it does suggest the axis is not uniformly meaningful, which is worth revisiting
  when the fifth subsystem grows a host setting.
- Relay streams and first-contact-over-relay are §13 gaps and stay gaps.

---

## Appendix — how each claim was verified

Every claim was checked against `origin/main` **by content**, not by SHA, and not from a summary.

| claim                                          | verification                                                                                                                                                                                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docs/grants.md` carries live conflict markers | `git show origin/main:docs/grants.md \| grep -n '^<<<<<<<\|^======='` → lines 59, 66; `grep -n '^> > > > > > >'` → line 143                                                                                                                            |
| the `>>>>>>>` became a blockquote              | line 143 reads `> > > > > > > 141154ed (feat(pwa): add a device to one daemon from the browser)`                                                                                                                                                       |
| the doc contradicts itself                     | heading at 137 vs bold claim at 145, same file                                                                                                                                                                                                         |
| no `/v1/config` route exists                   | `rg -o "path: '/v1/(config\|settings\|daemon)[^']*'" packages/daemon/src/lib/runtime/mounts/` → no matches; 109 distinct `/v1` paths total                                                                                                             |
| `fy daemon config` is grants-only              | `packages/cli/src/lib/grants/commands.ts:28`, description "read and change what a caller NOT on this host may do"                                                                                                                                      |
| the daemon serves no push route                | `git grep -l 'v1/push' origin/main -- packages/daemon` → nothing; the PWA calls `/v1/push/vapid` and `/v1/push/subscriptions` at `pwa/src/lib/push-subscriptions.ts:106,113,129`                                                                       |
| 17 contracts run, 13 documented                | the `all` loop in `cli-contracts.sh:22` vs the README table; diffed with `comm`                                                                                                                                                                        |
| `pairing` IS demanded by a route               | `PAIRING_DEMAND` at `mounts/pairing.ts:90` — my first grep missed it because it is a named constant, not an inline literal                                                                                                                             |
| 8 of 12 capability axes are demanded           | `rg -o "capability: '…', axis: '…'"` over `packages/daemon/src`, deduplicated                                                                                                                                                                          |
| an inline loopback check exists                | `mounts/session-attach.ts:45`                                                                                                                                                                                                                          |
| `loopback` is per-peer on a bound socket       | `toApiRequest` at `adapters/api/bun-api-server.ts:398`; `LOOPBACK` at `:92`                                                                                                                                                                            |
| a relayed hop is never loopback                | `tunnelApiRequest` in `lib/relay/tunnel.ts`; asserted by `tests/unit/grants/policy.test.ts:49-71`                                                                                                                                                      |
| the pairing response carries no carrier        | `PairingResponseSchema` at `protocol/lib/pairing.ts:57`; `rg 'relayUrl\|rendezvous' packages/protocol/src/lib/*.ts` finds only a doc comment                                                                                                           |
| the daemon does not read the advertisement     | `HostedRelayAdvertisementSchema` in `packages/relay/src/lib/hosted.ts:85`; read by `pwa/src/features/onboarding/hosted-relay.ts`; `DaemonRelayConfigSchema` requires an operator-supplied `url` and its docblock says there is deliberately no default |
| `publicUrl` follows `bindUrl`                  | `runtime/config.ts:293-304`; `daemonAddress` at `protocol/lib/address.ts:42` returns `http://${host}:${port}`                                                                                                                                          |
| 12 `localStorage` documents, 8 catalog rows    | `rg -l localStorage packages/pwa/src`; `SETTINGS_DEFINITIONS` in `features/settings/settings-catalog.ts:41`                                                                                                                                            |
| the PWA has zod and barely uses it             | `packages/pwa/package.json` dependency `zod 4.4.3`; `rg -c 'from .zod.' packages/pwa/src` → 3 files                                                                                                                                                    |
| `satisfies` does not prove completeness        | `NOTIFICATION_KINDS` at `pwa/src/lib/notification-preferences.ts:23`; the admission at `daemon/src/lib/runtime/config.ts:196-199`                                                                                                                      |
| "capability" has three meanings                | `protocol/lib/grants.ts:86`; `pairing/service.ts:201` (`['daemon-api']`); `packages/fleet/src/lib/capabilities.ts`                                                                                                                                     |

One correction to my own earlier reading, recorded rather than quietly dropped: I first counted
`pairing` as having no route demand at all. It has one; my grep pattern only matched inline literals
and `mounts/pairing.ts` uses a named `PAIRING_DEMAND` constant. The finding that survives is narrower
and is the one stated in §4.1.
