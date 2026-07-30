# kteam → Ferretry migration plan

Status: **active** · Task: `&I25` · Date: 2026-07-30 · Author: migration lead

This plan is the execution contract for porting kteam and kfleet into Ferretry. It is binding on
every teammate. Where it conflicts with `docs/design/split-proposal.md` (historical), this plan
wins. Where it conflicts with `docs/PROMPT.md`, PROMPT.md's "Migration decisions" section and this
plan agree by construction — if you find a divergence, stop and raise it.

## 0. Safety rules — non-negotiable

1. **The live installation is production.** `~/.kteam`, the running `kteamd`, its tmux sessions
   and its ports run Kirin's entire agent fleet, including the teammates executing this plan.
   No unit may run `kteamd`, write under `~/.kteam`, kill tmux sessions it does not own, or bind
   kteam's ports. Porting is: read source, write new files.
2. **Ferretry's state home is `~/.ferretry`**, its ports are its own, and tests use a temporary
   `FY_HOME` — never the real one.
3. `kloge` and `loctl` stay external. Out of scope.
4. Public repo: no secrets, no personal data in code, docs, commit messages, or PR text.
5. Merge gate on `main`: `pre-commit run --all-files`, `task test`, and
   `nix develop .#releaser -c ./scripts/release/publish.sh --snapshot` all green.

## 1. Principles

### 1.1 Port capabilities, not behavior

kteam has plenty of bugs and we are not carrying them across. For every unit:

- The deliverable is **the capability working correctly**, not byte-equivalence with kteam.
- When source behavior is wrong, **fix it** and record the fix in the unit's PR description.
- **Never write a test that pins broken behavior.** Source tests are evidence of intent, not a
  contract. A source test that asserts a bug is deleted, and its intent re-expressed correctly.
- Where the correct behavior is genuinely unclear, implement the reasonable reading, note it in
  the PR, and move on. Do not stall on it.

### 1.2 Conform to the doctrine while porting

This is the central architectural decision, and it follows from 1.1: the reason to lift code
verbatim was fear of behavior drift, and drift is now acceptable when it means "less broken".

Every ported package obeys `docs/standards/`:

- **`src/lib/`** — pure decision logic. No `console`, no `process.*`, no IO, no imports from
  `adapters/`. Policy, parsing, rendering, state machines, scoring, validation.
- **`src/adapters/`** — all IO. tmux, filesystem, SQLite, HTTP/WS, process spawning, env reads.
- **composition root** — wires them; one command = one controller class taking ports via
  constructor.

The practical extraction rule for a large source module: **pull the decisions out of the IO.**
Anything that computes a verdict from inputs goes to `lib` and becomes unit-testable; anything
that talks to the world stays in `adapters` behind an interface. This is also the bug-finding
mechanism — the defects in kteam live in policy code that was never independently testable.

`scripts/validate/cli-contracts.sh arch` currently checks `packages/cli`. It must be extended to
check each new package as that package lands (unit S1 owns this). A package is added to the gate
in the same PR that creates it, never later.

### 1.3 No backward compatibility

- `FY_*` environment variables only. **No `KTEAM_*` reads anywhere.**
- No `kteam` / `kteamd` / `kfleet` shim wrappers.
- No read path, migration path, or dual-format reader for `~/.kteam`.
- `~/.ferretry`'s on-disk layout is **redesigned** where kteam's was poor (§5).
- kteam's `LegacyTaskScope` is dropped; central scope only.
- `migrate-preflight.ts` (1,036 lines) is presumed kteam-history migration and is **not ported**
  unless Survey C shows it does something else.

This is enforced mechanically, not by vigilance: unit S1 adds
`scripts/validate/no-legacy-state.sh` to pre-commit, failing on any occurrence of `KTEAM_`,
`.kteam`, `kteamd`, or `kfleet` as an identifier or path literal under `packages/`. Documentation
prose referencing the history is exempt via an explicit allowlist.

## 2. What we know about the source

Measured, not estimated:

| Source            | Files           | Lines          |
| ----------------- | --------------- | -------------- |
| `kteam-ts/src`    | 260 (128 tests) | 67.5k non-test |
| `kteam-ts/ui/src` | 336             | 98.7k          |
| `kfleet-ts`       | 41              | 6.9k           |

