# The fleet is ready when the daemon starts

Starting the daemon is the setup. A host with Claude Code or Codex installed gets the accounts that
harness earns, published and usable, without a separate "prepare this host" step, a staged change, a
button or an approval.

This document is the contract. Implement against it rather than against the code.

## The defect it removes

A machine with Claude Code installed and a daemon running could do nothing at all. The boot resolved
`claude` on the `PATH`, said so, and then refused to launch it:

> claude and codex are on this host's PATH, but the fleet manifest publishes no account for either —
> this daemon launches the wrappers the manifest declares, never the harness command directly

Every word of that was accurate. Its effect was that a person who had installed a harness, paired a
device and started a daemon still had a setup step in front of them, and nothing had told them what it
was. That sentence is now unreachable on a host that has a harness: either the accounts exist, or the
boot says which key or which damaged file stopped them being created.

## What a detected harness earns

Four names, and no others:

    claude-default        codex-default          (interactive)
    claude-auto-default   codex-auto-default     (auto)

They are the wrapper names and the home names, because two strings that must always agree are one
string. `packages/fleet/src/lib/defaults.ts` owns them: `defaultAccountsFor()` takes the harness kinds
somebody else detected and returns the accounts, `derivedWrapperName()` is the one naming rule (the
same one a browser form uses, so `claude-auto-default` is the same kind of name as `claude-auto-work`),
and `FLEET_STARTER_MODELS` is the one starter model per harness.

**One agent per harness with two routes on it, never two agents.** The lanes share a provider login,
which is what `identity` was built for, so signing in once makes both usable. Two agents would ask a
person to do the same sign-in twice.

**Only a harness that was actually found gets accounts.** Detection is `locateHarnessCommand`'s job in
`packages/daemon/src/lib/core/harness-readiness.ts` and there is no second detector — a second one
would be a second opinion about what "installed" means, and the two would disagree the first time an
operator wrote down a path. A host with only `claude` gets exactly the two Claude accounts.

## The four instruction documents

    claude: ./CLAUDE.md   ./CLAUDE-auto.md
    codex:  ./AGENTS.md   ./AGENTS-auto.md

`DEFAULT_INSTRUCTIONS` in `defaults.ts` is read by the thing that WRITES those documents and by the
thing that POINTS accounts at them, so "configured by default" is one fact rather than two hopeful
ones.

**Four rather than one, and the count is the point.** One shared document forced two compromises:
Codex read a file whose own first paragraph told it that it was Claude's, and an unattended agent read
guidance written for one that can stop and ask a question. So each harness gets the document its own
harness names, and each lane gets its own copy of it.

The starter configuration points at them through the composition chain rather than per account:

```yaml
profiles:
  base:
    claude:
      memory: ./CLAUDE.md
    codex:
      memory: ./AGENTS.md
variants:
  auto:
    claude:
      memory: ./CLAUDE-auto.md
    codex:
      memory: ./AGENTS-auto.md
```

**Why that works** is the precedence `packages/fleet/src/lib/profiles.ts` owns and single-sources:

    base -> agent.profiles -> variant.profiles -> variant.inline -> agent.inline -> route.layer

A slot is flattened for the agent's harness _as it is applied_, so a `claude:` / `codex:` overlay wins
inside its own slot while a later slot's flat field still beats an earlier slot's overlay. The `auto`
variant slot is applied after the base profile slot, and `memory` is a scalar the last writer replaces
— so the `-auto` document wins for that lane only. The `default` variant declares no `memory`, so a
default-lane account keeps the base document. `packages/fleet/tests/unit/scaffold.test.ts` proves this
by resolving a real configuration and asserting each account's effective `memory`, not by asserting
that a file exists.

All four documents are written on every host, including one with a single harness. The configuration
points both harnesses at their own documents whatever is installed, so writing only the detected pair
would leave a live reference to a file nothing had made.

## Who decides, and what must be said out loud

Auto-creating accounts **writes executable wrappers into the user's home**. That is the exact act the
fleet's authority model exists to govern, so the argument for doing it has to be made rather than
assumed:

- It runs **on the host, at the operator's own command** — they typed the start — and this codebase's
  doctrine is that somebody at the machine already has the machine.
