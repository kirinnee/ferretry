# Survey — kfleet against Ferretry's fleet

`~/.config/home-manager/modules/kfleet-ts/src` is **5,205 non-test lines** across 28 files. Ferretry
carries `packages/fleet/src` (2,420) plus `packages/cli/src/lib/fleet` + `packages/cli/src/adapters/fleet`
(615). This document is the capability-by-capability comparison behind the question "is kfleet
absorbed?".

**How it was established.** Every non-test kfleet source file was read in full. The Ferretry side was
read in full as well — `packages/fleet/src/**`, `packages/cli/src/lib/fleet/**`,
`packages/cli/src/adapters/fleet/**` — plus the composition root (`packages/cli/bin/fy.ts`) to
establish what is actually _called_, not merely what exists. Where a row says GAP, the capability was
searched for under every name it plausibly travels under before the absence was recorded. Coverage
was not consulted: **coverage cannot detect a missing feature**, and three PRs on this migration
shipped subsystems missing their core files at 100%.

Two branches that are not on `main` are named where they matter: `feat/fleet-management` (PR #231)
and `fix/harness-preflight`. Rows about them say so explicitly.

---

## The headline

**Provisioning is genuinely absorbed and improved. Everything that touches a live provider is not.**

| kfleet area                                     | Lines | State                                                                                      |
| ----------------------------------------------- | ----: | ------------------------------------------------------------------------------------------ |
| config schema, merge, settings, generate, prune | 1,822 | **PORTED**, refactored, and in several places stricter than the source                     |
| usage probing (all five providers)              | 1,328 | **GAP** — the aggregation half is ported, every provider call is not                       |
| login (identity sync, donor healing)            |   581 | **PARTIAL** — a login _spawner_ exists (unmounted until this unit); the sync core does not |
| harness liveness probing                        |   538 | **GAP**                                                                                    |
| shared history + Codex prewarm                  |   557 | **GAP** — and the configuration for it is parsed and silently ignored                      |
| `serve` / `service` (background loop, metrics)  |   509 | **GAP** — the renderers are ported, the server and the loop are not                        |
| `init`, `doctor`                                |    72 | **GAP**                                                                                    |

Three findings matter more than the line counts:

1. **`fy fleet usage` currently reports every account as `unavailable`.**
   `packages/cli/src/adapters/fleet/usage-probe.ts:11` is `UnprovisionedUsageProbe`, wired at
   `packages/cli/bin/fy.ts:488`. It is honest — it says so in its own doc comment and refuses to
   report a fabricated 0% — but the command produces no quota data at all today.

2. **Configuration is accepted and silently ignored.** `sharedHistory`, `health.*` and almost all of
   `usage.*` parse successfully (`packages/fleet/src/lib/config.ts:197,223,311`) and reach nothing.
   An operator who writes `sharedHistory: {codex: true}` gets no session pooling and no word said;
   one who writes `usage.atLimitPercent: 90` gets 100. This is the "damaged state is not empty
   state" failure applied to configuration. Closed by this unit — see [What this unit closed](#what-this-unit-closed).

3. **The reachability gate cannot see the fleet package's dead capability.**
   `scripts/validate/composition-reachability.ts:22` treats a package with no `bin` as rooted at its
   `exports`. `packages/fleet` has no binary, so _everything_ under its barrel is "reachable" by
   definition. `FleetLoginService`, `ProcessFleetLoginPort`, `groupByIdentity`,
   `renderFleetUsageJson` and `renderFleetUsageMetrics` all passed every gate while no composition
   root called any of them. This unit mounted the first two; `groupByIdentity` and the two renderers
   are still uncalled and still green. Nothing is wrong with the gate — the fleet package is simply
   outside what it can prove, and that is worth knowing before reading a green build as absorption.

---

## 1. Configuration and composition — PORTED

| kfleet source                                | Ferretry carrier                                                             | Notes                                                                                                                                                                                                                                                                         |
| -------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/types.ts:218` `configSchema`           | `packages/fleet/src/lib/config.ts:295` `FleetConfigSchema`                   | Ported and materially stronger: routes are **opt-in per (agent × variant)** instead of a full cross-product, every account declares a UUID `id`, and cross-references (unknown profile/variant, duplicate id/wrapper/home, incoherent availability) are checked in one parse. |
| `core/types.ts:38,62` profile/overlay fields | `packages/fleet/src/lib/config.ts:98,113`                                    | Field-for-field identical (`env`, `flags`, `settings`, `memory`, `skills`, `hooks`, `hooksDir`, `mcp`, `claude:`/`codex:` overlays).                                                                                                                                          |
| `core/types.ts:99` `commandSchema`           | `packages/fleet/src/lib/config.ts:174`                                       | `target` is an account **id**, not a wrapper name — a rename can no longer silently repoint a command.                                                                                                                                                                        |
| `core/types.ts:114` `aliasesSchema`          | `packages/fleet/src/lib/config.ts:188`                                       | Ported. Requires at least one harness, which kfleet did not.                                                                                                                                                                                                                  |
| `core/types.ts:122` `defaultHomesSchema`     | `packages/fleet/src/lib/config.ts:308`                                       | Ported, by id.                                                                                                                                                                                                                                                                |
| `core/types.ts:210` `variantSchema`          | `packages/fleet/src/lib/config.ts:127`                                       | Ported, plus a `mode` default for its routes.                                                                                                                                                                                                                                 |
| `core/config.ts:7` `loadConfig`              | `packages/fleet/src/adapters/config-file.ts:14` `FileFleetConfigSource`      | Ported; IO moved to the adapter tier, `Bun.YAML` instead of the `yaml` package.                                                                                                                                                                                               |
| `core/merge.ts:49` `resolveAll`              | `packages/fleet/src/lib/profiles.ts:157` `resolveAccounts`                   | Ported exactly — same slot order (`base → agent.profiles → variant.profiles → variant.inline → agent.inline`), same per-slot harness flattening, same env-merge/flags-concat/settings-concat/scalar-replace rules.                                                            |
| `core/settings.ts:21` `deepMerge`            | `packages/fleet/src/lib/settings.ts:28` `deepMergeSettings`                  | Ported. Arrays replace rather than concatenate in both.                                                                                                                                                                                                                       |
| `core/settings.ts:67` `readRuntimeLayer`     | `packages/fleet/src/adapters/file-provisioner.ts:204` `readExistingSettings` | Ported, including the symlink and unparseable-file bail-outs.                                                                                                                                                                                                                 |
| `core/kinds.ts:54` `KIND_SPECS.assets`       | `packages/fleet/src/lib/assets.ts:35,43` `HARNESS_ASSETS`                    | Ported and **stricter**: kfleet silently dropped an asset its per-harness table had no destination for; `unsupportedAssetFields` (`assets.ts:61`) makes it a declared refusal at plan time (`plan.ts:162`).                                                                   |
| `core/kinds.ts:44` `wrapperEnv`, `:39` `bin` | `packages/fleet/src/lib/wrappers.ts:25,31`                                   | Ported.                                                                                                                                                                                                                                                                       |
| `core/kinds.ts:42` `defaultConfigDir`        | `packages/cli/src/lib/fleet/layout.ts:38`                                    | Ported.                                                                                                                                                                                                                                                                       |
| `deps.ts:6-23` path constants                | `packages/cli/src/lib/fleet/layout.ts:24` `resolveFleetLayout`               | Ported as a **pure function of the environment** rather than module-load-time globals. `FY_HOME` replaces `KFLEET_HOME`; the fleet lives under `<stateHome>/fleet` rather than `~/.kfleet`.                                                                                   |
| `deps.ts:26` `resolveAsset`                  | `packages/fleet/src/lib/paths.ts:40` `expandAssetPath`                       | Ported, pure, with the home supplied by the caller.                                                                                                                                                                                                                           |
| `util/format.ts`                             | `packages/cli/src/lib/fleet/ports.ts:9` `IFleetOutput` + `ConsoleIo`         | Ported behind a port.                                                                                                                                                                                                                                                         |
| `cli/shared.ts:4` `loadOrDie`                | commander's error path in `packages/cli/bin/fy.ts`                           | Ported.                                                                                                                                                                                                                                                                       |

### Behavioural deltas worth knowing (not gaps, but not identical)

- **Alias command names differ.** kfleet's `expandAliases` (`core/generate.ts:374`) names a command
  `${alias}-${agent.name}` — the alias _replaces_ the harness prefix, so `yolo` + `claude-auto-atomi`
  → `yolo-auto-atomi`. Ferretry's (`packages/fleet/src/lib/profiles.ts:222`) names it
  `${alias}-${account.wrapper}` → `yolo-claude-auto-atomi`. Existing muscle memory and any script
  calling the short form will not find the executable after a migration.
- **A lone settings _file_ layer is no longer passed through verbatim.** kfleet's
  `core/settings.ts:50` emits a single file-path layer as a link/copy, so comments and formatting in
  a shared `config.toml` template survive. Ferretry's plan always emits a `settings` operation when
  the stack is non-empty (`packages/fleet/src/lib/plan.ts:167`) and the provisioner parses and
  re-serializes it (`file-provisioner.ts:180`). Comments in a template are silently stripped. Not
  dangerous, but it is a fidelity loss nobody has recorded until now.
- **Shell quoting is deliberately different, and Ferretry's is safer.** kfleet quotes env values
  with a double-quoted string leaving `$` unescaped (`core/generate.ts:108`), so _every_ value can
  expand. Ferretry single-quotes literals and expands only a value that is _exactly_ `$NAME` /
  `${NAME}` (`packages/fleet/src/lib/wrappers.ts:36,52`), and guards an unset reference with an
  actionable message (`wrappers.ts:89`). A kfleet config whose literal value contains `$` will render
  differently after migration — correctly, but differently.
- **`prune` is no longer optional.** kfleet has `kfleet prune` and `kfleet apply --prune`
  (`cli/fleet.ts:20,65`). Ferretry always emits a prune operation from the plan
  (`plan.ts:136`), bounded to the bin directory and to files carrying the managed marker.

---

## 2. Generation and provisioning — PORTED

| kfleet source                                                | Ferretry carrier                                                                         | Notes                                                                                                                                        |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/generate.ts:164` `renderWrapper`                       | `packages/fleet/src/lib/wrappers.ts:101` `renderWrapperScript`                           | Ported; see quoting delta above.                                                                                                             |
| `core/generate.ts:346` `renderCommand`                       | `packages/fleet/src/lib/wrappers.ts:147` `renderCommandScript`                           | Ported.                                                                                                                                      |
| `core/generate.ts:188` `materializeAgent`                    | `packages/fleet/src/lib/plan.ts:155` `assetOperations` + `file-provisioner.ts:71`        | Ported and **split**: deciding is a pure plan, writing is an adapter, so `--dry-run` is the same code path minus the last step.              |
| `core/generate.ts:324` `resolveDefaultHomeTargets`           | `packages/fleet/src/lib/plan.ts:117` + `UnknownDefaultHomeError:56`                      | Ported.                                                                                                                                      |
| `core/generate.ts:374` `expandAliases`                       | `packages/fleet/src/lib/profiles.ts:217`                                                 | Ported (name shape differs, above).                                                                                                          |
| `core/generate.ts:391` `apply`                               | `packages/fleet/src/lib/provisioning.ts:108` `FleetApplyService`                         | Ported.                                                                                                                                      |
| `core/generate.ts:398-417` collision checks                  | `packages/fleet/src/lib/profiles.ts:252` `resolveCommands` + `WrapperCollisionError:235` | Ported and generalized (account/command/alias claimants all reported together).                                                              |
| `core/generate.ts:443` `prune`, `:360` `listManagedWrappers` | `file-provisioner.ts:156` `prune`                                                        | Ported; bounded twice (direct children only, marker required).                                                                               |
| —                                                            | `packages/fleet/src/lib/manifest.ts` (218 lines)                                         | **New in Ferretry.** kfleet published no manifest; consumers globbed the bin directory. This is the single largest capability Ferretry adds. |

### GAP — `AUTOTRUST` (`core/generate.ts:128-161`, 34 lines of generated shell)

Every kfleet Claude wrapper carries a launch-time shell block that seeds `.claude.json` so a fresh
config dir never stops to ask: `hasTrustDialogAccepted` per project, `hasCompletedOnboarding`,
`hasCompletedClaudeInChromeOnboarding`, `claudeInChromeDefaultEnabled`, and pre-approval of the
wrapper's own `ANTHROPIC_API_KEY` in `customApiKeyResponses.approved`. `KIND_SPECS.claude.autotrust`
(`core/kinds.ts:60`) is the switch; `CLAUDE_AUTOTRUST=0` disables it.

**Ferretry has no equivalent.** `renderWrapperScript` emits secrets sourcing, guards, the home export,
env exports and `exec` — nothing else.

**What is lost:** a freshly provisioned Ferretry Claude account, launched non-interactively (which is
the only way an agent fleet launches anything), stops at the folder-trust prompt and never reaches a
turn. This is the single highest-impact gap for anyone actually running the fleet.

### GAP — Codex shared-SQLite reconciliation inside `materializeAgent`

`core/generate.ts:36,63,86,96,203-258` implement a sidecar marker (`.kfleet-sqlite-home.json`) that
records whether kfleet injected `sqlite_home` into an account's `config.toml`, what was there before,
and whether kfleet created the file — so disabling sharing can remove **only** kfleet's own key and
leave a user-edited one alone. `RESERVED_ENV_NAMES` (`packages/fleet/src/lib/config.ts:54`) names
`CODEX_SQLITE_HOME`, so Ferretry knows the variable exists, but nothing writes or reconciles it.
Part of the shared-history gap below.

---

## 3. Shared history and Codex prewarm — GAP (557 lines, zero carried)

| kfleet source                                            | Ferretry carrier | What is lost                                                                                                                                                                              |
| -------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/kinds.ts:80,110` `sharedState` entry tables        | **GAP**          | The list of what is poolable per harness (transcripts, sessions, file-history, plans, tasks, todos, shell-snapshots, paste-cache, prompt history).                                        |
| `core/shared-history.ts:121` `materializeSharedHistory`  | **GAP**          | Migrating each account's session state into one per-harness pool and symlinking it back, so **any account can `--resume` any session**. Rename-based, so live sessions keep their inodes. |
| `core/shared-history.ts:65` `mergeDirInto`               | **GAP**          | Collision resolution by mtime with the loser preserved under `.migration-conflicts/`.                                                                                                     |
| `core/shared-history.ts:98` `mergeJsonlInto`             | **GAP**          | Timestamp-ordered dedup union of two prompt-history files.                                                                                                                                |
| `core/shared-history.ts:47` `ensureCodexSharedSqliteDir` | **GAP**          |                                                                                                                                                                                           |
| `core/codex-prewarm.ts:248` `prewarmCodexSharedSqlite`   | **GAP**          | Reconciling pooled Codex rollouts into the shared state DB over app-server JSON-RPC without an LLM call.                                                                                  |
| `core/codex-prewarm.ts:91` `acquireCodexPrewarmLock`     | **GAP**          | Cross-process exclusion via a SQLite `BEGIN EXCLUSIVE`.                                                                                                                                   |
| `cli/prewarm.ts:37` `createPrewarmCommand`               | **GAP**          | `kfleet prewarm codex`.                                                                                                                                                                   |

**The dangerous part is not the absence — it is the silence.** `sharedHistory` is a parsed,
strict-object field of `FleetConfigSchema` (`packages/fleet/src/lib/config.ts:311`). A configuration
that turns it on applies successfully and pools nothing. Closed by this unit — see below.

---

## 4. Harness liveness probing — GAP (538 lines)

This is one of the two the owner asked about by name.

| kfleet source                                                                   | Ferretry carrier                                                                                                                                                      | Notes                                                                                                                                                                                              |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/harness-probe.ts:370` `probeHarness`                                      | **GAP**                                                                                                                                                               | Launch the wrapper with a sentinel prompt in a disposable cwd; healthy = exit 0 **and** an exact-sentinel reply.                                                                                   |
| `core/harness-probe.ts:215` `harnessProbeCommand`                               | **GAP**                                                                                                                                                               | The exact cheap invocation per harness (`--bare` only when the auth mode preserves it; Codex keeps `config.toml` on purpose).                                                                      |
| `core/harness-probe.ts:186-189` failure classification                          | **GAP**                                                                                                                                                               | `rate_limited` / `authentication` / `timeout` / `launch` / `process_error` / `unexpected_reply` from output patterns.                                                                              |
| `core/harness-probe.ts:136,149` success cache                                   | **GAP**                                                                                                                                                               | 15-minute TTL, **successes only** — a failure is never cached.                                                                                                                                     |
| `core/harness-probe.ts:80` `sanitizeHarnessEnv`, `:97` `prepareHarnessProbeEnv` | **PORTED BY THIS UNIT** — `packages/fleet/src/lib/harness-env.ts`; the wrapper read is split into `referencedEnvNames` (pure) and `readFleetWrapperScript` (adapter). |
| `core/health.ts:75` `autoAgents`                                                | **GAP**                                                                                                                                                               | kfleet selects probe targets by the `auto-` name prefix; Ferretry declares `mode: 'auto'` on a route (`config.ts:147`), which is the better answer to the same question — but nothing consumes it. |
| `core/health.ts:83` `resolveAgentWrapper`                                       | **GAP on `main`**                                                                                                                                                     | See `fix/harness-preflight` below.                                                                                                                                                                 |
| `core/health.ts:98,137` `probeAgent`/`probeFleet`                               | **GAP**                                                                                                                                                               |                                                                                                                                                                                                    |
| `core/firstrun.ts:17` `seedFirstRunFlags`                                       | **GAP**                                                                                                                                                               | The jq-free TypeScript twin of `AUTOTRUST`, used by health and login so a probe on a fresh box is not blocked by an onboarding prompt.                                                             |
| `cli/health.ts:11`, `cli/doctor.ts:10`                                          | **GAP**                                                                                                                                                               | No `fy fleet health`, no `fy fleet doctor`.                                                                                                                                                        |

### Did PR #231 reimplement this, and do the two agree?

**No, and they do not conflict — but neither of them is kfleet's probe.**

- `feat/fleet-management` (PR #231, open, not merged) adds
  `packages/pwa/src/features/fleet/fleet-model.ts:41` `defaultFleetHarness()`. It is a **policy over
  supplied evidence**, not a detector: it picks Claude when a Claude harness has a non-empty
  `launchable` list, else Codex, else `undefined`. Its own comment requires callers to pass only
  harnesses with positive daemon evidence, and its `FleetReadState` (`:26`) makes "unavailable" a
  distinct state from "empty". There is nothing here that could disagree with kfleet, because it
  detects nothing.
- The detection lives on the sibling branch `fix/harness-preflight` (also not on `main`):
  `packages/daemon/src/lib/core/harness-readiness.ts:38` `accountLaunchability` and `:90`
  `readHarnessPreflight`. That is a **PATH resolution** — "the manifest declares this account
  available AND this host can resolve its wrapper name to an executable". Its doc comment states the
  limit explicitly (`:27-31`): a wrapper on PATH is not signed in, in credit, or able to reach its
  provider, and every message built from it says so.

So the answer to "two notions of 'is Claude installed' that can disagree" is: there is one notion of
_installed_ (PATH resolution, on `fix/harness-preflight`) and one notion of _alive_ (a real turn,
kfleet's, not ported). They are different questions and both branches say which one they answer. The
risk the owner was worried about has not materialised. **What is missing is the stronger fact**: no
Ferretry code path can tell you an account will actually complete a turn, and `renderHarnessPreflight`
(`harness-readiness.ts:151`) prints that limitation on every run rather than hiding it.

**Coordination note:** `packages/daemon/src/lib/core/harness-readiness.ts` belongs to the daemon
work in flight (`ferretry-wt-fleetd`). This unit did not touch it. If a real liveness probe is
ported, it should be a `packages/fleet` port consumed by both, not a third detector.

---

## 5. Usage and quota — the aggregation is PORTED, every provider call is a GAP

This is the other one the owner asked about by name.

### What is ported (and it is a good port)

| kfleet source                                            | Ferretry carrier                                                                             |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `core/usage.ts:993` `windowsToUsage` at-limit rule       | `packages/fleet/src/lib/usage.ts:140` `isAtLimit`                                            |
| `core/usage.ts:466` `corroborateAuthFailure` policy      | `packages/fleet/src/lib/usage.ts:153` `isCorroboratedAuthRejection`                          |
| `core/usage.ts:382` z.ai "sort windows by reset horizon" | `packages/fleet/src/lib/usage.ts:112` `normalizeUsageWindows`                                |
| `core/usage.ts:444` MiniMax `100 − remaining`            | `packages/fleet/src/lib/usage.ts:82` `usedPercentFromRemaining`                              |
| `core/usage.ts:869` `runProbes` bounded concurrency      | `packages/fleet/src/lib/usage.ts:336` `boundedMap`                                           |
| `core/usage.ts:912` `probeUsage` aggregation loop        | `packages/fleet/src/lib/usage.ts:172` `FleetUsageCollector.collect`                          |
| `cli/serve.ts:73` `renderUsageMetrics`                   | `packages/fleet/src/lib/usage.ts:243` `renderFleetUsageMetrics` — **exported, never called** |
| `cli/serve.ts:200` `/usage` JSON envelope                | `packages/fleet/src/lib/usage.ts:229` `renderFleetUsageJson` — **exported, never called**    |
| `cli/usage.ts:49` `createUsageCommand`                   | `packages/cli/src/lib/fleet/commands.ts:52` + `controller.ts:83` + `render.ts:87`            |

The Ferretry collector is also stricter in one place that matters: `collectAccount`
(`usage.ts:211`) refuses to set `atLimit` from a _failed_ probe. Only a successful reading or a
proven-unavailable state can exhaust an account. kfleet's `windowsToUsage` (`core/usage.ts:1018`)
has the same rule. Both fail open, deliberately.

### GAP — every provider probe (roughly 1,000 lines)

`FleetUsageProbe` (`packages/fleet/src/lib/usage.ts:36`) is a one-method port. Its only implementation
is `UnprovisionedUsageProbe` (`packages/cli/src/adapters/fleet/usage-probe.ts:11`), wired at
`packages/cli/bin/fy.ts:488`, which answers `unavailable` for every account.

| kfleet source                                                                                                                   | What is lost                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/usage.ts:306` `probeAnthropic`                                                                                            | Anthropic subscription quota via the stored OAuth credential.                                                                                                                                                                                                                                                          |
| `core/usage.ts:154` `probeAnthropicStoredToken`, `:142` `parseAnthropicStoredUsage`                                             | The read-only `GET /api/oauth/usage` call and its `five_hour`/`seven_day` unit (percentage points).                                                                                                                                                                                                                    |
| `core/usage.ts:245` `probeAnthropicExternalToken`, `:191,226` header parsing                                                    | The `max_tokens:1` inference probe for external tokens, and its quota headers (fractions in 0..1 — a different unit from the JSON endpoint, and mixing them is a 100× error).                                                                                                                                          |
| `core/usage.ts:333` `probeCodex`                                                                                                | ChatGPT-plan windows from `chatgpt.com/backend-api/codex/usage`.                                                                                                                                                                                                                                                       |
| `core/usage.ts:382` `probeZai`                                                                                                  | z.ai GLM coding-plan windows.                                                                                                                                                                                                                                                                                          |
| `core/usage.ts:487` `probeMinimax`, `:437` `classifyMinimaxBody`                                                                | MiniMax coding-plan windows, including that the endpoint returns HTTP 200 on a bad key and signals auth in `base_resp.status_code`.                                                                                                                                                                                    |
| `core/usage.ts:741` `classifyAgent`                                                                                             | Deciding an account's provider from its base URL / auth mode, and its **credential identity**.                                                                                                                                                                                                                         |
| `core/usage.ts:824` `planTargets`                                                                                               | **Deduplication by credential.** Many wrappers share one credential; kfleet probes each unique credential once and fans the result back out. Ferretry's collector probes **per account** (`usage.ts:173`), so a fleet with twelve wrappers on three accounts would make twelve provider calls where kfleet made three. |
| `core/usage.ts:624` `reloginExpiredOAuth`, `:566` `runRelogin`, `:534` `oauthNeedsRefresh`                                      | The pre-probe token-free refresh (`usage.relogin`).                                                                                                                                                                                                                                                                    |
| `core/usage.ts:885` `scanOAuthAuth`                                                                                             | Donor selection and per-member auth override (`usage.sync`).                                                                                                                                                                                                                                                           |
| `core/usage.ts:703` `createExternalCredentialResolver`                                                                          | Reading a declared secret from `~/.secrets` through a bounded shell without it entering argv or logs.                                                                                                                                                                                                                  |
| `core/usage.ts:122` `oauthTokenUsable`, `creds.ts:53` `jwtExpMs`, `creds.ts:7` `keychainSuffix`, `creds.ts:38` `readClaudeCred` | Local credential reading — macOS Keychain by config-dir hash, Linux `.credentials.json`.                                                                                                                                                                                                                               |
| `core/cliproxy-usage.ts:274` `probeCLIProxyUsage` (whole file, 308 lines)                                                       | Local CLIProxyAPI availability: runtime `available`/`unavailable` with a typed reason (`cooldown`/`spend_limit`/`auth`/`provider`/`no_credentials`) and a retry horizon. `CliProxySourceSchema` (`packages/fleet/src/lib/config.ts:208`) parses the configuration for it and nothing reads it.                         |

**What is lost in one sentence:** nothing in Ferretry can tell you an account is out of quota, so
nothing can route away from one.

### PARTIAL — `fy fleet usage` presentation

`packages/cli/src/lib/fleet/render.ts:87` `renderUsage` carries the per-row states (unavailable /
probe failed / pay-as-you-go / windows / AT LIMIT). Not carried from `cli/usage.ts`: the heat bars
(`:40`), the reset-time columns (`:14`), grouping by variant (`:96`), `--all`, `--concurrency`,
`--timeout`, `--no-relogin`, `--no-sync`, and `usageLimitSummary` (`:152`).

`usageLimitSummary` is the one worth calling out: it distinguishes three states — `at-limit`,
`unknown` ("no account was reported at limit; N verdicts are unknown"), and `confirmed-headroom`
("all tracked accounts have confirmed usage left"). Ferretry's controller warns only when _every_
account is at limit (`controller.ts:86`) and otherwise says nothing, so "no evidence of a limit"
and "proven headroom" render identically in the summary line. The per-row rendering does not hide
it, so this is a summary-level regression rather than a false green — but it is the same shape of
bug this migration has hit three times.

---

## 6. Login — PARTIAL, and the part that exists is unmounted

kfleet's login is not "run `claude /login`". It is: group every variant dir into an **identity**
(harness × base agent), read each dir's credential state, pick the freshest as **donor**, clone it to
the siblings, and only ask for an interactive OAuth round-trip for an identity with no usable
credential anywhere — and even then, only after proving the CLI is actually broken.

| kfleet source                              | Ferretry carrier                                                          | State                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/login.ts:331` `interactiveLogin`     | `packages/fleet/src/adapters/process-login.ts:18` `ProcessFleetLoginPort` | **PORTED**, and **mounted by this unit**. It was exported-but-uncalled until `fy fleet login` landed; it now also sanitizes the caller’s environment before spawning.                                                                                                                                                             |
| `core/login.ts:59` `isOAuth`               | `AuthModeSchema` (`config.ts:157`) + the `requiresLogin` predicate        | **PORTED, better** — declared rather than inferred from a base URL.                                                                                                                                                                                                                                                               |
| `core/login.ts:108` `scanIdentities`       | `packages/fleet/src/lib/profiles.ts:302` `groupByIdentity`                | **PARTIAL** — the grouping exists and is exported; **nothing calls it**, and it carries no credential state.                                                                                                                                                                                                                      |
| `core/login.ts:73` `credStatus`            | **GAP**                                                                   | Reading a dir's credential and classifying `valid`/`refreshable`/`missing`.                                                                                                                                                                                                                                                       |
| `core/login.ts:147` `pickDonor`            | **GAP**                                                                   |                                                                                                                                                                                                                                                                                                                                   |
| `core/login.ts:243` `syncIdentity`         | **GAP**                                                                   | **The whole point of `kfleet login`**: cloning one OAuth credential across an identity's dirs (macOS Keychain item per dir, Linux `.credentials.json`, Codex `auth.json`), plus `syncOauthAccount` (`:226`) so `/status` shows the right email. Without it, an operator logs in **once per wrapper** instead of once per account. |
| `core/login.ts:163` `filterLiveIdentities` | **GAP**                                                                   | Proving a credential-less CLI is actually broken before asking a human to click. Depends on the harness probe.                                                                                                                                                                                                                    |
| `core/login.ts:307` `resolveLoginTarget`   | **PARTIAL**                                                               | `ProcessFleetLoginPort:31` always spawns `account.wrapper`. kfleet falls back to the raw CLI on a fresh box where `apply` has not run, with a named error when the CLI is absent.                                                                                                                                                 |
| `cli/login.ts:214` `createLoginCommand`    | **PORTED BY THIS UNIT**                                                   | `--status`, `--sync-only`, `--no-probe` remain GAPs (they depend on the rows above).                                                                                                                                                                                                                                              |
| `cli/login.ts:28` `nonLoginStatus`         | **PORTED BY THIS UNIT** (as the `not-required` outcome)                   |                                                                                                                                                                                                                                                                                                                                   |

**Environment contamination — the concrete defect.** `ProcessFleetLoginPort` passed the caller's
environment straight to the spawn. A wrapper exports its own `CLAUDE_CONFIG_DIR`/`CODEX_HOME`, so the
_home_ was always right, but an `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_BASE_URL`
inherited from whichever agent session ran `fy fleet login` was **not** overridden — so the login
would validate against the wrong credential. kfleet has `sanitizeHarnessEnv` (`core/harness-probe.ts:80`)
for exactly this. Closed by this unit.

---

## 7. The background service — GAP (509 lines)

| kfleet source                                       | Ferretry carrier | What is lost                                                                                                                                                 |
| --------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cli/serve.ts:171` `createServeCommand`             | **GAP**          | The always-on HTTP server on `/metrics`, `/usage`, `/healthz`.                                                                                               |
| `cli/serve.ts:33` `scheduleJittered`                | **GAP**          | Self-rescheduling jittered re-probe: `usage.interval ± usage.jitter`, floored at 1s, next cycle scheduled only after the previous settles.                   |
| `cli/serve.ts:132` `refreshUsage`, `:156` `refresh` | **GAP**          | The cached probe cycles behind `/metrics`, so a scrape never triggers a real LLM call.                                                                       |
| `cli/serve.ts:43` `renderMetrics`                   | **GAP**          | The _health_ metrics (`kfleet_agents_up`, per-agent up/duration). The _usage_ metrics are ported (§5).                                                       |
| `cli/service.ts:227` `createServiceCommand`         | **GAP**          | `install`/`uninstall`/`status`/`restart` as a launchd user agent or systemd `--user` unit, sourcing `~/.secrets` without baking a secret into the unit file. |

**Answering the owner's second named question directly:** `usage.interval: 300` configures nothing.
There is no background re-probe loop in Ferretry, and — because there is no provider probe either
(§5) — there is no data for one to refresh. Before this unit nothing said so. A configuration naming
`usage.interval`, `usage.jitter`, `usage.relogin`, `usage.sync` or `usage.cliProxy` parsed cleanly
and applied cleanly.

**Coordination note:** a background loop in Ferretry belongs in the daemon as a mounted subsystem,
not in `fy`. `ferretry-wt-fleetd` is mounting fleet routes in the daemon; the `/usage` and `/metrics`
surfaces, and the loop behind them, are that unit's area. This unit did not build them. The two
renderers they would need are already in `packages/fleet/src/lib/usage.ts:229,243` and are called by
nothing today.

---

## 8. Scaffolding and diagnostics — GAP

| kfleet source                            | Ferretry carrier | What is lost                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli/init.ts:11` `createInitCommand`     | **GAP**          | `kfleet init` scaffolds `~/.kfleet` from bundled templates, never clobbering. Ferretry knows where the config _should_ be (`packages/cli/src/lib/fleet/layout.ts:43` `defaultConfigPath`) and nothing creates it, so a fresh host's first `fy fleet apply` fails with `invalid fleet config at …: file does not exist`. |
| `cli/doctor.ts:10` `createDoctorCommand` | **GAP**          | PATH check for the bin directory, config validity, and whether each harness binary is on PATH. The nearest thing is `renderHarnessPreflight` on `fix/harness-preflight`, which is daemon-scoped and answers a different question.                                                                                       |

---

## What this unit closed

Three gaps, chosen for value per line and for staying inside this unit's files. All three are landed
and gated; §§1–8 above are the state of `main` **before** them, except where a row says otherwise.

### A. `fy fleet login`, with the environment sanitized

- `packages/fleet/src/lib/harness-env.ts` — `sanitizeHarnessEnv`, a pure port of
  `core/harness-probe.ts:80`: strip provider/session state inherited from whichever agent launched
  the command, preserving any variable a wrapper explicitly references.
- `packages/fleet/src/adapters/process-login.ts` — the login spawn now sanitizes before spawning, and
  preserves the references the account's own wrapper depends on.
- `packages/cli/src/lib/fleet/commands.ts` + `controller.ts` — `fy fleet login [accountId…]` mounted,
  which turns `FleetLoginService` from exported-but-uncalled into a capability.

Still GAP after this: identity grouping with credential state, donor selection, credential cloning,
liveness-before-login, the raw-CLI fallback, `--status`. Rows in §6 are unchanged for those.

### B. A configuration that asks for an unimplemented capability is refused, not ignored

`packages/fleet/src/lib/capabilities.ts` — `unimplementedCapabilities(config)`, and
`FleetPlan.build` throws `UnimplementedFleetCapabilityError` naming each one. It fires only on a
value the operator had to _write_ (sharing turned on, a CLIProxy source declared, background health
probing enabled, a re-probe interval or jitter set) — never on a schema default — so an existing
working configuration still applies.

This is the "damaged state is not empty state" invariant applied to configuration: a fleet that
believes its sessions are pooled, or its quota is being watched, when neither is true, is worse than
one that is told plainly which key is not implemented.

### C. `usage.concurrency` and `usage.atLimitPercent` are honoured

They were parsed and dropped: `packages/cli/bin/fy.ts` constructed `FleetUsageCollector` with no
options, so a configured `atLimitPercent: 90` silently behaved as 100. The controller now builds the
collector from the loaded configuration.

---

## What was deliberately left

- **The provider probes (§5).** The largest gap by far and the one that would make `fy fleet usage`
  real. It is five providers, two credential stores, a keychain shell-out and a refresh dance — a
  unit of its own, and it needs the credential-identity model (§6) to dedupe correctly.
- **`AUTOTRUST` / `seedFirstRunFlags` (§2, §4).** High impact, and small. It was left because it
  writes `.claude.json` inside an account home and the right shape (wrapper-baked shell, a plan
  operation, or a `fy fleet apply` step) deserves a decision rather than a guess.
- **Shared history (§3).** Refused rather than ported: it is rename-based migration of live session
  state, and getting it wrong loses transcripts.
- **`serve` / the background loop (§7).** Belongs to the daemon unit in flight.
- **The alias naming delta and the settings-comment delta (§1).** Recorded, not changed: both are
  behaviour a migrating operator should be told about, and neither is a defect in Ferretry.