Largest source modules: `session-manager.ts` 9,201 · `task-boards.ts` 2,863 ·
`tmux-controller.ts` 2,371 · `analytics-index.ts` 2,061 · `storage.ts` 1,792 · `tasks.ts` 1,706 ·
`index.ts` 1,636 (CLI) · `api-server.ts` 1,460 · `attachments.ts` 1,308 · `fs.ts` 1,166 ·
`migrate-preflight.ts` 1,036 · `names-pool.ts` 1,023.

Three structural facts established by direct reading, which shape the plan:

1. **The CLI is a 1,636-line file with 72 inline `.action()` closures.** Ferretry's doctrine
   requires one controller class per command. The CLI port is therefore a decomposition, not a
   copy — but it is highly parallelizable, one command group per unit.
2. **The CLI shares code with the daemon today.** `index.ts` imports `ApiClient`,
   `DaemonService`, `createPaths`, `io`, `harness`, `tasks`, and the seven `*-cli.ts` modules
   (2,522 lines of parse/render). In a package split this coupling must be resolved deliberately
   — see §4.
3. **`session-manager.ts` is a god-module.** Its first 700 lines alone mix tmux picker quirk
   handling, five error classes, resume/revive policy, warden provenance, and ~20 buried tuning
   constants (`WEDGE_GAP_MS`, `INCOHERENT_RESTART_THRESHOLD`, `SELF_RESTART_COOLDOWN_MS`, …).
   Those constants are policy knobs hardcoded in source; extracting them into injected
   configuration is both the doctrine-conforming move and a prerequisite for handover item 47
   (configurable warden recovery policy).

Surveys in flight fill in the rest: **A** daemon dependency graph and per-file IO/state
classification; **B** the complete HTTP/WS API surface; **C** kfleet and every coupling point;
**D** the PWA structure and its single-daemon assumptions. Unit tables in §6–§8 are derived from
those and are marked as pending until they land.

## 3. Target topology

```
packages/protocol/  zod schemas for every wire type + typed client SDK   (shared: cli, pwa)
packages/daemon/    the fyd daemon                                        → bin fyd
packages/fleet/     fleet provisioning library + `fy fleet …` subcommands
packages/cli/       the fy binary (existing diene skeleton, extended)     → bin fy
packages/pwa/       the web app                                           → static dist
```

Current state: `packages/{protocol,daemon,fleet,pwa}` contain **only a README.md** — no
`package.json`, so despite the `packages/*` workspace glob they are not Bun workspace members
yet. Making them real is unit S1.

Renames throughout: `kteam`→`fy`, `kteamd`→`fyd`, `~/.kteam`→`~/.ferretry`, `KTEAM_*`→`FY_*`.

## 4. Resolving the CLI↔daemon coupling

kteam's CLI and daemon are one tree, so sharing was free. Ferretry's are separate packages, so
each shared thing needs a home. The rulings:

| Shared today                                                             | Goes to                              | Why                                                                                                  |
| ------------------------------------------------------------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Wire types (`SessionView`, `KTeamEvent`, task/pin/attention/board types) | `packages/protocol` as zod schemas   | One definition, validated on both ends, shared by cli and pwa                                        |
| `ApiClient` (508 lines, 33 methods)                                      | `packages/protocol` typed client SDK | It _is_ the client SDK; pwa needs the same calls                                                     |
| The seven `*-cli.ts` parse/render modules (2,522 lines)                  | `packages/cli/src/lib/` (pure)       | Pure argv→request and response→text. Textbook `src/lib`. Not the daemon's business                   |
| `DaemonService` (start/stop/install/logs)                                | `packages/cli/src/adapters/`         | The CLI manages a local `fyd` **process**; it must not import daemon internals                       |
| `paths` / `io` / `harness`                                               | Duplicated deliberately, narrowly    | Each package owns its own tiny path/IO adapter. A shared "utils" package would recreate the coupling |

The clean break: **`packages/cli` imports `packages/protocol` and nothing else from the
monorepo.** It reaches the daemon over HTTP and manages it as a process. This is an improvement
over kteam, where the CLI could reach into daemon internals.

## 5. `~/.ferretry` state home

Principles (carried over because they are sound): **files are authoritative, SQLite is a
disposable index** that can be deleted and rebuilt at any time.

Redesign requirements over kteam's layout:

- A `layout-version` marker file at the root. The daemon refuses to start on an unknown version
  rather than half-migrating. No legacy readers — there is exactly one version at launch.
- Session state under a stable per-session directory; the durable journal is the source of
  truth and every derived view is rebuildable from it.