- It is **not a widening of what a remote caller may do.** No route reaches it. `prepareDefaults()` is
  a method on the fleet subsystem that the composition root calls and the route table does not, and
  every browser-driven change still goes through a reviewed proposal with its operator-password
  confirmation. `docs/grants.md` is untouched, and so is the requirement that a password exist before
  any device pairs.

But it **is** a real change in what starting a daemon does, so the boot says three things in text no
log level can filter (`packages/daemon/src/lib/fleet/boot-preparation.ts` owns every sentence):

1. **WHAT** was created — the wrapper names, not a count, and that this wrote files.
2. **WHERE** — the fleet directory and the bin directory, by absolute path.
3. **HOW TO NOT HAVE IT** — the exact key, and that removing the accounts themselves is an edit to
   `config.yaml` followed by an apply, because turning the key off later removes nothing.

Two more sentences are there because their absence would be a lie of omission:

- **Which accounts are signed in, by name.** A default account is seeded from this host's own harness
  login where there is one to copy (below), so this is no longer one claim about all of them: the
  disclosure names the accounts that carry a credential and the accounts that do not, and only says
  "NOT that they are signed in" about accounts for which it is true.
- **`PATH` is not a precondition.** An account is launched by the absolute path the manifest publishes,
  so a session works the moment the apply lands. The `PATH` line is for a person who wants to type
  `claude-default` in their own terminal, and it says so.

## The fleet arrives signed in

The accounts a first run creates are given **a copy of the login this host already has**. A person who
installed Claude Code, signed in, and started a daemon is not asked to sign in three more times to
accounts that were made for them.

`packages/fleet/src/lib/credential-seed.ts` owns it and
`packages/fleet/src/adapters/credential-store.ts` performs the copy.

### It is an import, not a sync

A seeded account's credential is **its own from the moment it lands**. Nothing watches the donor,
re-reads it, or repairs a copy that has since expired.

That is not a simplification, it is the only shape that works. A harness rewrites its own credential
whenever it refreshes a token, by writing a temporary file and renaming it over the old one. A
synchroniser would race that rename forever, would lose, and would lose **silently** — replacing a
token the harness had just refreshed with the one it had just replaced. For the same reason the copy is
a **copy and never a symlink**: a rename over a symlink replaces the link with a regular file, so a
linked account would quietly stop tracking anything on its first token refresh.

So the consequence is said out loud on every boot that seeds:

> Those copies are independent from the moment they land — signing your own Claude out does not sign
> them out, and signing back in does not refresh them; `fy fleet login` re-signs any account whose copy
> expires.

### Two platforms, two implementations

| harness | platform | what a seed does                                                                            |
| ------- | -------- | ------------------------------------------------------------------------------------------- |
| claude  | macOS    | reads keychain item `Claude Code-credentials[-<sha256(home)[0:8]>]` and writes the target's |
| claude  | macOS    | falls back to `<home>/.credentials.json` when the keychain holds no item for that home      |
| claude  | other    | copies `<home>/.credentials.json`, mode `0600`                                              |
| codex   | any      | copies `<home>/auth.json`, mode `0600`                                                      |

