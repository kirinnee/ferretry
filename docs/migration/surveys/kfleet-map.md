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

---

## Scorecard

Can the owner delete kfleet today? **No — six capabilities short**, down from nine before this unit. Ordered by what actually stops
him, not by line count.

| #   | Capability — what a person uses kfleet for                          | Ferretry today                   | Blocks deleting kfleet?                                               |
| --- | ------------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------- |
| A   | [Declare a fleet of accounts](#a--declare-a-fleet)                  | **Carried**, and stronger        | No                                                                    |
| B   | [Turn that declaration into working wrappers](#b--materialize-it)   | **Carried**; init now names PATH | **Was yes** — nothing put the wrappers on PATH; _closed by this unit_ |
| C   | [Own the assets those accounts run with](#c--own-the-assets)        | Destination table only           | **Yes**                                                               |
| D   | [See what the fleet is](#d--see-the-fleet)                          | **Carried**, and stronger        | No                                                                    |
| E   | [Get every account logged in](#e--get-logged-in)                    | One approval per _identity_      | **Was yes**; _closed by the identity unit_                            |
| F   | [Know which accounts have quota left](#f--know-whos-out-of-quota)   | Reports everything unknown       | **Yes**                                                               |
| G   | [Know which accounts actually work](#g--know-what-actually-works)   | Nothing                          | **Yes** (health is off by default upstream)                           |
| H   | [Keep that knowledge fresh unattended](#h--keep-it-fresh)           | Routes yes; no loop, no probe    | **Yes**                                                               |
| I   | [Resume any session from any account](#i--resume-anything-anywhere) | Nothing; now refused             | **Yes**, if he uses it                                                |
| J   | [Start from nothing on a new machine](#j--start-from-nothing)       | `fy fleet init`                  | **Was yes**; _closed by this unit_                                    |
| K   | [Not be stopped by first-run prompts](#k--survive-the-first-run)    | Seeded in the wrapper            | **Was yes**, for automation; _closed by this unit_                    |
| L   | [Diagnose it when it is wrong](#l--diagnose-it)                     | Nothing                          | No — annoying, not blocking                                           |

Three facts that the capability rows assume and that are easy to miss:

1. **`fy fleet usage` reports every account as `unavailable` today.** The only `FleetUsageProbe`
   implementation is `UnprovisionedUsageProbe` (`packages/cli/src/adapters/fleet/usage-probe.ts:11`).
   It is honest about it, but there is no quota data anywhere in the product.
2. **The reachability gate cannot see this package's dead capability.**
   `scripts/validate/composition-reachability.ts:22` roots a package with no `bin` at its `exports`,
   so everything under `packages/fleet`'s barrel is "reachable" by definition. `FleetLoginService`
   passed every gate for weeks while nothing called it. `groupByIdentity` was the same, and is
   now reached through `buildFleetIdentities`; `renderFleetUsageJson` and
   `renderFleetUsageMetrics` still are not called. A green build is not evidence of absorption here.
3. **Configuration used to be accepted and silently ignored** — `sharedHistory`, `health.*`, most of
   `usage.*` parsed cleanly and reached nothing. Closed by this unit: the plan now refuses.

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

**Nothing to build.**

---

## B — Materialize it

**What a person does.** Runs one command and gets: an executable per account on `PATH`, a private
home per account, that account's settings/memory/skills/hooks/MCP materialized inside it, the bare
`claude`/`codex` command pointed at a nominated account, alias wrappers fanned out across the fleet,
and anything no longer declared swept away.

**Ferretry's answer: carried, and better shaped.** `fy fleet apply` builds a complete, inspectable
plan (`packages/fleet/src/lib/plan.ts:86`) and hands it to an adapter (`file-provisioner.ts:38`) that
writes atomically and refuses to write outside the roots the composition root declared. `--dry-run`
is the same code path minus the last step, so what a human reviews is the value the applier consumes;
kfleet's dry run re-derived a summary and could disagree with the real thing. Pruning is bounded
twice — direct children of the bin directory, and only files carrying the managed marker.

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

**The finding: kfleet does not own any of this, and neither does Ferretry.**

- kfleet's `cli/init.ts:9` copies from `path.join(import.meta.dir, '../../templates')` — a directory
  that **does not exist in the kfleet source tree**. `kfleet init` therefore logs "no templates
  bundled" and creates an empty `~/.kfleet`. Every asset above is supplied by Home Manager, which
  links the repo's `kfleet/` directory into `~/.kfleet/`. kfleet only _references_ assets by relative
  path (`deps.ts:26` `resolveAsset`).
- Ferretry's `packages/fleet/src/lib/assets.ts` is **not the asset story**. It is the per-harness
  destination table — "a declared `memory:` lands at `CLAUDE.md` and is symlinked; a declared
  `settings:` lands at `settings.json` and is copied because the harness rewrites it". Sixty-nine
  lines, entirely about _where a declared asset goes_. It answers nothing about _what assets exist_
  or _where they come from_.
- `expandAssetPath` (`paths.ts:40`) resolves a relative reference against `layout.assetsDirectory`,
  which is `<FY_HOME>/fleet/assets`. So the reference mechanism is carried in full.
- **But `fy fleet apply` never creates that directory.** `plan.ts:97` creates the fleet, bin and
  homes directories and stops. A relative asset reference resolves into a path nothing made.

So of this capability Ferretry carries: _reference resolution_ and _materialization destinations_.
It carries none of: shipping a default, letting a person override a default, upgrading a default
without clobbering an override, or hosting an executable asset like the status line.

**Replacing kfleet means Ferretry owns both halves — the defaults and the override mechanism —
because Home Manager will not be in the loop.** The owner's asset _content_ is his and stays his;
what belongs in a public repo is the mechanism plus neutral defaults.

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

_Partly closed by this unit_ — see [J](#j--start-from-nothing) for the mechanism and the directory;
the default _content_ beyond a starting point is left, with the reasons in
[What was left](#what-was-left).

---

## D — See the fleet

**What a person does.** Asks what accounts exist, where each lives, what it can serve.

**Ferretry's answer: carried, and stronger.** `fy fleet ls` reads the published manifest
(`packages/fleet/src/lib/manifest.ts`) — a record kfleet did not have at all; its consumers globbed
the bin directory, so a stale executable produced a row for an account that no longer existed. PR
#231 adds a read-only PWA surface on top of the same data, which kfleet had no equivalent of.

**Nothing to build.**

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

| kfleet                                               | Ferretry                                                        |
| ---------------------------------------------------- | --------------------------------------------------------------- |
| `core/usage.ts:993` at-limit rule                    | `lib/usage.ts:140` `isAtLimit`                                  |
| `core/usage.ts:466` corroborate-before-condemning    | `lib/usage.ts:153` `isCorroboratedAuthRejection`                |
| `core/usage.ts:382` "sort windows by reset horizon"  | `lib/usage.ts:112` `normalizeUsageWindows`                      |
| `core/usage.ts:444` `100 − remaining`                | `lib/usage.ts:82` `usedPercentFromRemaining`                    |
| `core/usage.ts:912` aggregation, bounded concurrency | `lib/usage.ts:172` `FleetUsageCollector`                        |
| `cli/serve.ts:73` Prometheus rendering               | `lib/usage.ts:243` `renderFleetUsageMetrics` — **never called** |
| `cli/serve.ts:200` `/usage` envelope                 | `lib/usage.ts:229` `renderFleetUsageJson` — **never called**    |

Ferretry's collector is also stricter in the right place: a _failed_ probe can never set `atLimit`
(`usage.ts:211`). Only a successful reading or a proven-unavailable state can exhaust an account.

Missing: **every call that would produce a number.** Anthropic stored-OAuth (`core/usage.ts:306`),
Anthropic external-token via `max_tokens:1` quota headers (`:245` — note the headers are fractions in
0..1 while the JSON endpoint is 0..100, and mixing them is a 100× error), Codex/ChatGPT (`:333`),
z.ai (`:382`), MiniMax (`:487`), plus classification (`:741`), **deduplication by credential**
(`:824` — many wrappers share one credential; kfleet probes each unique credential once), pre-probe
token refresh (`:624`), donor healing (`:885`), secrets-file resolution (`:703`), local credential
reading (`core/creds.ts` — **now PORTED**, as `adapters/credential-store.ts`), and the entire
CLIProxyAPI availability source (`core/cliproxy-usage.ts`, 308 lines).

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

**Ferretry's answer: nothing on `main`.**

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

**Ferretry's answer: the supervision half already exists and is better. The probing half does not
exist.**

`fy daemon install|uninstall|start|stop|restart|status|logs` is already shipped
(`packages/cli/src/lib/daemon/commands.ts`) with both launchd and systemd support
(`packages/cli/src/lib/daemon/probe.ts`). Ferretry already runs a supervised, always-on process with
an HTTP surface.

**So `kfleet serve` and `kfleet service` — 509 lines — should not be ported at all.** Nothing needs a
second service manager, a second port, or the `/bin/sh -c '. ~/.secrets; …'` trick kfleet uses to get
API keys into a launchd job; Ferretry's wrappers already declare their `$NAME` references and guard
them.

**The routes landed while this unit was writing.** `feat(daemon): mount fleet routes (#237)` merged
to `main` and serves `GET /v1/fleet/{accounts,config,plan,usage}` and `POST /v1/fleet/apply`
(`packages/daemon/src/lib/runtime/mounts/fleet.ts`). So the endpoint half of `serve` now exists, in
the right place, without a second process.

Two things it does **not** yet do, and both are the same two gaps as before:

- **There is no loop.** `/v1/fleet/usage` collects when asked. `usage.interval` still configures
  nothing, so an answer is only as fresh as the request — which is fine while the answer is empty,
  and becomes the stale-quota problem the moment it is not.
- **There is still no probe.** The daemon constructs its own `UnprovisionedFleetUsageProbe`, the
  counterpart of the CLI's. Two honest placeholders, not a duplication problem — but it does mean the
  provider probes of [F](#f--know-whos-out-of-quota) belong in `packages/fleet` where both consume
  one implementation, rather than in either caller.

`renderFleetUsageMetrics` and `renderFleetUsageJson` (`lib/usage.ts:229,243`) remain uncalled: the
daemon's route returns the snapshot rather than either rendering, so a Prometheus scrape has nothing
to read yet.

**Coordination:** the daemon-side work is that unit's; this one built none of it.

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

**Ferretry's answer: nothing.** 557 lines with no counterpart. Until this unit the configuration for
it parsed cleanly and did nothing, so a fleet could believe its sessions were pooled; the plan now
refuses.

**But do not port it.** Symlinking harness state directories is kfleet's answer _because kfleet has
no process of its own_. Ferretry has a daemon that already reads transcripts, owns a session model,
and serves them to a UI. "Resume any session from any account" in Ferretry should mean the daemon
knows about every account's sessions — not that two accounts share a directory whose format a harness
vendor can change under us. See [Better because incompatible](#better-because-were-not-compatible).

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

## Better because we're not compatible

Seven places where dropping compatibility makes the answer better, not merely different. The first
three are taken in this unit's work; the rest are recommendations with the reasoning attached.

1. **Ship real defaults instead of copying a directory that does not exist.** _(taken)_ kfleet's
   `init` was written to copy bundled templates and no templates were ever bundled; the defaults came
   from outside the tool. `fy fleet init` ships its own, writes them only when absent, and therefore
   has an upgrade story kfleet never had: a newer product can add a default without touching a file
   the person has edited.

2. **Say where `PATH` must point, at the moment it matters.** _(taken)_ kfleet never had to, because
   Home Manager set `PATH`. Ferretry must, and the honest place is the command that creates the
   directory.

3. **Refuse configuration we do not implement.** _(taken)_ Compatibility would have forced us to keep
   accepting `sharedHistory` and the `usage` scheduling knobs as no-ops so a kfleet file still
   parsed. We are not compatible, so a fleet is never told it has something it does not.

4. **Do not port `kfleet serve` or `kfleet service` — 509 lines.** Ferretry already installs and
   supervises a per-user daemon on both launchd and systemd, and already serves HTTP. The missing
   piece is a probe loop inside it, not a second always-on process on a second port with its own
   `~/.secrets` sourcing.

5. **Do not port the status line as a 267-line zsh script.** Its content is model, context, account
   and 5-hour/weekly quota — data the daemon will hold once [F](#f--know-whos-out-of-quota) exists.
   A status line that asks the local daemon is shorter, testable, and consistent with what the PWA
   shows; a jq-and-ANSI script is neither. Ferretry does need _some_ home for an executable asset
   (the asset table has no slot for one), but that is a smaller question than porting this file.

6. **Do not pool session state by symlink.** [I](#i--resume-anything-anywhere) explains it: kfleet
   symlinks harness-owned directories because it has no process of its own. Ferretry has a daemon
   that already reads transcripts. Making the daemon aware of every account's sessions gets the same
   capability without depending on a layout a harness vendor can change, and without a migration that
   moves live files.

7. **Group logins by declared identity.** kfleet infers the base agent from a wrapper-name infix and
   has to detect the collisions that causes. `identity` is already a declared field here, so the
   grouping half of [E](#e--get-logged-in) is free — only the credential-store adapter is real work.

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

### 4. Configuration we do not implement is refused — the honest half of [F](#f--know-whos-out-of-quota), [H](#h--keep-it-fresh) and [I](#i--resume-anything-anywhere)

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
- **Shared history ([I](#i--resume-anything-anywhere)).** Should be redesigned, not ported.
- **The probe loop ([H](#h--keep-it-fresh)).** Its routes landed on `main` as #237 while this unit was writing; the loop behind them, and a real probe to feed it, are that unit's area.
- **Default asset _content_ beyond a starting point ([C](#c--own-the-assets)).** The owner's
  `CLAUDE.md`, skills and templates are his and carry personal paths and work tooling. What Ferretry
  needs is a curated neutral default set, which is a content decision rather than an engineering one.
- **`fy fleet doctor` ([L](#l--diagnose-it)).** Not a blocker, and it should be scoped to what only
  the CLI knows so it never becomes a second harness detector.

---

## Appendix A — module correspondence

Recorded once so nobody re-derives it. **A renamed module is not a gap**; this table exists to stop
the next reader concluding otherwise from a name search.

| kfleet module                                                       | Ferretry                                                                                         |                                                   |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| `core/types.ts`, `core/config.ts`                                   | `lib/config.ts`, `adapters/config-file.ts`                                                       | renamed                                           |
| `core/merge.ts`                                                     | `lib/profiles.ts`                                                                                | renamed                                           |
| `core/generate.ts`                                                  | `lib/plan.ts` + `lib/wrappers.ts` + `lib/provisioning.ts` + `adapters/file-provisioner.ts`       | split, deliberately                               |
| `core/kinds.ts`                                                     | `lib/assets.ts` + `lib/wrappers.ts` + `lib/fleet/layout.ts`                                      | split by subject                                  |
| `core/settings.ts`                                                  | `lib/settings.ts` + the provisioner's existing-file read                                         | split pure/IO                                     |
| `deps.ts`                                                           | `lib/fleet/layout.ts` + `lib/paths.ts`                                                           | globals became a pure function                    |
| `util/format.ts`, `cli/shared.ts`                                   | `IFleetOutput` + commander                                                                       | replaced                                          |
| `cli/fleet.ts` (`apply`/`list`/`prune`)                             | `fy fleet apply` / `ls`; prune folded into apply                                                 | renamed                                           |
| `core/harness-probe.ts:80` `sanitizeHarnessEnv`                     | `lib/harness-env.ts`                                                                             | ported by this unit                               |
| `core/harness-probe.ts:97` `prepareHarnessProbeEnv`                 | `lib/harness-env.ts` `referencedEnvNames` + `adapters/process-login.ts` `readFleetWrapperScript` | split pure/IO                                     |
| `core/login.ts:331` `interactiveLogin`                              | `adapters/process-login.ts`                                                                      | ported; mounted by this unit                      |
| `cli/init.ts`                                                       | `lib/scaffold.ts` + `adapters/file-scaffolder.ts`                                                | redesigned by this unit                           |
| `core/health.ts`, `core/harness-probe.ts` (rest)                    | —                                                                                                | **GAP**, see [G](#g--know-what-actually-works)    |
| `core/usage.ts` (probes)                                            | —                                                                                                | **GAP**, see [F](#f--know-whos-out-of-quota)      |
| `core/cliproxy-usage.ts`                                            | —                                                                                                | **not to be ported** (owner); config refused      |
| `core/creds.ts`                                                     | `adapters/credential-store.ts`                                                                   | ported by this unit                               |
| `core/login.ts:73,108,147,243` `credStatus`…`syncIdentity`          | `lib/identity.ts` + `adapters/credential-store.ts`                                               | ported by this unit                               |
| `core/login.ts:307` `resolveLoginTarget`                            | `adapters/process-login.ts`                                                                      | ported by this unit                               |
| `cli/login.ts` `runLogin`, `--status`, `--sync-only`                | `lib/login.ts` `FleetLoginService` + `lib/fleet/render.ts`                                       | ported by this unit                               |
| `core/login.ts:163` `filterLiveIdentities`                          | —                                                                                                | **GAP**, needs [G](#g--know-what-actually-works)  |
| `core/shared-history.ts`, `core/codex-prewarm.ts`, `cli/prewarm.ts` | —                                                                                                | **GAP**, see [I](#i--resume-anything-anywhere)    |
| `core/generate.ts` `AUTOTRUST`                                      | `lib/wrappers.ts` first-run seeding                                                              | **PORTED HERE**, redesigned                       |
| `core/firstrun.ts`                                                  | — (not needed: our login goes through the wrapper)                                               | see [K](#k--survive-the-first-run)                |
| `cli/serve.ts`, `cli/service.ts`                                    | —                                                                                                | **not to be ported**, see [H](#h--keep-it-fresh)  |
| `cli/doctor.ts`                                                     | —                                                                                                | **GAP**, see [L](#l--diagnose-it)                 |
| —                                                                   | `lib/manifest.ts`                                                                                | **new in Ferretry**; kfleet published no manifest |
| —                                                                   | `lib/capabilities.ts`                                                                            | **new**; refuses unimplemented configuration      |
| —                                                                   | `lib/identity.ts` `unreadable` state                                                             | **new in this unit**; kfleet had no such state    |