- Configuration separate from state, so config can be version-controlled by the user without
  dragging runtime data along.
- The fleet manifest at `~/.ferretry/fleet/manifest.json` (§7).
- Nothing in the layout may require reading `~/.kteam`.

The exact directory tree is specified by unit F3 once Survey A reports what kteam actually
persists; F3's PR must include the tree as documentation.

## 6. Execution model: worktrees, PRs, merging

- **One unit = one git worktree = one branch = one PR.** Worktrees live outside the primary
  checkout; branches are named `port/<unit-id>-<slug>` (e.g. `port/f3-state-home`).
- No unit works in the primary checkout. That checkout is the lead's, for review and merge.
- **Ownership is per-file and exclusive across _open PRs_.** Separate worktrees make concurrent
  edits harmless, so the rule is not "never two agents per file" but **"never two open PRs
  touching the same file."** The ownership tables in §7–§8 are what make that checkable.
- **Rebase cadence:** rebase onto `main` before opening the PR, and again before requesting
  merge. A unit whose PR sits through two merges of others rebases again.
- **The lead merges.** Kirin has waived the usual "never merge yourself" rule for this program.
  Merge requires: CI green, the three gates green, ownership respected, and the PR description
  listing bugs fixed and behavior deliberately changed.
- **Concurrency ceiling: 6 open PRs.** Not a resource limit — a review-bandwidth and
  rebase-thrash limit. The spine (§7) runs at 1.
- A unit reports done by opening the PR and reporting its number. Claims of completion without a
  green PR are not completion.

## 7. The foundation spine (serial, lands first)

Small on purpose. Everything else rebases onto it.

| ID  | Unit                | Owns                                                                                                                                                                                                                                          | Depends      |
| --- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| S1  | Workspace + gates   | `packages/{protocol,daemon,fleet,pwa}/package.json`, tsconfigs, bunfig ledgers, `tasks/Taskfile.{test,compile}.yaml`, `scripts/validate/cli-contracts.sh` (arch per package), new `scripts/validate/no-legacy-state.sh`, `nix/pre-commit.nix` | —            |
| S2  | `packages/protocol` | every wire schema + the typed client SDK                                                                                                                                                                                                      | S1, Survey B |
| F3  | Daemon foundation   | the state-home layout, paths/io/fs adapters, storage + disposable index, daemon config                                                                                                                                                        | S1, Survey A |

S1 is deliberately alone: it touches root-level config that every other unit would conflict on.
S2 and F3 are independent of each other and may run concurrently once S1 merges.

### 7.1 The fleet manifest — now specified against measured facts

Survey C located **40 production coupling sites**. The important discoveries change the shape of
this work:

**The wrapper-text grepping is tiny.** There are exactly **two** readers — `harness.ts:18-27`
(regexes `export CLAUDE_CONFIG_DIR=` / `export CODEX_HOME=`) and `harness.ts:29-35` (regexes
`export KTEAM_MODEL=`) — with exactly **four** call sites, all in `session-manager.ts`
(2193, 2215, 4070, 4075). Replacing shell-text parsing with a manifest read is therefore a
surgical change, not a sweep. This is the single cheapest high-value decoupling in the migration.

**The same knowledge is hardcoded in four places.** `fleet-inventory.ts:35-71` (runtime model
allowlist), `core.ts:23-55` (wrapper→served-model aliases), `core.ts:334-405` (recommendation
doctrine allowlist + bans), `ui.ts:120-122` (a third wrapper→model regex table). Four tables that
must agree and have no mechanism forcing them to. The manifest is the single source; all four are
deleted.

**A live bug proves why.** `kfleet/config.yaml:66-70` declares Fable down on the loge pool (every
credential returning HTTP 429; the alias was removed and the default fell back to Opus 5). But
`fleet-inventory.ts:42-47,67` still offers `claude-fable-5[1m]` for that account and
`core.ts:361-369` still ranks it the **first/default** recommendation. Config says unavailable;
two hardcoded tables say available, and the recommender confidently routes work to a model that
cannot serve. Exactly this defect misrouted the first planner in this migration. The manifest
design must make that state unrepresentable.

