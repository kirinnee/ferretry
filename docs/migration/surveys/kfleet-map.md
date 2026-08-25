# Survey — what stands between us and deleting kfleet

The goal is not parity. Ferretry is **replacing** kfleet, so the bar is: _can a person stop using
kfleet without losing something they rely on?_ Compatibility is explicitly not required — no config
format to match, no command names to keep, no on-disk layout to preserve, no running kfleet to
interoperate with.

So this document is organised by **capability** — what a person uses kfleet to accomplish — not by
module. A module that exists only to serve kfleet's own file format needs no counterpart at all, and
several do. `generate` becoming `provisioning`/`plan`/`wrappers` is not a gap; nor is `merge` living
inside `profiles.ts`. Those are recorded once, in [Appendix A](#appendix-a--module-correspondence),
and never again.

**How this was established.** All 5,205 non-test lines of `~/.config/home-manager/modules/kfleet-ts/src`
were read, plus the asset tree at `~/.config/home-manager/kfleet/`. The Ferretry side was read in
full — `packages/fleet/src/**`, `packages/cli/src/lib/fleet/**`, `packages/cli/src/adapters/fleet/**`
— plus the composition root, because a module that exists but is never _called_ is not a capability.
Coverage was not consulted: **coverage cannot detect a missing feature**, and three PRs on this
migration shipped subsystems missing their core files at 100%.

Two branches that are not on `main` are named where they matter: `feat/fleet-management` (PR #231)
and `fix/harness-preflight`. The daemon's fleet routes (#237) **did** land while this was being
written, and [H](#h--keep-it-fresh) is written against them rather than against the state before.

**Revised for the fleet configuration UI.** [M](#m--change-it-without-a-shell) was added, and the
originals were re-read to settle one claim this document previously got wrong: it credited kfleet with
a dry run. It has none — the correction and the evidence are in [B](#b--materialize-it). A capability
with no original is where an invented parity claim is most likely to appear, so M states the absence
of a source counterpart before it states anything else.

---

## Scorecard

Can the owner delete kfleet today? **Yes — no blocking capabilities remain**, counted off the table
below rather than carried forward, because the running total had drifted from the rows twice. Every
former blocker is named where it closed; deliberate content and convenience GAPs remain explicit.

| #   | Capability — what a person uses kfleet for                          | Ferretry today                     | Blocks deleting kfleet?                                                            |
| --- | ------------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------- |
| A   | [Declare a fleet of accounts](#a--declare-a-fleet)                  | **Carried**, and stronger          | No                                                                                 |
| B   | [Turn that declaration into working wrappers](#b--materialize-it)   | **Carried**; init now names PATH   | **Was yes** — nothing put the wrappers on PATH; _closed by this unit_              |
| C   | [Own the assets those accounts run with](#c--own-the-assets)        | **Carried**; neutral starters ship | **Was yes**; _closed by the default-assets unit_ (content, not machinery, is left) |
| D   | [See what the fleet is](#d--see-the-fleet)                          | **Carried**, and stronger          | No                                                                                 |
| E   | [Get every account logged in](#e--get-logged-in)                    | One approval per _identity_        | **Was yes**; _closed by the identity unit_                                         |
| F   | [Know which accounts have quota left](#f--know-whos-out-of-quota)   | Real numbers, CLI **and** daemon   | **Was yes**; native Anthropic closed, other providers still GAP                    |
| G   | [Know which accounts actually work](#g--know-what-actually-works)   | **Carried**                        | No                                                                                 |
| H   | [Keep that knowledge fresh unattended](#h--keep-it-fresh)           | **Carried**                        | No                                                                                 |
| I   | [Resume any session from any account](#i--resume-anything-anywhere) | Independent pools + migration      | No; Codex prewarm remains a declared GAP                                           |
| J   | [Start from nothing on a new machine](#j--start-from-nothing)       | `fy fleet init`                    | **Was yes**; _closed by this unit_                                                 |
| K   | [Not be stopped by first-run prompts](#k--survive-the-first-run)    | Seeded in the wrapper              | **Was yes**, for automation; _closed by this unit_                                 |
| L   | [Diagnose it when it is wrong](#l--diagnose-it)                     | Nothing                            | No — annoying, not blocking                                                        |
| M   | [Change the fleet without a shell](#m--change-it-without-a-shell)   | **New**; no source counterpart     | No — neither original had it; recorded so nobody reads it as a port                |

Five facts that the capability rows assume and that are easy to miss:

1. **The daemon now gets quota from its native fleet first.** `/usage`, `/v1/usage` and `/metrics` —
   read by the advisor, quota-failover and the PWA — share `CachedUsageFeed` over the native
   `FleetUsageSource`; the older kfleet HTTP and command sources remain fallback only for an
   unapplied fleet. The source joins usage rows back to manifest wrappers, not account ids, so routing
   continues to address the executable a session can launch: [quota-two-paths.md](quota-two-paths.md).
1. **`fy fleet usage` now reports real Anthropic numbers.** `AnthropicUsageProbe`
   (`packages/fleet/src/adapters/anthropic-usage-probe.ts`) serves both `fy fleet usage` and
   `GET /v1/fleet/usage` from one implementation. Both placeholder probes are deleted. A non-Anthropic
   account still reports an honest failure rather than a number — see [F](#f--know-whos-out-of-quota).
1. **The reachability gate cannot see this package's dead capability.**
   `scripts/validate/composition-reachability.ts:22` roots a package with no `bin` at its `exports`,
   so everything under `packages/fleet`'s barrel is "reachable" by definition. `FleetLoginService`
   passed every gate for weeks while nothing called it. `groupByIdentity` was the same, and is
   now reached through `buildFleetIdentities`; `renderFleetUsageJson` and
   `renderFleetUsageMetrics` are still not called, and are now **unnecessary** rather than merely
   uncalled — see [F](#f--know-whos-out-of-quota). A green build is not evidence of absorption here.
1. **Configuration used to be accepted and silently ignored** — `sharedHistory`, `health.*`, most of
   `usage.*` parsed cleanly and reached nothing. The plan now refuses capabilities that remain
   unsupported; `sharedHistory` became accepted only after its plan, preview and apply paths landed.
1. **Two more settings were parsed and dropped after the refusal list was written.** `usage.timeout`
   reached neither composition root and `usage.enabled: false` was read as "not a request" because it
   defaults to true. Both now reach something. A refusal list only holds if every setting added after
   it is either honoured or added to it.

---

## A — Declare a fleet

**What a person does.** Writes one file describing the accounts they have, the lanes each runs in
(interactive, auto, …), and the shared profiles those compose from, so that N accounts × M lanes do
not become N×M hand-written files.

**Ferretry's answer: carried, and stronger.** `packages/fleet/src/lib/config.ts:295` is the schema and
`profiles.ts:157` the composition. The merge order is identical to kfleet's
(`base → agent.profiles → variant.profiles → variant.inline → agent.inline`, env merging, flags and
settings concatenating, other scalars replacing), including the per-slot harness-overlay flattening
that lets one cross-harness variant vary a per-harness asset.

Four things are better, and three of them are only possible because we dropped compatibility:

- **Routes are opt-in.** kfleet clones every agent across every variant, so adding a variant mints
  accounts across the whole fleet. Ferretry requires each (agent × variant) pair to be declared.
- **Identity is declared, not parsed.** kfleet recovers the base agent from a name infix, so an
  account literally named `auto-kirin` collides with `kirin` under the `auto` variant — kfleet has to
  detect that collision at generate time (`core/generate.ts:398`). Ferretry declares `id`, `wrapper`,
  `home` and `variant` separately, so account names may contain hyphens or look like an alias and
  everything still joins.
- **Availability is declared and checked.** An account that says a model is down cannot also offer
  it, and an available account must name a `defaultModel` it can actually serve.
- **One parse reports everything.** Unknown profiles and variants, duplicate ids, duplicate wrappers,
  duplicate homes and incoherent availability all surface together rather than during provisioning.

A fifth, added since: **an account route carries its own layer.** `AccountRouteSchema.layer`
(`packages/fleet/src/lib/config.ts`) is applied **last** in `resolveAccounts`, after every shared
slot, so two lanes of one agent can hold different instructions, skills, settings and environment
without either leaking onto the other. The original overrode instructions per _lane_ — every account
in that lane got the same file — and never per account. The merge order itself is unchanged; this is
one more layer at the end of it, not a new rule.

**Nothing to build in the declaration itself.** Who may _write_ that declaration, and from where, is
[M](#m--change-it-without-a-shell).

---

## B — Materialize it

**What a person does.** Runs one command and gets: an executable per account on `PATH`, a private
home per account, that account's settings/memory/skills/hooks/MCP materialized inside it, the bare
`claude`/`codex` command pointed at a nominated account, alias wrappers fanned out across the fleet,
and anything no longer declared swept away.

**Ferretry's answer: carried, and better shaped.** `fy fleet apply` builds a complete, inspectable
plan (`packages/fleet/src/lib/plan.ts:86`) and hands it to an adapter (`file-provisioner.ts:38`) that
writes atomically and refuses to write outside the roots the composition root declared. `--dry-run`
is the same code path minus the last step, so what a human reviews is the value the applier consumes.
Pruning is bounded twice — direct children of the bin directory, and only files carrying the managed
marker.

**Correction — kfleet has no dry run at all, and earlier drafts of this survey said it did.** Its
`apply` takes exactly one option, `--prune` (`cli/fleet.ts:20`), and a case-insensitive search for
`dry-run`/`dry_run`/`dryRun` over the whole source tree matches nothing. What exists is a separate
`list` verb that re-derives a summary of agents × variants from the config (`cli/fleet.ts:43`), which
is not a preview of a write and cannot disagree with an applier it never consults. So Ferretry's
preview is **net-new capability**, not a better version of an existing one — the same correction
applies to the daemon's `GET /v1/fleet/plan` and to the proposal preview in
[M](#m--change-it-without-a-shell). Nothing about the fidelity obligation changes: it is owed to the
invariants, not to a screen the original never had.

### Ordinary provisioning now rolls back, and says what the host is

kfleet's apply is non-transactional delete-then-create: an operation that throws leaves everything
before it landed and nothing recorded. Ferretry's captures undo evidence by **moving aside** rather
than copying — so a 284K `skills/` tree costs a rename, not a duplicate — validates every input
(copy sources, settings layers, the Codex sidecar) **before** disturbing any destination, and unwinds
in reverse on failure with containment re-checked at restore time, because every approval is stale by
the time a rollback runs (`packages/fleet/src/adapters/{mutation-journal,file-provisioner}.ts`).
Applies are serialised per fleet directory by a `link(2)` claim
(`packages/fleet/src/adapters/apply-lock.ts`), which kfleet had no equivalent of.

**A destination is never destroyed before its replacement exists.** kfleet's `copy` removed the
destination and only then checked the source, so a missing asset deleted the account's previous one;
here the source is `stat`ed in preflight and the live entry is moved aside, not deleted.

**Publication refuses rather than overwrites, and says so instead of being fast.** A staged regular
file is published with `link(2)` — the no-replace primitive — so a destination that reappeared between
the capture and the publish fails with `EEXIST` rather than being silently replaced. A directory has no
no-replace rename: `rename` will happily replace an empty one, taking its inode, mode and ownership
with it, and checking beforehand only narrows the window. So a staged tree is published with primitives
that are exclusive at **every level** — a non-recursive `mkdir` per directory and a `link` per file,
recursively — and any name already taken fails instead of being overwritten. A staged entry that is not
a regular file is refused rather than hard-linked into an account home on a guess.

**The accepted trade, stated because it is a real one:** the tree becomes visible **entry by entry**
rather than all at once, so it is _not_ true that a partly built tree is never observable. It is
acceptable precisely because it stays truthful — a publish that fails part-way leaves the operation
**unsealed**, and an unsealed destination is reported rather than deleted on a guess. Silently
destroying somebody's file would not be truthful at any speed.

**Ordinary provisioning ends in one of four states**, as a value rather than a message
(`packages/fleet/src/lib/provisioning.ts` `FleetApplyFailure`):

| Outcome                       | What the host is                                                                                                                                           |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| committed                     | Everything landed and the manifest is published.                                                                                                           |
| `rolled-back`                 | Nothing landed **and** nothing of anybody else's moved. Both conditions, or it is not this outcome.                                                        |
| `rollback-incomplete`         | Restoration could not be verified, or content that was not this apply's had to be set aside. Exact paths are named.                                        |
| `history-failed-after-commit` | The fleet landed, manifest included; shared history has its own boundary and failed after it. The committed state is reported exactly, never as a refusal. |

**Preparing a host is not one of those four, and must not be reported as one.** Initialization writes
starter files and **publishes no manifest** — a host that has just been prepared has a configuration
and an assets tree, and still no accounts — so reporting it as a committed apply of zero accounts would
tell a person their fleet is empty rather than that it is now ready. It carries two outcomes of its own:

| Outcome                  | What it carries                                                                                                                                    |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initialized`            | `created`, `kept` and `directories`, plus the `pathEntry` a person adds to their shell profile so the generated wrappers are runnable at all.      |
| `initialization-partial` | The same three lists as they stood, plus the `reason` and the exact `failedPath` where preparation stopped. No `pathEntry`: the host is not ready. |

Neither is a rollback, and `FleetScaffoldPartialError` carries that progress rather than discarding it:
every file preparation writes is one that was absent, so removing them again could not be told apart
from removing files somebody else had just created. Re-running completes the remainder and keeps
everything already there, because absence is the kernel's decision.

Two honest limits stay declared. **Residue is not failure**: moved-aside evidence and an
unreleasable lock claim are reported on a successful apply rather than cleaned up, because undoing a
committed apply to tidy up would delete the state the manifest now describes. And **the boundary
covers a thrown error, not a killed task** — there is no journal-backed crash recovery here and none
is claimed; a host that loses power mid-apply keeps its reserved-prefix backups and its lock claim
on disk.

Ferretry is also stricter in a way that matters: kfleet **silently dropped** an asset its per-harness
table had no destination for, so a Claude profile could declare `hooks:` and get no hooks with no
error. `unsupportedAssetFields` (`assets.ts:61`) makes that a declared refusal at plan time.

### The gap: nothing puts the wrappers on `PATH`

kfleet's bin directory is `~/.kfleet/bin`, and Home Manager put it on `PATH`. Ferretry's is
`<FY_HOME>/fleet/bin`, and **nothing anywhere puts it on `PATH`, mentions it, or checks it.**
`fy fleet apply` writes executables to a directory the shell has never heard of and reports success.

That is the smallest, sharpest blocker on this whole list: everything else about materialization
works, and the result is unreachable. _Closed by this unit_ — see [J](#j--start-from-nothing).

### Two behavioural deltas, recorded and deliberately not fixed

- **A lone settings _file_ layer is re-serialized rather than copied.** kfleet passes a single
  file-path layer through as a link or copy (`core/settings.ts:50`), so comments and formatting in a
  shared template survive. Ferretry always emits a `settings` operation when the stack is non-empty
  (`plan.ts:167`) and the provisioner parses and re-serializes it. Comments in a template are
  stripped. Worth knowing; not worth a special case, because a template whose comments matter can be
  documented in the config instead — which is what kfleet's own Codex template already tells you to
  do.
- **Alias command names differ**, and ours is the better name. kfleet's alias _replaces_ the harness
  prefix (`yolo` + `claude-auto-atomi` → `yolo-auto-atomi`), which is ambiguous the moment two
  harnesses have an account of the same name. Ferretry prepends (`yolo-claude-auto-atomi`).
  Incompatible on purpose.

---

## C — Own the assets

This is the capability the reframe asked me to size, and the answer is blunter than expected.

**What a person does.** Every account runs with _content_: a `CLAUDE.md`/`AGENTS.md` memory file, a
skills directory, a base `settings.json`/`config.toml`, hooks, an MCP server list. Some of that is
"the fleet's defaults" and some is "mine". kfleet's own asset tree is:

| Asset                            | Size    | What it is                                                           |
| -------------------------------- | ------- | -------------------------------------------------------------------- |
| `CLAUDE.md`                      | 16K     | the operator's own global instructions                               |
| `CLAUDE.auto.md`                 | 8K      | the same, for non-interactive lanes                                  |
| `skills/`, `skills-codex/`       | 284K ×2 | 14 skills each, mirrored per harness (22 files apiece)               |
| `templates/claude/settings.json` | —       | base Claude settings the fleet's profiles layer onto                 |
| `templates/codex/chatgpt.toml`   | —       | base Codex config                                                    |
| `templates/codex/hooks.json`     | —       | a Codex `PreToolUse` hook                                            |
| `statusline.zsh`                 | 12K     | a Claude status line, pointed at by an **absolute path** in settings |
| `config.yaml`                    | 12K     | the fleet declaration itself                                         |

**The finding: kfleet never owned any of this. Ferretry now owns the mechanism _and_ a neutral
default set — but none of the content that executes code.**

- kfleet's `cli/init.ts:9` copies from `path.join(import.meta.dir, '../../templates')` — a directory
  that **does not exist in the kfleet source tree**. `kfleet init` therefore logs "no templates
  bundled" and creates an empty `~/.kfleet`. Every asset above is supplied by Home Manager, which
  links the repo's `kfleet/` directory into `~/.kfleet/`. kfleet only _references_ assets by relative
  path (`deps.ts:26` `resolveAsset`).
- Ferretry's `packages/fleet/src/lib/assets.ts` is **not the asset story**. It is the per-harness
  destination table — "a declared `memory:` lands at `CLAUDE.md`, a declared `settings:` lands at
  `settings.json`". Entirely about _where a declared asset goes_; it answers nothing about _what
  assets exist_ or _where they come from_.
- **Every single-pick asset landing in a generated home is now a real symlink** — `memory`, each
  selected `skills` item, `hooks`, `hooksDir`, `mcp`. The state home's filesystem invariant still
  rejects symlink components in general; the narrow `fleet/homes` exemption was extended from
  `fleet/shared` to `fleet/assets` so that this one class of link is admitted and nothing else is. A
  source edit is therefore live: the home's file IS the asset-tree document. `settings` remains
  generated — a merge of layers cannot be a link to any of them, and each harness rewrites its own
  settings at runtime. A source outside the asset tree is still copied. `docs/fleet-sharing.md` owns
  the mechanism table; earlier drafts of this survey recorded the copy-only behaviour, which was
  accurate when written.
- `expandAssetPath` (`paths.ts:40`) resolves a relative reference against `layout.assetsDirectory`,
  which is `<FY_HOME>/fleet/assets`. So the reference mechanism is carried in full.
- **`fy fleet init` creates that directory and its `templates/` tree; `fy fleet apply` still does
  not.** `scaffold.ts:246-252` owns the directories, `plan.ts:104-106` still creates only fleet, bin
  and homes — so on a box where init never ran, a relative asset reference still resolves into a path
  nothing made.

**Replacing kfleet means Ferretry owns both halves — the defaults and the override mechanism —
because Home Manager will not be in the loop.** The owner's asset _content_ is his and stays his;
what belongs in a public repo is the mechanism plus neutral defaults. Both halves now ship.

### What `fy fleet init` ships

| Starter                    | Where it lands                          | What reads it                                                                                                         |
| -------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Neutral shared instruction | `assets/CLAUDE.md` (`scaffold.ts:151`)  | one source, both harnesses — Claude's `CLAUDE.md` and Codex's `AGENTS.md` (`assets.ts:38,46`)                         |
| Neutral Claude settings    | `assets/templates/claude/settings.json` | the base `settings` layer: `$schema` and `includeCoAuthoredBy: false`, nothing else (`scaffold.ts:166`)               |
| Policy-free Codex settings | `assets/templates/codex/config.toml`    | the base `settings` layer: comments only — model, approval, sandbox and tool policy are left open (`scaffold.ts:172`) |
| Auto-lane harness flags    | the `auto` variant in `config.yaml`     | `fy fleet apply` bakes them into the generated wrapper                                                                |

The auto-lane flags are not invented here. They are what an unattended launcher actually passes:
`--dangerously-skip-permissions` plus `--disallowed-tools=AskUserQuestion` for Claude and
`--dangerously-bypass-approvals-and-sandbox --no-alt-screen` for Codex, exactly as
`~/.config/home-manager/modules/kteam-ts/src/core.ts:1272,1281,1290` launches one (`--disallowed-tools`
is the documented alias of the `--disallowedTools` spelling used there, and the `=` keeps its
variadic value from consuming a caller's positional prompt). The one settings key that
goes with them, `skipDangerousModePermissionPrompt: true`, is set **fleet-wide** in the owner's own
`~/.config/home-manager/kfleet/templates/claude/settings.json`; here it is scoped to the `auto` lane,
because an interactive account has a human who can answer.

**Three override rules, each of them proven rather than asserted:**

- **A pre-existing file always wins.** The scaffolder creates only what is absent and reports what it
  left alone; `fy fleet init` prints `created … (Ferretry starter)` against
  `kept … (pre-existing file wins; Ferretry did not replace it)` (`render.ts:116,119`).
- **The source in the assets directory is the authority.** Path assets are copied on every apply, so
  an edited `assets/CLAUDE.md` reaches both homes on the next apply and a starter never comes back.
- **Settings layer into a real file and keep what the harness wrote.** Layers accumulate left to
  right, an account's own layer beats the shipped base file, and `preserveExisting` (`plan.ts:189`)
  keeps keys the harness persisted at runtime. The cost is the re-serialization delta recorded in
  [B](#b--materialize-it): comments in a merged template are stripped.

That is the upgrade story kfleet never had: a newer Ferretry can add a starter without touching a file
a person has edited, and refreshing a default is a deliberate delete-then-init.

`packages/fleet/tests/integration/default-assets-lifecycle.test.ts` runs the whole journey — init,
apply, launch both wrappers from an unrelated cwd, edit a starter, re-init, re-apply — and
`packages/cli/tests/sit/fleet-assets.sit.test.ts` runs init against the compiled binary, which is the
boundary kfleet's own init missed when it looked for a source-tree directory it never shipped.

**Still GAP, deliberately, and named so nobody reads silence as coverage:**

- **No skills, hooks or MCP server list is shipped.** Each one either executes code or encodes
  somebody's workflow, so shipping a default silently is worse than shipping none. The _mechanism_ is
  there — `skills` and `mcp` for Claude, `skills`, `hooks` and `hooksDir` for Codex — only content is
  missing. Two destinations genuinely do not exist: Claude has no `hooks` field and Codex no `mcp`
  one, and a declaration of either is a refusal at plan time rather than a silent drop
  (`assets.ts:61`).
- **Nothing personal ships.** The owner's 16K `CLAUDE.md`, its `CLAUDE.auto.md` lane twin, and the 14
  skills mirrored per harness carry his paths and work tooling. They stay his; he places them in the
  assets directory and declares them.
- **There is still no slot for an executable asset** (the status line). Not blocking: a script can
  live in the assets directory and be named by absolute path from `settings`, which is what kfleet
  effectively does — see the shape below.

Two shapes worth naming:

- **The status line is not an asset field in either tool.** kfleet's `settings.json` points at
  `~/.config/claude-statusline.zsh` by absolute path, and Home Manager puts the file there. Neither
  kfleet's nor Ferretry's asset table has a slot for "an executable the settings reference". Ferretry
  has a better answer available and should take it rather than porting a 267-line zsh script: the
  status line's whole job is to show model, context, account and _5-hour/weekly quota_ — which is
  exactly [F](#f--know-whos-out-of-quota), a thing the daemon will already know. See
  [Better because incompatible](#better-because-were-not-compatible).
- **The per-harness skill mirroring is an artefact of the harnesses, not of kfleet.** `skills/` and
  `skills-codex/` are two copies of the same 14 skills in two dialects. Ferretry should not inherit
  the duplication as a fact of life without asking whether one source can generate both.

_Closed as a capability._ The mechanism and the directory came with `fy fleet init`
([J](#j--start-from-nothing)); the neutral defaults, the auto-lane flags and the override rules came
with the default-assets unit above. What is left is curated _content_ — skills, hooks, MCP — which is
a content decision rather than machinery, and is recorded in [What was left](#what-was-left).

### Editing that content without a shell — bounded, and it writes nothing on its own

Neither original could edit an asset remotely; Home Manager owned the tree and kfleet only referenced
it. Ferretry now has a read boundary over `<FY_HOME>/fleet/assets` and an edit boundary that travels
inside a proposal — `packages/daemon/src/lib/fleet/assets.ts` (the pure half) and `asset-store.ts`
(the filesystem half). Its bounds are the interesting part, because "let the browser edit files" is
otherwise a filesystem API with extra steps:

- **Relative paths only**, checked rather than normalised: absolute paths, `..`, Windows separators,
  control characters, empty or whitespace-edged segments, more than 200 characters and more than 8
  directories deep are each refused with the reason. A caller that asked for
  `../../.ssh/authorized_keys` said what it wanted, and rewriting that into something harmless would
  hide the probe.
- **Regular files only, no symlink component anywhere on the path**, so the tree cannot be used as a
  hop out of itself.
- **Text is decided fatally**, by a `TextDecoder` that refuses invalid UTF-8 rather than substituting
  replacement characters — otherwise a binary file arrives looking editable and a round-trip corrupts
  it.
- **Bounded**: 64 KiB a file, 32 edits and 256 KiB in one change, 500 entries and depth 8 in a
  listing, and a listing that hit a bound says so instead of reading as the whole tree.
- **What it will not return, it still lists, with the reason.** Omitting a link, a binary or an
  over-limit file would tell a person their instructions had vanished when they are merely
  unreadable — the damaged-is-not-empty rule, applied to a file rather than to a fleet.
- **Nothing in the reader writes.** An accepted edit reaches disk through the provisioner, inside the
  same rollback boundary as the fleet it belongs to, because a saved instruction file with no account
  to copy it into is exactly the half-state that boundary exists to prevent.

The linked-asset consequence recorded above is the thing to tell a person: an edited instruction file
in the asset tree is already every account that references it, because the home's entry is that file.
Only a source outside the asset tree, and `settings`, wait for the next apply.

---

## D — See the fleet

**What a person does.** Asks what accounts exist, where each lives, what it can serve.

**Ferretry's answer: carried, and stronger.** `fy fleet ls` reads the published manifest
(`packages/fleet/src/lib/manifest.ts`) — a record kfleet did not have at all; its consumers globbed
the bin directory, so a stale executable produced a row for an account that no longer existed. PR
#231 added a read-only PWA surface on top of the same data, which kfleet had no equivalent of, and
[M](#m--change-it-without-a-shell) is what finally puts a fleet reader inside the product rather than
only in the dev harness.

**One rule that surface owes the manifest, and now honours in one place.** Zero accounts is only ever
rendered from a positively parsed manifest. A missing configuration, a configuration that will not
parse, a host that declared a fleet but never applied it, a refused credential and an unreachable
daemon are five different states with five different sentences (`classifyInventory`,
`packages/pwa/src/features/fleet/fleet-change-model.ts`) — because a person shown an empty list would
conclude their fleet had vanished, and this migration has shipped that exact bug three times.

**Nothing to build in the read model.**

---

## E — Get logged in

**What a person does.** Gets the whole fleet authenticated with the least clicking. This is the
capability kfleet is _most_ about, and its shape is worth stating exactly:

every lane of one account (`kirin`, `auto-kirin`, `f5-kirin`, …) is the **same provider account**, but
each home keeps its own credential copy — a per-directory macOS Keychain item for Claude, a per-home
`auth.json` for Codex. So kfleet groups homes into identities, reads each one's credential state,
picks the freshest as **donor**, and _clones_ it to the siblings. Only an identity with no usable
credential anywhere needs a browser approval — and even then, only after a cheap live call proves the
CLI is actually broken (`cli/login.ts:158`).

**Ferretry's answer: partial, and the missing part is the whole point.**

`fy fleet login` now exists and is mounted (this unit). It also sanitizes the caller's environment
first, which kfleet does for its probes and Ferretry did not do at all — running a login from inside
an agent session used to hand that session's `ANTHROPIC_API_KEY` to a _different_ account's wrapper.

What is missing:

| kfleet                                     | What it does                                                          | Ferretry                                                                                                  |
| ------------------------------------------ | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `core/login.ts:73` `credStatus`            | reads a home's credential, classifies `valid`/`refreshable`/`missing` | **PORTED**, and stricter — `identity.ts` `classifyCredential` adds `unreadable`                           |
| `core/login.ts:108` `scanIdentities`       | groups homes into provider identities with that state                 | **PORTED** — `identity.ts` `buildFleetIdentities` + `FleetIdentityService.survey`, over `groupByIdentity` |
| `core/login.ts:147` `pickDonor`            | the freshest credential in an identity                                | **PORTED** — `identity.ts` `pickDonor`                                                                    |
| `core/login.ts:243` `syncIdentity`         | **clones it to the siblings**                                         | **PORTED** — `identity.ts` `decideIdentity`/`FleetIdentityService.sync` + `credential-store.ts`           |
| `core/login.ts:163` `filterLiveIdentities` | prove the CLI is broken before asking a human                         | **GAP** (depends on [G](#g--know-what-actually-works)); `indeterminate` covers the unreadable case        |
| `core/login.ts:307` `resolveLoginTarget`   | raw-CLI fallback on a machine where apply has not run                 | **PORTED** — `process-login.ts` falls back to the harness CLI on `PATH`                                   |
| `cli/login.ts` `--status`                  | report state, change nothing                                          | **PORTED** — `fy fleet login --status`, rendered per identity                                             |

**Why this blocked deletion, and no longer does:** the owner's declaration produces on the order of
thirty wrappers across roughly six provider accounts. kfleet asks for ~6 browser approvals; Ferretry
asked for ~30. It now asks for one per provider account, because the credential is read, ranked and
cloned across the accounts that share it.

**Still open: driving that login from a phone rather than the daemon's terminal.** Both harnesses can
do it and neither needs a browser on the daemon's host — see
[harness-login-flows.md](harness-login-flows.md) for the mechanism per harness, with evidence.

**What was built.** A credential-store port in `packages/fleet/src/adapters/credential-store.ts`
(Keychain on macOS via `security`, `.credentials.json` on Linux, `auth.json` for Codex) behind a pure
identity/donor policy in `src/lib/identity.ts`. `identity` is declared in the config, so the grouping
half came free — kfleet had to infer it from a name infix, and misfiled a renamed wrapper.

**One state kfleet does not have: `unreadable`.** A locked keychain, a timed-out read and a home with
no credential were all `missing` there, so a report said "missing" when it did not know, a merely
unreadable sibling got **overwritten**, and an identity whose reads all failed asked for an approval
nothing needed. Here it is distinct and cannot donate, cannot be overwritten, and produces an
`indeterminate` verdict rather than "nobody is logged in".

---

## F — Know who's out of quota

**What a person does.** Asks which accounts still have capacity, so a human can pick one and
automation can route around an exhausted one. This is why kfleet's `serve` exposes `/usage` as JSON.

**Ferretry's answer: the decision half is ported well; the transport half does not exist.**

Ported, and pure, and tested:

| kfleet                                               | Ferretry                                                    |
| ---------------------------------------------------- | ----------------------------------------------------------- |
| `core/usage.ts:993` at-limit rule                    | `lib/usage.ts:140` `isAtLimit`                              |
| `core/usage.ts:466` corroborate-before-condemning    | `lib/usage.ts:153` `isCorroboratedAuthRejection`            |
| `core/usage.ts:382` "sort windows by reset horizon"  | `lib/usage.ts:112` `normalizeUsageWindows`                  |
| `core/usage.ts:444` `100 − remaining`                | `lib/usage.ts:82` `usedPercentFromRemaining`                |
| `core/usage.ts:912` aggregation, bounded concurrency | `lib/usage.ts:172` `FleetUsageCollector`                    |
| `cli/serve.ts:73` Prometheus rendering               | `api/metrics.ts` `renderUsageMetrics`, over the native feed |
| `cli/serve.ts:200` `/usage` envelope                 | `api/routes/usage.ts`, over the native feed                 |

Ferretry's collector is also stricter in the right place: a _failed_ probe can never set `atLimit`.
Only a successful reading or a proven-unavailable state can exhaust an account.

That rule caught a real false exhaustion when the real probe landed. The daemon placeholder answered
`unavailable`, which the collector correctly read as at-limit — so **every** account reported at its
limit and routing had nothing left to pick. An account whose credential cannot be read is now a
failed reading with a reason and explicitly **not** at its limit: unknown is not exhausted.

**Anthropic now produces numbers.** Both readings are ported and both are live:

| kfleet                                     | Ferretry                                                                   |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| `core/usage.ts:306` stored-OAuth probe     | `adapters/anthropic-usage-probe.ts` — `GET /api/oauth/usage`               |
| `core/usage.ts:245` external-token headers | same file — the `max_tokens:1` fallback, taken on a `403`                  |
| `core/usage.ts:142` stored-usage parse     | `lib/quota.ts` `parseStoredUsageBody` (**0..100**)                         |
| `core/usage.ts:188` header parse           | `lib/quota.ts` `parseQuotaHeaders` (**0..1**)                              |
| `core/usage.ts:824` dedup by credential    | `lib/usage.ts` `identityOf` — grouped by **declared identity**, no hashing |
| `core/creds.ts` local credential reading   | `adapters/credential-store.ts` `material`                                  |

**The 100× landmine is worse than a scale mismatch: both sources call the field `utilization`.**
`GET /api/oauth/usage` returns `five_hour.utilization` in `0..100`; the
`anthropic-ratelimit-unified-5h-utilization` header is a fraction in `0..1`. Same name, 100× apart.
They are read by two separately-named functions, and the tests feed `0.42` and `42` to both because
each value is wrong under the other's rule. A percentage reaching the header reader is **refused**
rather than clamped to 100, because clamping would look like a real reading while hiding the mix-up.

Still **GAP**, and deliberately so rather than covered thinly: Codex/ChatGPT (`core/usage.ts:333`),
z.ai (`:382`), MiniMax (`:487`), classification (`:741`), pre-probe token refresh (`:624`), donor
healing (`:885`), and secrets-file resolution (`:703`). The entire CLIProxyAPI availability source
(`core/cliproxy-usage.ts`, 308 lines) is **not to be ported**.

**The daemon now gets its quota from the native fleet collector.** `FleetUsageSource` is first in the
same cached feed that serves `/usage`, `/v1/usage` and `/metrics`; the former kfleet HTTP and command
sources are fallback only for a host whose fleet has not been applied. Its manifest join maps a usage
row onto `account.wrapper`, never `accountId`, so advisor and quota-failover routing still targets the
launchable executable. See [quota-two-paths.md](quota-two-paths.md).

`renderFleetUsageMetrics` and `renderFleetUsageJson` are therefore **unnecessary rather than uncalled**:
`/metrics` renders the same collection through `api/metrics.ts` `renderUsageMetrics`, and
`/v1/fleet/usage` returns the snapshot directly. Deleting the two is a separate, safe cleanup.

Still **GAP**: the two external sources are still wired behind the native one, so kfleet remains
_configurable_ as a fallback while a host is part-way through the migration. Removing them is
deliberately not done here — ordering matters, and a daemon whose own fleet has not been applied yet
should keep reporting quota from whatever is answering.

**CLIProxyAPI is out of scope by the owner’s decision** — it is not to be ported. Its configuration is
not silently dropped: `usage.cliProxy` is a **hard refusal** at plan time
(`capabilities.ts` `unimplementedCapabilities`), so a configuration naming a pool fails
`fy fleet apply` with the reason rather than applying and quietly reading nothing.

Note the dedup difference is not cosmetic: Ferretry's collector probes **per account**
(`usage.ts:173`), so thirty wrappers on six credentials would make thirty provider calls where kfleet
made six.

**Presentation is partial too.** `fy fleet usage` renders per-row states honestly, but `cli/usage.ts`
also has heat bars, reset-time columns, variant grouping, `--all`, `--concurrency`, `--timeout`, and
— the one that matters — `usageLimitSummary` (`:152`), which distinguishes _at-limit_, _unknown_
("no account was reported at limit; N verdicts are unknown") and _confirmed headroom_. Ferretry's
summary line collapses the last two, which is the same shape of "empty read as healthy" bug this
migration has hit three times. The per-row rendering does not hide it, so it is a summary regression
rather than a false green.

---

## G — Know what actually works

**What a person does.** Asks which accounts can complete a turn — catching bad auth, a dead proxy, a
misconfigured model. kfleet launches each wrapper with a sentinel prompt and requires exit 0 **and**
an exact-sentinel reply, so a silent failure that exits 0 still counts as down
(`core/harness-probe.ts:370`). Failures are classified (`rate_limited`, `authentication`, `timeout`,
`launch`, `process_error`, `unexpected_reply`) and successes cached for 15 minutes; failures are
never cached.

**Ferretry's answer: carried.** `FleetHealthCollector`
(`packages/fleet/src/lib/health.ts`) is the shared account-scoped collector consumed by both
`fy fleet health` and `GET /v1/fleet/health`. `ProcessFleetHealthProbe`
(`packages/fleet/src/adapters/process-health-probe.ts`) launches each wrapper with the sentinel
prompt and accepts health only for exit 0 **and** an exact `FERRETRY_HEALTH_OK` reply. A clean exit
with extra, empty, or different stdout is `unexpected_reply`, never healthy. It preserves the
source failure classifications (`rate_limited`, `authentication`, `timeout`, `launch`,
`process_error`, `unexpected_reply`), caches only a success for 15 minutes, and scopes that cache
to each daemon's `FY_HOME/fleet` directory. A skipped or unstartable probe is `unknown`; it is not
rendered as healthy or down.

**Did PR #231 reimplement this?** No, and there is no conflict — this was worth checking, because two
notions of "is Claude installed" that disagree would be worse than one.

- `feat/fleet-management` adds `defaultFleetHarness()` (`packages/pwa/src/features/fleet/fleet-model.ts:41`).
  It is a **policy over supplied evidence**, not a detector: Claude when a Claude harness has a
  non-empty `launchable` list, else Codex, else nothing. Its comment requires callers to pass only
  positively-evidenced harnesses, and `FleetReadState` makes "unavailable" distinct from "empty".
- The detection is on the sibling branch `fix/harness-preflight`:
  `packages/daemon/src/lib/core/harness-readiness.ts:38,90`. It is a **PATH resolution** — the
  manifest declares the account available _and_ this host can resolve its wrapper to an executable —
  and its comment states the limit outright: a wrapper on PATH is not signed in, in credit, or able
  to reach its provider. `renderHarnessPreflight` prints that limitation on every run.

So there is one notion of _installed_ and one notion of _alive_, they answer different questions, and
both say which one they answer. **The second is simply missing.** If it is ported, it belongs in
`packages/fleet` consumed by both, not as a third detector.

**Coordination:** `harness-readiness.ts` is the daemon unit's file and was not touched.

---

## H — Keep it fresh

**What a person does.** Wants quota and health answers to be current without running a command, and
wants that to survive a reboot. kfleet's answer is `kfleet serve` (an HTTP server on 47318 with
`/metrics`, `/usage`, `/healthz` and two cached background loops) plus `kfleet service install`,
which writes a launchd agent or a systemd `--user` unit, sources `~/.secrets` so the API-key probes
have their keys, and enables lingering.

**Ferretry's answer: carried, without a second service.**

`fy daemon install|uninstall|start|stop|restart|status|logs` is already shipped
(`packages/cli/src/lib/daemon/commands.ts`) with both launchd and systemd support
(`packages/cli/src/lib/daemon/probe.ts`). Ferretry already runs a supervised, always-on process with
an HTTP surface.

**So `kfleet serve` and `kfleet service` — 509 lines — should not be ported at all.** Nothing needs a
second service manager, a second port, or the `/bin/sh -c '. ~/.secrets; …'` trick kfleet uses to get
API keys into a launchd job; Ferretry's wrappers already declare their `$NAME` references and guard
them.

`FleetRefreshService` is mounted as `MountedSubsystems.fleetRefresh` and constructed once for the
daemon's own `FY_HOME` in `packages/daemon/bin/fyd.ts`. On boot and at the declared cadence it drives
the existing daemon-wide `CachedUsageFeed` plus `FleetSubsystem.health()`; `GET /v1/fleet/health`,
`/usage`, `/v1/usage` and `/metrics` therefore read current, shared evidence without needing a caller
to trigger collection.

There is one cadence name: the fleet declaration's `usage.interval`. `usageRefreshMs` turns it into
the same refresh period used by `CachedUsageFeed`; a daemon without a fleet declaration keeps the
five-minute default. The timer never turns a failure into a hot retry loop, and neither collector is
replaced: quota retains its last good snapshot and marks it stale; health keeps its daemon-scoped
success cache at `<FY_HOME>/fleet/health-successes.json`. The refresh service only serializes timer
ticks, so it cannot duplicate either cache or cross daemon state homes.

The native `FleetUsageSource` and `FleetHealthProbe` live in `packages/fleet`, shared by CLI and
daemon consumers. This is deliberately not `kfleet serve` or `kfleet service`: Ferretry's existing
supervised daemon already survives reboot and already owns the HTTP surface.

---

## I — Resume anything, anywhere

**What a person does.** Starts a session on one account and resumes it from another. kfleet pools
each harness's session state under `~/.kfleet/shared/<kind>` and symlinks it back into every home —
transcripts, per-session working directories, checkpoints, plans, tasks, todos, shell snapshots,
paste cache and prompt history for Claude; rollouts, archives and history for Codex. Migration is
rename-based so live sessions keep their inodes; collisions are resolved by mtime with the loser
preserved. Codex additionally gets one shared SQLite runtime directory, an ownership sidecar so
disabling sharing removes only kfleet's own key, and a `prewarm` command that reconciles pooled
rollouts into that database over app-server JSON-RPC without an LLM call.

**Ported after an explicit owner decision.** The earlier survey recommendation was superseded by
"just symlink it, please." Ferretry now keeps independent pools under
`<FY_HOME>/fleet/shared/{claude,codex}` and includes every declared account home plus each nominated
bare default home. `FleetPlan` describes those requests; `FileFleetProvisioner.preview` observes the
real disposable/home filesystem without writing; both the CLI dry-run and daemon `/v1/fleet/plan`
report every rename, link, append-only JSONL merge, emptied source directory, collision winner,
preserved loser and refused home before apply.

`lib/shared-history.ts` owns a pure collision/migration plan and a fail-closed executor;
`adapters/file-shared-history.ts` supplies canonically confined filesystem operations. Existing
history moves by rename, JSONL prompt history contributes only missing lines by appending to the
pooled inode, and collisions retain the loser under the account that actually owned it (or the
reserved `.pooled` identity for pre-existing pool state). The account JSONL inode is quarantined, so
a process that already had it open keeps writing safely there; those later lines are preserved but do
not enter the pool, which is why prompt-history migration should run while the accounts are idle. A
durable action journal plus fixed-size progress cursor, guarded reads, bounded clean rollback/replan
for live changes, explicit cross-device refusal and a daemon filesystem exemption confined to
provisioner-owned `fleet/homes/**` → same-daemon `fleet/shared/**` links keep the one-time migration
conservative.

Codex wrappers and `config.toml` point at a fresh `<pool>/sqlite` directory. An ownership sidecar
records the previous `sqlite_home`; disabling restores/removes only the exact value Ferretry owned and
preserves a user replacement. Existing per-home SQLite databases are deliberately never inspected.

**GAP — Codex prewarm.** `core/codex-prewarm.ts` and `cli/prewarm.ts` reconcile pooled rollouts into
the fresh SQLite database through `app-server --stdio` (`initialize` plus active/archived
`thread/list`, no LLM turn). Ferretry does not yet expose that command or protocol client, so migrated
rollouts may not be indexed in the fresh database until Codex performs its own reconciliation.

**GAP — operator crash recovery command.** `SharedHistoryMigration.inspectRecovery`,
`SharedHistoryRecoveryEvidence` and `SharedHistoryRecoveryRequiredError` validate and expose a stale
journal's applied, uncertain and pending actions without mutating anything. They are not exported from
the fleet barrel or mounted in the CLI/daemon yet. A `fy fleet history recover` surface must show that
evidence and replay a guarded rollback only after confirmation; until then a stale journal fails
closed with manual recovery instructions rather than being guessed away.

---

## J — Start from nothing

**What a person does.** Has a new machine and wants a working fleet.

**Ferretry's answer before this unit: nothing at all.** No `fy fleet init`. `defaultConfigPath`
(`packages/cli/src/lib/fleet/layout.ts:43`) knows where the config _should_ be and nothing creates
it, so the first `fy fleet apply` fails with `file does not exist`. The assets directory is never
created ([C](#c--own-the-assets)). The bin directory is never put on `PATH` ([B](#b--materialize-it)).

kfleet's own answer is thinner than it looks: `kfleet init` scaffolds `~/.kfleet` and `~/.kfleet/bin`
and copies templates from a directory that does not exist in its source tree — the real scaffolding
is Home Manager's.

**Closed by this unit.** `fy fleet init` creates the fleet, bin, homes and assets directories, writes
a documented starter configuration and an assets README, never overwrites anything that already
exists, and prints the `PATH` line the wrappers need. Because we are not compatible, it ships real
defaults rather than copying a directory that is not there. Details in
[What this unit closed](#what-this-unit-closed).

**And it is no longer only a shell command.** The same scaffold is reachable as an `initialize`
proposal — previewed, including the `PATH` line, before anything is written — so a person meeting a
fresh host from a phone is not stuck. One policy, two entry points: see
[M](#m--change-it-without-a-shell).

---

## K — Survive the first run

**What a person does.** Launches a freshly provisioned account non-interactively and expects a turn,
not a prompt.

kfleet bakes a 34-line shell block into every Claude wrapper (`core/generate.ts:128`) that seeds
`.claude.json` before the harness starts: `hasTrustDialogAccepted` for the working directory,
`hasCompletedOnboarding`, `hasCompletedClaudeInChromeOnboarding`, `claudeInChromeDefaultEnabled`
(seeded to `false` only when unset, so a directory where you already chose otherwise is untouched),
and pre-approval of the wrapper's own API key in `customApiKeyResponses.approved` — because Claude
Code's "detected a custom API key, use it?" dialog defaults to **No** and stalls a headless session
until somebody answers. `KIND_SPECS.claude.autotrust` is the switch; `CLAUDE_AUTOTRUST=0` disables
it. `core/firstrun.ts:17` is the jq-free TypeScript twin used by health and login on a fresh box.

**Why it blocked deletion:** a freshly provisioned Ferretry Claude account, launched the only way an
agent fleet launches anything, stopped at the folder-trust prompt and never reached a turn.

**Closed by this unit — baked into the wrapper, not written at apply time.** `renderWrapperScript`
now emits the seeding block after the exports and before `exec`
(`packages/fleet/src/lib/wrappers.ts`).

The placement is the decision, and it was made deliberately: **the state must hold at every launch,
not once at the moment a fleet was applied.** A home rebuilt, a preference reset, a harness upgrade
that reintroduces a prompt — each silently undoes an apply-time write, and the resulting failure is
total and invisible, because a session nobody is watching simply hangs at a question nobody can see.
A line in the wrapper re-asserts on every invocation and cannot drift. An apply-time write would have
had the nicer property of showing up in `--dry-run`; it would also have been a thing that was true
once. Prefer the thing that keeps being true.

Four departures from kfleet's version, all because the shape allowed it:

- **The value reaches `jq` through the environment (`$ENV`), never `--arg`**, so a fragment of a
  provider key cannot appear in a process listing.
- **The temporary file is created beside its destination**, so the rename is atomic and arrives at
  `0600` from `mktemp` itself. kfleet's shell path used `mktemp` in `TMPDIR` and moved across
  filesystems, which is a copy, not a rename.
- **A missing `jq` says so on stderr** instead of skipping in silence. A launch that may stall for a
  reason nobody was told about is the exact failure this exists to prevent.
- **The toggle is `FY_SEED_FIRST_RUN`**, not `CLAUDE_AUTOTRUST`. We are not compatible, and the name
  should say which product owns the behaviour.

There is no counterpart to `core/firstrun.ts` — kfleet needed a jq-free TypeScript twin because its
health probe and login spawn harnesses _outside_ a wrapper. Ferretry's login goes through the
wrapper, so the wrapper's own block covers it. If a liveness probe ([G](#g--know-what-actually-works))
ever spawns a harness directly, it will need one too.

Every branch is proven by execution rather than by inspection:
`packages/fleet/tests/integration/wrapper-first-run.test.ts` runs the generated script with a real
`sh`, a real `jq`, a disposable home and a stand-in harness — a quoting mistake in a generated
launcher is the kind of defect that otherwise only appears on somebody else's machine.

---

## L — Diagnose it

**What a person does.** Runs one command when something is wrong. `kfleet doctor` (45 lines) checks
that `~/.kfleet` exists, that its bin directory is on `PATH`, that the config parses, and that each
declared harness binary is on `PATH`.

**Ferretry's answer: nothing**, and after [J](#j--start-from-nothing) the most useful half — is the
bin directory on `PATH`? — is at least _printed_ at init.

A Ferretry `fy fleet doctor` should deliberately **not** re-check harness presence: that is
`fix/harness-preflight`'s question, answered daemon-side, and a second detector is exactly what this
migration keeps being warned about. What only the CLI knows is worth checking: the fleet directory,
the `PATH` entry, whether the config parses, whether a manifest exists, and whether the manifest
still matches the configuration.

Not a blocker: everything it reports can be discovered another way.

---

## M — Change it without a shell

**This capability has no source counterpart, and the row exists so that nobody later reads it as a
port.** It is recorded here because the owner named it — _"where can I configure my fleet on the UI?
it should be part of the UI right?"_ — and because a capability with no original is the one most
likely to acquire an invented fidelity claim.

**What the originals actually do.** Verified by reading them, not inferred from this survey:

- `kfleet` has **no create verb, no edit verb, no mutation API and no dry run**. Its whole command
  list is `init apply list prune login doctor health usage prewarm serve service` (`src/index.ts`),
  `apply` takes only `--prune`, and `init` prints _"next: edit config.yaml, then run kfleet apply"_.
  The flow is: hand-edit `~/.kfleet/config.yaml`, then apply.
- `kfleet serve` is not a control plane. It is Prometheus metrics plus a usage JSON envelope
  (`cli/serve.ts`) — see [H](#h--keep-it-fresh).
- The session daemon **reads** the fleet and deliberately never writes it. `fleet-inventory.ts`
  `listWrappers()` scans the bin directory, and the learning path writes a **patch file for a human
  to paste by hand** rather than editing the fleet itself (`kteam-ts/src/learning.ts`).

So there is no original screen, no original wire contract and no original preview. **The fidelity
obligation is to the invariants**: declared-not-derived identity, the merge order, non-clobbering
defaults, refuse-rather-than-drop, and damaged-is-not-empty. No visual-fidelity or parity claim can
be made about any of the surfaces below, and none is.

### What Ferretry now carries

**A named intent, never a document.** A caller sends one of `initialize`, `create-account` or
`edit-account` (`FleetMutationSchema`) and the daemon derives the next configuration from the current
one (`packages/daemon/src/lib/fleet/mutations.ts` `applyFleetMutation`). This is the decision the whole
flow rests on: an arbitrary whole-config replacement can differ from what was previewed in ways nobody
reads, while "create this account" has one meaning and one derivation. Identity is minted **server
side** — the account UUID, the wrapper name (`<harness>-<name>`, or `<harness>-<variant>-<name>` off
the default lane) and the relative home — so a caller cannot collide with, or silently re-point, an
account it does not own. Every derivation goes back through `FleetConfigSchema`, so the duplicate-id,
duplicate-wrapper, duplicate-home and availability cross-checks from [A](#a--declare-a-fleet) apply to
a browser edit exactly as they do to a hand-written file.

**An edit is a patch, not a replacement.** An omitted field is left alone and an explicit `null`
removes it (`FleetAccountLayerPatchSchema`). Without that distinction an editor showing four of the
eight overlay slots would blank the other four the first time somebody changed an account's
instructions, and there would be no way to clear a field at all.

**A held proposal, not a re-derived plan.** `FleetProposalStore`
(`packages/daemon/src/lib/fleet/proposals.ts`) holds the candidate configuration, the bounded asset
edits and the **exact** preview that was shown, together with the configuration revision and each
asset revision as they were at review time. Applying consumes that stored artifact; it never rebuilds
one from a fresh request. An input that moved in between is refused as stale rather than applied
silently over — and the asset half of that check is the one that loses data quietly, because stored
text composed against a file that no longer exists would overwrite whatever replaced it. Proposals are
bounded in count and lifetime and are single-use, with tombstones so a replay is told it was consumed
rather than that it never existed.

**Authority is separate from pairing, and it is the capability model rather than a system of the
fleet's own.** Reads and composing a proposal are open to a paired device, because composing writes
nothing. Changing the host is `fleet`/`configure`, decided by `decideCapability` and enforced at the
authorization boundary before any handler runs; where the machine has an operator password, a governed
caller proves that same password again against one exact staged change.

**This paragraph used to describe a second authorization system**, and the correction is left visible
rather than edited away: `POST /v1/fleet/proposals/:proposalId/authorize` minted a host-only single-use
code with a 120-second life and a five-attempt budget of its own, reached through
`fy fleet authorize <proposal-id>`. Route and verb are both deleted, in one change, along with the four
inline `tokenClass === 'device'` refusals that sat beside them — see
[fleet-authority-unification](../../design/fleet-authority-unification.md). The body-less admin
`POST /v1/fleet/apply` is unchanged.

**First run works from the browser, and reuses the scaffolder rather than inventing a second policy.**
`initialize` goes through `buildFleetScaffold` and `FileFleetScaffolder`, whose create-if-absent
semantics are the kernel's decision, so a person's own asset can never be replaced by a default through
this path. The daemon answers with `initialized` or `initialization-partial` — its **own** outcomes,
publishing no manifest, carrying the created/kept/directory evidence and the `pathEntry` (see
[B](#b--materialize-it)) — and the surface renders each with its own words rather than folding either
into an apply: a prepared host is told **no manifest has been published yet**, and a partly prepared one
is told where preparation stopped and that running it again is safe because it only ever creates what is
still absent. The `pathEntry` is shown at the review step, before anything is written, because a fleet
whose wrappers are not on `PATH` is a fleet nobody can launch. Initialization and a damaged
configuration stay different states with different copy, because "there is no fleet here yet" and "this
fleet will not parse" ask a person to do opposite things.

**The outcome is a body, not a message — and one body, read by both ends.** All six states travel as a
discriminated value from the shared `FleetApplyOutcomeSchema`: the daemon parses its own response
through it and the browser parses the same schema on the way in, so the two cannot hold different ideas
of what happened. That is what stops "the fleet landed and only shared history failed" being rendered as
"refused", and stops a prepared host being rendered as an applied one.

**Where it lives.** One `{ id: 'fleet' }` sub-tab in the daemon's own Settings frame, mounted through
the existing `daemonSettingsTabs` seam in `App.tsx`, with the surface under
`packages/pwa/src/features/fleet/`. Everything is stamped with the connection it belongs to: changing
daemon replaces the client, the evidence, the draft, the proposal, the approval code and the result
outright, because a draft composed against one host must never be applied to another. Nothing is
patched optimistically — the manifest and configuration are re-read from the daemon after an apply,
including after a failure.

### Still GAP, deliberately

- **No delete.** There is no `remove-account` mutation, and `edit-account` cannot change an account's
  harness, wrapper or home. Removing an account, or moving one, is still a hand edit of `config.yaml`
  followed by an apply. (The wrapper is then swept by the existing prune; the home is not — see below.)
- **Only accounts.** `profiles`, `variants`, `commands`, `aliases`, `defaultHomes`, `sharedHistory`,
  `health` and `usage` have no browser editor. A change to any of them is a hand edit.
- **Profile environment is read-only from the browser.** `PUT /v1/fleet/environment` still refuses a
  device credential, and the shipped Environment panel was made truthfully read-only rather than left
  offering a button that always failed. Per-**account** environment is editable through the account
  layer; per-**profile** environment is not.
- **Per-skill selection.** `skills` is one opaque directory reference in both originals and in
  Ferretry, so a per-skill picker has nothing to bind to. The editor assigns a directory and edits the
  text files under it.
- **Home pruning.** The sweep is bounded to the wrapper directory, so removing an asset from the
  configuration leaves the copy already inside an account home.
- **Settings key deletion.** `preserveExisting` folds the live file in as the base layer, so an edit
  merges over what the harness wrote and a deletion does not remove a key from disk.
- **Comment-preserving YAML.** The configuration round-trips through the schema and
  `Bun.YAML.stringify`, so comments, anchors and key order in a hand-written `config.yaml` do not
  survive the first change made from a browser, and schema defaults are materialised. The surface
  discloses this before the change, rather than after somebody loses a comment they wrote.
- **Executable assets and unsupported slots.** No slot for something like a status line; Claude has no
  `hooks` destination and Codex no `mcp` one, and declaring either is refused at plan time
  ([C](#c--own-the-assets)).
- **Crash transactionality.** As in [B](#b--materialize-it): a thrown error, not a killed task.

---

## Better because we're not compatible

Eight places where dropping compatibility makes the answer better, not merely different. Items 1–3
were taken by the init/defaults unit and item 8 by the configuration-UI unit; the rest are
recommendations with the reasoning attached.

1. **Ship real defaults instead of copying a directory that does not exist.** _(taken)_ kfleet's
   `init` was written to copy bundled templates and no templates were ever bundled; the defaults came
   from outside the tool. `fy fleet init` ships its own, writes them only when absent, and therefore
   has an upgrade story kfleet never had: a newer product can add a default without touching a file
   the person has edited.

2. **Say where `PATH` must point, at the moment it matters.** _(taken)_ kfleet never had to, because
   Home Manager set `PATH`. Ferretry must, and the honest place is the command that creates the
   directory.

3. **Refuse configuration we do not implement.** _(taken)_ Compatibility would have forced us to keep
   accepting unsupported `usage` and health knobs as no-ops so a kfleet file still parsed. We are not
   compatible, so a fleet is never told it has something it does not. `sharedHistory` left this
   refusal list only when its plan, dry-run evidence and apply path were all mounted.

4. **Do not port `kfleet serve` or `kfleet service` — 509 lines.** Ferretry already installs and
   supervises a per-user daemon on both launchd and systemd, and already serves HTTP. The missing
   piece is a probe loop inside it, not a second always-on process on a second port with its own
   `~/.secrets` sourcing.

5. **Do not port the status line as a 267-line zsh script.** Its content is model, context, account
   and 5-hour/weekly quota — data the daemon will hold once [F](#f--know-whos-out-of-quota) exists.
   A status line that asks the local daemon is shorter, testable, and consistent with what the PWA
   shows; a jq-and-ANSI script is neither. Ferretry does need _some_ home for an executable asset
   (the asset table has no slot for one), but that is a smaller question than porting this file.

6. **Pool session state by symlink — owner override.** The original recommendation was to make the
   daemon resume across homes instead. The owner explicitly chose kfleet's native-resume semantics,
   so [I](#i--resume-anything-anywhere) now ports the symlink pools and hardens their one-time migration
   rather than substituting a digest-based resume path.

7. **Group logins by declared identity.** kfleet infers the base agent from a wrapper-name infix and
   has to detect the collisions that causes. `identity` is already a declared field here, so the
   grouping half of [E](#e--get-logged-in) is free — only the credential-store adapter is real work.

8. **Let a remote change be a named intent rather than a document.** _(taken)_ A tool that had to keep
   accepting kfleet's file would have had one natural remote shape: send the whole configuration back.
   That shape cannot be reviewed honestly — the applier can differ from the preview in ways nobody
   reads. Because there is no format to preserve, `create-account` and `edit-account` could be the wire
   contract instead, with the daemon deriving identity and the next configuration itself. That is what
   makes the preview in [M](#m--change-it-without-a-shell) worth showing, and it is only available
   because compatibility was waived.

And one where dropping compatibility **costs** us something, flagged rather than decided:

> **There is no import path, so the owner recreates his accounts by hand.** His `config.yaml` is 12K
> describing on the order of thirty wrappers, and Ferretry's format differs in every way that
> matters — declared UUIDs, opt-in routes, explicit availability and models, no `credential:` block.
> An importer is buildable (the two schemas are close enough that a mechanical translation would
> work, minus the UUIDs and the model declarations, which have no source). Compatibility was
> explicitly waived, so none was built. The decision is his; this note exists so it is a decision
> rather than a surprise.

---

## What this unit closed

> All five are landed and gated.

### 1. `fy fleet init` — [J](#j--start-from-nothing) and half of [C](#c--own-the-assets)

`packages/fleet/src/lib/scaffold.ts` builds a scaffold as a value: the directories the fleet owns
(including the assets directory `apply` never created), a documented starter `config.yaml`, and an
assets `README.md` stating the override mechanism. `packages/fleet/src/adapters/file-scaffolder.ts`
writes it, **creating only what is absent** and reporting what it left alone, bounded to the fleet
directory. `fy fleet init` reports both lists and prints the `PATH` line.

Nothing personal is shipped: the starter config declares no accounts and carries a commented example
with freshly generated ids, so a person can uncomment and edit rather than invent a UUID.

### 2. First-run seeding, baked into the wrapper — [K](#k--survive-the-first-run)

The one that decides whether a non-interactive launch reaches a turn at all. Placed in the wrapper
rather than written at apply time so it re-asserts on every invocation and cannot drift; the
reasoning, and the four ways it departs from kfleet's version, are in
[K](#k--survive-the-first-run). Proven by executing the generated script against a real `sh`, a real
`jq` and a disposable home rather than by asserting on its text.

### 3. `fy fleet login`, with the caller's credentials stripped — part of [E](#e--get-logged-in)

`FleetLoginService` and `ProcessFleetLoginPort` were built, tested, exported, and called by nothing.
Mounting them made the capability exist. `packages/fleet/src/lib/harness-env.ts` then fixed a real
defect: the spawn used to inherit the caller's provider environment, and since a wrapper only
overrides its _home_, a login run from inside an agent session could authenticate against that
session's account. A wrapper that deliberately reads a secret from the environment still gets it —
the names it references are parsed back out of the wrapper — and an unreadable wrapper preserves
nothing rather than everything.

### 4. Configuration we do not implement is refused — the honest half of [F](#f--know-whos-out-of-quota) and [H](#h--keep-it-fresh)

`packages/fleet/src/lib/capabilities.ts` lists what the schema can express and this build cannot
perform; `FleetPlan.build` throws naming every offending key, what it would have done, and what
happens instead. It fires only on a value somebody had to write, never on a schema default, so an
existing working configuration still applies — and `--dry-run` refuses too, because a clean plan for
a configuration `apply` could not honour is the misleading half of the same bug.

### 5. `usage.concurrency` and `usage.atLimitPercent` are honoured

The collector was constructed before the configuration was read, so a declared `atLimitPercent: 90`
behaved as 100.

---

## What was left

- **The provider probes ([F](#f--know-whos-out-of-quota)).** The largest remaining blocker: five
  providers, two credential stores, a keychain shell-out, a refresh dance, and a credential-identity
  model to dedupe against. A unit of its own, and it shares that identity model with
  [E](#e--get-logged-in), so the two should be sequenced together.
- **Credential sync ([E](#e--get-logged-in)).** Same reason.
- **Codex SQLite prewarm ([I](#i--resume-anything-anywhere)).** The shared directory and ownership
  semantics are ported; the non-LLM app-server reconciliation command remains a declared GAP.
- **Shared-history crash recovery ([I](#i--resume-anything-anywhere)).** Durable evidence and a
  read-only inspection primitive exist; the confirmed operator command that replays a guarded rollback
  remains a declared GAP.
- **The probe loop ([H](#h--keep-it-fresh)).** Its routes landed on `main` as #237 while this unit was writing; the loop behind them, and a real probe to feed it, are that unit's area.
- **Curated skills, hooks and MCP defaults ([C](#c--own-the-assets)).** Neutral instructions, neutral
  per-harness settings, the auto-lane flags and the whole override/upgrade mechanism now ship. What
  does not is any asset that executes code or encodes a workflow: no skills, no hook set, no MCP
  server list. That is a content decision rather than an engineering one, and the owner's own
  `CLAUDE.md`, skills and templates stay his because they carry personal paths and work tooling.
  Two field-level gaps go with it: Claude has no `hooks` destination and Codex no `mcp` one, and
  nothing has a slot for an executable asset such as the status line.
- **`fy fleet doctor` ([L](#l--diagnose-it)).** Not a blocker, and it should be scoped to what only
  the CLI knows so it never becomes a second harness detector.
- **Everything except accounts, in [M](#m--change-it-without-a-shell).** Removing an account, moving
  one, and editing `profiles`, `variants`, `commands`, `aliases`, `defaultHomes`, `sharedHistory`,
  `health` or `usage` are still hand edits of `config.yaml`. Per-profile environment is read-only from
  a browser by the same device-authority rule. None of it blocks deleting kfleet, which had no remote
  editor of any kind.

---

## Appendix A — module correspondence

Recorded once so nobody re-derives it. **A renamed module is not a gap**; this table exists to stop
the next reader concluding otherwise from a name search.

| kfleet module                                              | Ferretry                                                                                         |                                                                                             |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `core/types.ts`, `core/config.ts`                          | `lib/config.ts`, `adapters/config-file.ts`                                                       | renamed                                                                                     |
| `core/merge.ts`                                            | `lib/profiles.ts`                                                                                | renamed                                                                                     |
| `core/generate.ts`                                         | `lib/plan.ts` + `lib/wrappers.ts` + `lib/provisioning.ts` + `adapters/file-provisioner.ts`       | split, deliberately                                                                         |
| `core/kinds.ts`                                            | `lib/assets.ts` + `lib/wrappers.ts` + `lib/fleet/layout.ts`                                      | split by subject                                                                            |
| `core/settings.ts`                                         | `lib/settings.ts` + the provisioner's existing-file read                                         | split pure/IO                                                                               |
| `deps.ts`                                                  | `lib/fleet/layout.ts` + `lib/paths.ts`                                                           | globals became a pure function                                                              |
| `util/format.ts`, `cli/shared.ts`                          | `IFleetOutput` + commander                                                                       | replaced                                                                                    |
| `cli/fleet.ts` (`apply`/`list`/`prune`)                    | `fy fleet apply` / `ls`; prune folded into apply                                                 | renamed                                                                                     |
| `core/harness-probe.ts:80` `sanitizeHarnessEnv`            | `lib/harness-env.ts`                                                                             | ported by this unit                                                                         |
| `core/harness-probe.ts:97` `prepareHarnessProbeEnv`        | `lib/harness-env.ts` `referencedEnvNames` + `adapters/process-login.ts` `readFleetWrapperScript` | split pure/IO                                                                               |
| `core/login.ts:331` `interactiveLogin`                     | `adapters/process-login.ts`                                                                      | ported; mounted by this unit                                                                |
| `cli/init.ts`                                              | `lib/scaffold.ts` + `adapters/file-scaffolder.ts`                                                | redesigned by this unit                                                                     |
| `~/.kfleet/` asset tree (Home Manager's, not kfleet's)     | `lib/scaffold.ts` starters — instructions, per-harness settings, auto-lane flags                 | **neutral halves shipped**; skills/hooks/MCP GAP                                            |
| `core/health.ts`, `core/harness-probe.ts` (rest)           | —                                                                                                | **GAP**, see [G](#g--know-what-actually-works)                                              |
| `core/usage.ts:245,306` Anthropic probes                   | `adapters/anthropic-usage-probe.ts` + `lib/quota.ts`                                             | ported by the quota unit                                                                    |
| `core/usage.ts:824` dedup by credential                    | `lib/usage.ts` `identityOf`                                                                      | keyed on declared identity instead                                                          |
| `core/usage.ts` (other providers)                          | —                                                                                                | **GAP**, see [F](#f--know-whos-out-of-quota)                                                |
| `core/cliproxy-usage.ts`                                   | —                                                                                                | **not to be ported** (owner); config refused                                                |
| `core/creds.ts`                                            | `adapters/credential-store.ts`                                                                   | ported by this unit                                                                         |
| `core/login.ts:73,108,147,243` `credStatus`…`syncIdentity` | `lib/identity.ts` + `adapters/credential-store.ts`                                               | ported by this unit                                                                         |
| `core/login.ts:307` `resolveLoginTarget`                   | `adapters/process-login.ts`                                                                      | ported by this unit                                                                         |
| `cli/login.ts` `runLogin`, `--status`, `--sync-only`       | `lib/login.ts` `FleetLoginService` + `lib/fleet/render.ts`                                       | ported by this unit                                                                         |
| `core/login.ts:163` `filterLiveIdentities`                 | —                                                                                                | **GAP**, needs [G](#g--know-what-actually-works)                                            |
| `core/shared-history.ts`, `core/kinds.ts` `sharedState`    | `lib/shared-history.ts`, `adapters/file-shared-history.ts`, `lib/plan.ts`                        | **PORTED**, see [I](#i--resume-anything-anywhere)                                           |
| `core/generate.ts` Codex SQLite env/settings/ownership     | `lib/plan.ts`, `adapters/file-provisioner.ts`, `lib/wrappers.ts`                                 | **PORTED**, see [I](#i--resume-anything-anywhere)                                           |
| `core/codex-prewarm.ts`, `cli/prewarm.ts`                  | —                                                                                                | **GAP**, see [I](#i--resume-anything-anywhere)                                              |
| — (Ferretry crash-safety extension)                        | `lib/shared-history.ts` `inspectRecovery`                                                        | domain port only; CLI recovery **GAP**, see [I](#i--resume-anything-anywhere)               |
| `core/generate.ts` `AUTOTRUST`                             | `lib/wrappers.ts` first-run seeding                                                              | **PORTED HERE**, redesigned                                                                 |
| `core/firstrun.ts`                                         | — (not needed: our login goes through the wrapper)                                               | see [K](#k--survive-the-first-run)                                                          |
| `cli/serve.ts`, `cli/service.ts`                           | —                                                                                                | **not to be ported**, see [H](#h--keep-it-fresh)                                            |
| `cli/doctor.ts`                                            | —                                                                                                | **GAP**, see [L](#l--diagnose-it)                                                           |
| —                                                          | `lib/manifest.ts`                                                                                | **new in Ferretry**; kfleet published no manifest                                           |
| —                                                          | `lib/capabilities.ts`                                                                            | **new**; refuses unimplemented configuration                                                |
| —                                                          | `lib/identity.ts` `unreadable` state                                                             | **new in this unit**; kfleet had no such state                                              |
| — (`kfleet apply` is delete-then-create, no rollback)      | `adapters/{mutation-journal,apply-lock}.ts`, `lib/provisioning.ts` `FleetApplyFailure`           | **new**; reverse-order undo, per-fleet lock, four honest outcomes — [B](#b--materialize-it) |
| — (hand-edit `config.yaml`, then `kfleet apply`)           | `daemon/src/lib/fleet/mutations.ts`                                                              | **new**; named intents, server-minted identity — [M](#m--change-it-without-a-shell)         |
| — (no dry run anywhere in kfleet)                          | `daemon/src/lib/fleet/proposals.ts` + `GET /v1/fleet/plan`                                       | **new**; a held, single-use, expiring proposal carrying the exact preview                   |
| — (Home Manager owned the asset tree)                      | `daemon/src/lib/fleet/{assets,asset-store}.ts`                                                   | **new**; bounded text-asset read/edit confined to `fleet/assets`                            |
| — (kfleet had no credentials and no remote caller)         | the `fleet` capability (`daemon/src/lib/grants/`) + the per-change confirmation                  | **new**; one vocabulary with the other five capabilities, not a system of the fleet’s own   |
| —                                                          | `pwa/src/features/fleet/*` mounted as the daemon `fleet` Settings sub-tab                        | **new**; no original screen, so no fidelity claim is made                                   |