**macOS is not a file copy and a file-copy-only seed would silently do nothing there**, because Claude
Code keeps no credential file on a Mac — it keeps a keychain item whose NAME is derived from the config
directory. The seeder has no platform branch of its own; the store owns both, which is what makes
`packages/fleet/tests/integration/credential-store.test.ts` able to prove the macOS path from Linux by
scripting `security` and asserting that the DONOR's item was read and the TARGET's different item was
written. The displayed account identity (`.claude.json`'s `oauthAccount`) travels with it, so `/status`
in a seeded home names the account the credential belongs to.

**THE SUFFIX IS CONDITIONAL, AND THAT DEFECT COST THIS SEED ITS DONOR.** The harness appends
`-<sha256(home)[0:8]>` only when `CLAUDE_CONFIG_DIR` is set; a default install stores its login under
the bare name `Claude Code-credentials`. Every account this boot creates is launched by a wrapper that
exports that variable, so every fleet home is suffixed — but the donor is the operator's own
`~/.claude`, which is the one home nobody launches that way. Asking for a suffixed item there asked
for one that was never written, so a Mac that was signed in produced a fleet that was not and this
boot reported `no-donor` about a login on the same machine. `keychainServices` now offers the bare
name **only for that default home**: offering it for a fleet home would let an account with no
credential of its own read the operator's login, report itself signed in, and then donate it to its
siblings. The harness's darwin store is likewise keychain-**with-plaintext-fallback**, so a home whose
keychain write once failed is read from its file rather than reported `missing`; a keychain that could
not be READ still stays `unreadable`, because answering an unknown from a file beside it is exactly
what `unreadable` exists to prevent.

### What it will not overwrite

Only a **`missing`** credential is seeded, and `missing` means positively absent or positively dead.

`unreadable` is a separate state and it is load-bearing here exactly as it is in `identity.ts`: a locked
keychain, a timed-out read and a credential written by a newer harness all produce bytes this build
cannot classify, and treating "I could not tell" as "there is nothing there" is how a working login gets
destroyed by a convenience. An account whose own credential could not be read is **refused and named**,
never written over. A donor that could not be read is reported as unreadable, never as an absence.

The **target is read first**, which also makes a re-run cheap: a host that has already been seeded asks
its donor nothing at all, so a second start raises no keychain prompt for a copy it was never going to
make. One donor is read **once per harness** however many accounts share it.

### What it says, per account

Four endings and each is a different thing to do next:

| Ending           | What the boot says                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------- |
| seeded           | which accounts, which harness's login, and the absolute directory it was read from        |
| kept             | nothing — it already had one, and this is an import                                       |
| no donor         | the harness, the directory that was read, and which accounts therefore have no credential |
| refused / failed | the account and the one sentence saying why; the account is exactly as it was             |

`fleetSeedSentences` in `packages/daemon/src/lib/fleet/boot-preparation.ts` owns every sentence and is
pure. **No credential value can reach it**: it is handed verdicts, homes and reasons, and the material
never leaves the adapter that copied it. There is no accessor above the adapter layer to misuse.

### It never fails a boot, and never fails a preparation

Every ending is a value. A keychain nobody unlocked costs a start one sentence, not the fleet it had
just published — the accounts exist, are published and are runnable either way, and `fy fleet login` is
still there.

### It only ever touches what this preparation added

An account somebody else declared is theirs. Deciding which provider login one of their accounts uses is
not a boot's business, so the seed is handed exactly the accounts `preparationAdded` named and nothing
else.

### Where the donor comes from

`FleetLayout.defaultHomeDirectories` — the fleet's existing single owner of "where the bare upstream
`claude` / `codex` reads its configuration from", which is already how an account declared
`home: default` resolves. Reading it from anywhere else would be a second opinion about one directory,
and the two would disagree on the first host that moved theirs.

## The opt-out

```json
{ "fleet": { "prepareDefaults": false } }
```

In `config/daemon.json`, beside every other value `--print-config` reports. It defaults to **on**,
because that default is the feature.

**An explicit `false` is honoured on every start, including the first.** There is no "already prepared"
marker to consult, deliberately: the flag is read from the document each boot, so somebody who does not
want a daemon writing into their home writes it once and it is true from then on, rather than being
true only after the write they were trying to prevent.

## When nothing is created

`decideFleetBootPreparation` skips, and says which of these it was:

| Skip                                                  | Why it is a skip rather than a failure                                                                                                                                                       |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The operator opted out                                | They said so. Nothing else is mentioned to them.                                                                                                                                             |
| The manifest could not be **read**                    | Damage is not an empty fleet. This daemon cannot tell what is published, and declaring an account beside one that already exists — in a file it cannot parse — is worse than declaring none. |
| No harness could be located                           | There is nothing to create accounts for. Said as a warning, never a refusal: somebody may install one minutes from now.                                                                      |
| Every located harness already has a published account | The fleet exists. A published-but-unusable account counts as published: scaffolding is create-if-absent, so it would write nothing and report having helped.                                 |

A harness whose declared path resolves to nothing is **not** located, so no accounts are created for
it. An operator who named a path has told the daemon something specific, and acting on a guess there
is the silent misconfiguration `docs/harness-paths.md` exists to end.

## Preparation may only ADD, and that is asserted rather than hoped

Preparation ends in a **whole-fleet apply**, and an apply republishes the manifest from `config.yaml`
as it stands. That is correct for `fy fleet apply`, which somebody typed. It is wrong for a boot, and
the wrongness was not theoretical:

> A host whose manifest published one Claude account, and whose `config.yaml` did not exist, **lost
> that account** to a preparation triggered by Codex. The apply republished the manifest from the
> configuration preparation had just written, which declared only the Codex accounts.

The general case is worse than the reproduction. An operator who had edited `config.yaml` and not yet
applied it — removed an account, renamed a wrapper, changed a model — would get those edits published
by the next daemon restart, silently, with none of the review every remote change to this fleet needs.
That is the same class of act as replacing somebody's file.

So the guarantee is stated as an assertion. Before a single byte is written:

1. The **prospective configuration** is derived from the scaffold's own value — the text it would write
   when the file is absent, or the in-place edit it would make when it is present, or the existing
   document unchanged when it declares agents already. Nothing is written to derive it.
2. A plan is built from that configuration, and the manifest **that plan would publish** is compared
   against the manifest published **now**, joined on account `id` — the only key either side promises
   never to change.
3. If any published account would be **removed**, or would come back with a different **harness,
   mode, wrapper, home, default model, model list or availability**, the whole preparation is refused.
   Nothing is written. The boot names every affected account and what would have happened to it.
4. Otherwise the scaffold runs and the provisioner is handed **that exact plan** — not a rebuilt one,
   for the same reason a reviewed proposal is applied unchanged: a second build could differ, and then
   the thing proved safe would not be the thing that happened.

A refusal is cheap and correct. The operator is told that their configuration and their published
manifest disagree, which is a fact they need anyway, and `fy fleet apply` is still there to resolve it
deliberately. `fyd` starts either way.

`preparationConflicts` and `preparationAdded` in
`packages/daemon/src/lib/fleet/boot-preparation.ts` own both halves and are pure. `preparationAdded`
returns the accounts rather than their names because two things read that join — the disclosure prints
them, and the credential seed below writes into exactly those homes.

### What it reports, and why the roster is not the report

The disclosure names **the accounts that were added**, never the whole published roster. "created 1
default account: claude-work" about an account that already existed is a false sentence about somebody's
home directory, and it was reachable: a configuration that already declares agents is never edited, so
a preparation triggered by the _other_ harness adds nothing at all. That ending has its own name —
`nothing-added` — and its own sentence, which says the configuration already declares its own agents
and names the remedy.

When the manifest holds more than the additions, the disclosure says so: the whole manifest was
rewritten and every account already on it came back unchanged. It came back unchanged because the
assertion above refuses otherwise, and saying that turns "we also rewrote your manifest" from a
discovery into a disclosure.

### An absent manifest is not a damaged one

A manifest that is genuinely **absent** publishes nothing, and nothing can be taken from nothing — so a
host with a `config.yaml` and no manifest gets it published, which is a pure addition. A manifest that
**exists and will not parse** is different in kind: this daemon cannot say what is published, so
preparation stops rather than act as though the answer were "nothing".

## It never replaces anything

Scaffolding is create-if-absent and the **kernel** decides — `writeFile` with the `wx` flag, not a
check-then-write. A host that already has a `config.yaml` keeps it byte for byte, and each of the four
instruction documents is written only where one is absent, which is what makes re-running safe after an
upgrade adds a default.

The one narrow exception is a configuration whose `agents` list is **explicitly empty**, which
`declareFirstAccountsInEmptyConfig` extends in place, preserving every surrounding comment and section.
It refuses outright anything it cannot edit safely — a non-list `agents`, a document that is not a
mapping, unparseable YAML, or an empty declaration in a shape it would have to rewrite — because a
zero-looking file is not necessarily an empty fleet.

Extending an existing document declares **only the lanes that document has variants for**. A route
names a variant and the schema refuses an undeclared one, so writing an `auto` route into a
hand-written configuration that declares only `default` would turn a valid empty fleet into a file
that no longer parses — a strictly worse outcome than the second account somebody did not get. An
absent `variants` key is the schema's own `{ default: {} }`, so the interactive lane is still
available; a `variants` value that is not a mapping yields no lane at all and is refused, because an
agent must declare at least one route.

## Failure never refuses the boot

Same doctrine as the absent-harness warning: a daemon that will not start because it could not scaffold
a convenience is strictly worse than one that starts and says what did not happen. `prepareDefaults()`
answers with a value rather than throwing — **four endings**, three of which write nothing at all:

| Ending          | What the host looks like afterwards                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `prepared`      | The additions exist and are published. Every pre-existing account came back unchanged.                                                 |
| `refused`       | Untouched. Applying would have done more than add; every affected account is named.                                                    |
| `nothing-added` | Untouched. There was no account to add, and the notice says why and what to do.                                                        |
| `failed`        | Possibly part-scaffolded. A scaffold has no undo, so what landed is named, plus the fact that running it again finishes the remainder. |

## Ordering, and the locks

The decision is computed **early**, right after the harness preflight, because it changes what is said
next: emitting the absent-harness warning a few lines before correcting it would be a boot trail that
argues with itself.

The preparation runs **after the mounts exist and before the address is bound**, so the first caller to
ask what this daemon can launch is answered by a published manifest rather than by a race. The
preflight is then read **again**, and the trail's last word about the fleet is that state rather than
the one from before the apply.

Three exclusive claims are in play and none nests inside another: the boot holds the state home's
lifetime lock, `prepareHost` takes the fleet's apply claim for the scaffold and **releases it**, and the
apply then takes the same claim for itself. Interleaving the last two would deadlock on the second
acquire, and a deadlock here hangs every start on the machine — so it is proved by a real boot in
`packages/daemon/tests/integration/runtime/boot-lifecycle.test.ts` rather than by a unit test with
fakes.

## `fy fleet init --first-account`

Unchanged as a flag, and it now declares the same accounts the boot does. `buildFleetScaffold` takes a
**set** of harnesses rather than one, and `FleetScaffoldIds` carries one identifier per
(harness × lane) — spend one id on two lanes and the manifest has two accounts it cannot tell apart.
`--first-account=claude` passes a one-element set; the bare flag still asks the host for positive
launch evidence and narrows to one harness through `defaultFleetHarness`.

## Declared gaps

- **The bare `--first-account` still picks one harness** rather than every harness it can see, so the
  CLI and the boot differ on a host that has both. The boot is the surface this feature is about.
- **A host that already declares agents cannot gain a second harness's accounts by restarting.**
  Scaffolding only extends a configuration whose `agents` list is empty, so "install Codex later,
  restart, get its accounts" works on a host this feature prepared and not on one whose `config.yaml`
  somebody wrote themselves. The boot says so and names the remedy rather than silently doing nothing.
- **A refusal names the disagreement but does not resolve it.** Preparation stays refused on every
  subsequent start until the operator runs `fy fleet apply` or edits their configuration. That is the
  intended behaviour — the alternative is a daemon that eventually publishes an unreviewed document —
  but it does mean a host in that state never gains the missing harness's accounts on its own.
- **A harness home somewhere else is not found.** The donor is `defaultHomeDirectories` — `~/.claude`
  and `~/.codex` — so an operator who moved theirs (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) gets "no usable
  login was found in `<path>`" naming the directory this daemon actually read. That is a stated miss
  rather than a silent one, and closing it means moving the fact itself, not adding a second reader.
- **A host that is not signed in still gets no credential.** Seeding copies what is there; on a machine
  whose own harness has never been logged in, `fy fleet login` is still the human step, and the boot
  names the accounts it applies to.
- **The macOS seed is not proved on a Mac.** It is proved from Linux by scripting `security` and
  asserting the exact keychain items read and written. That covers the shape of the calls and cannot
  cover a real keychain's behaviour under a locked login or an entitlement prompt.
- **`fy fleet init --first-account` does not seed.** The CLI writes the same scaffold and stops there;
  the boot is the surface this feature is about, and a second seeding path would be a second owner of
  when a credential gets copied.
- **`fyd --check` does not say whether starting would prepare a fleet.** It reports the harness
  preflight and the grant posture; the preparation posture is disclosed only at boot. A person asking
  "would this daemon start" is arguably the person who should be told.
- **A `default`-named agent per harness is not unique across harnesses.** The configuration schema does
  not require agent names to be unique and nothing keys on one alone — an identity is
  `<kind>:<identity>` — but a future consumer that keyed on the bare name would find two.