**The deep coupling is the primary key, not the parsing.** Wrapper _filenames_ are the join key
across five subsystems — usage feed rows, installed wrappers, warden config, model tables, and
session config are all matched by byte-identical basename (C19, C26). Account names may contain
arbitrary strings, so hyphens are ambiguous, and aliases replace the kind prefix
(`auto-atomi` → `crc-auto-atomi`, not `crc-claude-auto-atomi`), which is why kteam's inventory
silently skips aliased wrappers. **Ruling: the manifest gives every account a stable opaque `id`
and that id is the only join key. The wrapper path, resolved name, and display name become
attributes.** Name grammar (`^(claude|codex)-auto-`) stops being load-bearing.

Manifest at `~/.ferretry/fleet/manifest.json`, written by `fy fleet apply`; per account:
`{id, kind, mode, wrapper, home, displayName, defaultModel, models[], available, unavailableReason}`.
Availability is **declared in the manifest**, so a model that config says is down cannot be
offered or recommended.

### 7.2 The usage collector must serve two contracts

`kfleet serve` on `:47318` has four production consumers, two of them **external tools that stay
behind**:

| Consumer                  | Endpoint   | Notes                                                           |
| ------------------------- | ---------- | --------------------------------------------------------------- |
| kteam daemon              | `/usage`   | cached, falls back to spawning `kfleet usage --json`            |
| `kteam recommend`         | `/usage`   | independent feed, same fallback                                 |
| **kloop**                 | `/usage`   | only when `requireUsageLeft:true`; hard-gates, fails open       |
| **khost**-generated Alloy | `/metrics` | Prometheus scrape of `host.docker.internal:47318`, job `kfleet` |

So the daemon-internal collector must expose **both** `/usage` (JSON `{at, accounts[]}`) and
`/metrics` (Prometheus text, ~17 series labelled by binary/kind/provider/account), plus
`/healthz`. The two internal consumers collapse into one in-process feed; the two external ones
need a stable HTTP surface. Ferretry serves these on its own port and the external tools are
re-pointed at cutover — no shim, per §1.3.

Note for operations: at survey time **nothing was listening on `:47318`**, so kloop's usage gate
is currently failing open and khost's `kfleet` scrape job is down. That is a pre-existing
condition of the live system, not something this migration caused.

Schemas land in S2; the writer and collector in the fleet units; **no consumer may read a shell
script or a hardcoded table.**

## 8. Wave units

Survey A measured the 132 non-test source files. Two facts make this tractable:

- **Only two import cycles exist** — `core.ts ↔ usage.ts` and `service.ts ↔ session-manager.ts` —
  and in both the back-edge is **type-only**. Both dissolve by moving types into
  `packages/protocol`. A 132-file graph with two trivially-breakable cycles is unusually clean and
  means units can be ordered without untangling knots.
- **The whole type layer is leaf-only.** The eleven `*-types.ts` files plus `types.ts` — 3,039
  lines, 295 exports, **zero IO and zero module state in every one** — import nothing internal
  while being the graph's biggest hubs (`types.ts` in-degree 34). They are `packages/protocol`,
  and they can be ported first with no dependency risk.

Hub ranking (in-degree): `types.ts` 34 · `paths.ts` 32 · `io.ts` 25 · `tasks-types.ts` 14 ·
`browser-types.ts` 11 · `attention-types.ts` 10 · `core.ts` 10 · `service.ts` 10.

### 8.1 Concern families, measured

kteam's file naming is concern-prefixed, so the families _are_ the natural unit boundaries:

| Family                               | Files |    LOC | Wave        |
| ------------------------------------ | ----: | -----: | ----------- |
| `session-*` (manager + store)        |     2 |  9,832 | 4           |
| foundation/core                      |    12 |  7,637 | spine + 4   |
| `tasks-*` + `task-*`                 |    15 | 10,810 | 2           |
| `browser-*`                          |    10 |  4,960 | 3           |
| `stt-*`                              |     8 |  3,225 | 3           |
| `attention-*`                        |     8 |  3,112 | 2           |
| `analytics-*`                        |     4 |  2,599 | 2           |
| `tmux-controller`                    |     1 |  2,371 | 3           |
| `warden-*`                           |     8 |  2,163 | 4           |
| `api-*` (server + client)            |     2 |  1,968 | spine + 4   |
| `codex-*` + `claude-*` transcript    |     3 |  2,663 | 3           |
| `terminal-*`                         |     5 |  1,451 | 3           |
| `learning-*`                         |     5 |  1,450 | 2           |
| `attachments` + `document` + `pdf-*` |     4 |  1,996 | 3           |
| `pins-*`                             |     6 |  1,235 | 2           |
| `daemon-*`                           |     6 |  1,184 | 4           |
| `names-*`                            |     2 |  1,090 | 2           |
| `push-*` + `notification`            |     8 |    998 | 2           |
| `worktrees`                          |     1 |    774 | 2           |
| `migrate-*`                          |     2 |  1,325 | **dropped** |
| long tail (singles)                  |   ~20 | ~4,000 | 2–4         |

`migrate-*` is dropped per §1.3 — 1,325 lines we do not port.

### 8.2 The spine, now sized

| ID  | Unit                | Source → destination                                                        |    LOC |
| --- | ------------------- | --------------------------------------------------------------------------- | -----: |
| S1  | Workspace + gates   | no ported code; repo config + two gates                                     |      — |
| S2  | `packages/protocol` | the 11 `*-types.ts` + `types.ts` → zod schemas; `api-client.ts` → typed SDK | ~3,550 |
| F3  | Daemon foundation   | `paths.ts` 101 + `io.ts` 35 + `version.ts` 15 + `storage.ts` 1,792          | ~1,943 |

The spine is small on purpose and it really is small: `paths.ts` is 101 lines and `io.ts` is 35.
Only `storage.ts` (1,792, fs + SQLite + env) carries weight, and it is where the
files-authoritative / index-disposable split gets re-established.

### 8.3 Decomposition rules for the wide waves

1. One family = one unit, unless it exceeds ~2,500 lines, in which case split by sub-concern.
   `tasks-*`/`task-*` (10,810) splits into tasks-core, tasks store, task-boards, and the
   parse/render pair. `browser-*` (4,960) splits into control and transport.
2. **`session-manager.ts` is not a unit.** 9,832 lines across two files split by concern:
   session lifecycle · resume/revive policy · wedge and health detection · warden provenance ·
   harness-quirk handling (the Codex picker). The ~20 buried tuning constants
   (`WEDGE_GAP_MS`, `INCOHERENT_RESTART_THRESHOLD`, `SELF_RESTART_COOLDOWN_MS`, …) lift into
   injected configuration — which _is_ handover item 47, so the port and the feature are one job.
3. **The CLI is split by command group** — daemon, task, task-board, pin, attention, browser,
   start, ps/status/send/reply/answer, name, analytics, stop — one unit each, one controller class
   per command, everything reaching `packages/protocol` only (§4).
4. **The PWA** splits per Survey D's directory map, with the **56 single-daemon assumption sites**
   (2 Vite proxy bindings + 54 runtime bindings/stores/caches) collected into one dedicated unit
   that lands _before_ any PWA feature unit.
5. Each unit's brief carries its exact file list, derived from `daemon-deps.tsv` at authoring
   time, so ownership stays exclusive across open PRs. The unit must verify that list against the
   source before writing anything.
6. Tests: the 128 source test files travel with their subject. Pure logic lands in the unit tier,
   adapters in the integration tier, per §9. Source tests asserting buggy behavior are deleted and
   their intent re-expressed (§1.1).

## 9. Verification without touching the live fleet

This is load-bearing. A port is proven by:

- **Temporary `FY_HOME`.** Every test allocates a temp dir and points `FY_HOME` at it. A test
  that reads the real home is a bug in the test.
- **A fake tmux.** A stub executable placed on `PATH` that records the commands it receives and
  replays scripted output, so tmux control logic is asserted on the _commands issued_ rather than
  by driving a real server. The real tmux is never invoked in tests.
- **Recorded transcripts as fixtures.** Copy representative transcript files (redacted) into
  `tests/fixtures/`; parsers are asserted against them.
- **The `no-legacy-state` gate** (§1.3) makes "did we accidentally reach into `~/.kteam`" a
  build failure rather than a hope.
- **Tier discipline** per `docs/standards/testing`: pure policy in `src/lib` → unit tier with a
  full ledger; adapters → integration tier against fakes and temp dirs; whole-CLI journeys →
  SIT through the compiled binary.
- The daemon is never started against the real state home in CI. Where an end-to-end check is
  genuinely needed, it runs against a temp `FY_HOME` on a port drawn from an ephemeral range.

## 10. Phase 3 — mapping the handover backlog

Mapped onto the new topology; hard dependencies from `handover.md` preserved. Item numbers are
stable and never renumbered.

| Area                               | Items                                          | Lands in                        |
| ---------------------------------- | ---------------------------------------------- | ------------------------------- |
| Recovery / lifecycle / warden      | 47, 48, 44, 30, 31, 14, 26                     | daemon (+ fleet for 30)         |
| Attention                          | 8, 10, 11, 12, 17, 40                          | daemon + protocol + pwa         |
| Search / navigation / surfaces     | 6, 15, 34, 35, 36, 37, 38, 41, 45, 63          | pwa (35 is the structural gate) |
| Projects & worktrees               | 69, 68                                         | daemon + protocol + pwa + cli   |
| Composer / references / transcript | 16, 18, 20, 23, 28, 32, 33, 39, 43, 49, 64, 65 | pwa + protocol (16 is the gate) |
| Analytics                          | 13, 42, 66, 28                                 | daemon + pwa                    |
| Files & attachments                | 9, 62                                          | daemon + pwa                    |
| PWA / mobile                       | 29                                             | pwa                             |
| Reliability / workflow             | 3, 4, 5                                        | repo tooling + pwa (5)          |

Notes that change the backlog:

- **Items 47/48/67 are not greenfield.** The tree-scoped shared board already exists in kteam:
  `task-boards.ts` (2,863 lines) provides `TaskBoardService`, external invitation
  request/approve/accept, child grants, membership relinquish, and coordinator replacement;
  `task-boards-cli.ts` exposes `membership` / `invite` / `invite-approve` / `invite-accept`;
  `api-server.ts` carries the ACL transport. These items build on the **ported** capability
  (minus `LegacyTaskScope`).
- **Item 31** ("run the daemon from stable snapshots") is partly satisfied by construction: the
  daemon becomes a compiled binary artifact rather than live source.
- **Items 3 and 4** (gitlint in worktrees, untracked files hidden) are repo-tooling fixes that
  the worktree-heavy execution model in §6 will hit immediately. They are pulled **forward** —
  landing them early pays for itself across every subsequent unit.
- **Items 16 and 35** are structural gates for large clusters (references everywhere; unified
  side-pane tabs). They are scheduled before the items that depend on them, per the hard-dep
  column.
- The remote-access architecture (pairing, device tokens, ws tickets, CORS, link adapters) from
  `split-proposal.md` §5–6 is phase-3 work in `daemon` + `protocol` + `pwa`.

## 11. Risk register

| Risk                                                                 | Mitigation                                                                                                                                              |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A unit damages the live fleet (`~/.kteam`, tmux, ports)              | §0 in every brief; the `no-legacy-state` gate; temp `FY_HOME` in tests; fake tmux; no unit ever runs a daemon                                           |
| Decomposing `session-manager.ts` silently loses a behavior we wanted | Split by concern with the policy extracted to testable `lib`; each sub-unit's PR lists what it dropped and why                                          |
| Two PRs collide on one file                                          | Exclusive per-file ownership across open PRs; concurrency ceiling of 6; rebase before merge request                                                     |
| Rebase thrash as `main` moves                                        | Tiny serial spine first; wide waves only after S1/S2/F3 land; rebase cadence in §6                                                                      |
| "Fix the bugs" becomes unbounded refactoring                         | A unit fixes bugs **in the code it owns**; anything else is filed, not fixed. Scope creep is a review rejection                                         |
| CI time grows past usefulness as the monorepo fills                  | Per-package test scoping from S1; watch wall-clock per wave and shard when a single job exceeds ~10 min                                                 |
| Protocol churn invalidates cli and pwa work simultaneously           | S2 lands before dependent waves; schema changes after that are their own units with both consumers updated                                              |
| A survey's facts are wrong and poison a unit                         | Units verify their own file list against the source before writing; the lead spot-checks claims (already caught one wrong claim about the shared board) |

## 12. Open questions for Kirin

1. **PWA hosting** — central origin and domain (affects the pairing URL and CORS allowlist).
2. ~~Does anything besides Kirin consume the `:47318` usage feed?~~ **Answered by Survey C**: yes
   — kloop (`/usage`, gated) and khost's Alloy (`/metrics`, Prometheus). Both stay external and
   are re-pointed at cutover; the collector serves both contracts (§7.2). No decision needed.
3. **How much of kteam's history matters?** This plan drops `LegacyTaskScope` and
   `migrate-preflight.ts` entirely, meaning existing kteam sessions, tasks, and boards do **not**
   carry over. Ferretry starts empty. Confirm that is intended.
