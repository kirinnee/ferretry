---
id: daemon-plugins
title: Daemon feature modules — splitting fyd.ts so features stop colliding
---

# Daemon feature modules — splitting `fyd.ts` so features stop colliding

**Status: PROPOSED (plan only). This document changes no code.**
**Measured on `origin/main` at `c7e6beda1` (`release: 4.285.0`), 2026-11-06.**
**Runs in a quiet window after &C51 (Biome reformat) and &C52 (compat removal) have landed.**

The owner asked:

> consider refactoring into a better system, following @docs/standards/ folder, and build in plugin mode,
> so less conflict (and less rebuilds) are needed.

"Plugin" here means **compiled-in feature modules**, not third-party code. Nothing is loaded at
runtime and nothing a user writes runs in the daemon. Third-party plugins are a separate question, and
`docs/design/plugin-system.md` answers it. This plan does not change that answer.

---

## 0. The answer in six lines

1. **Each feature becomes one module file**: `packages/daemon/bin/modules/<id>.ts`. It builds its
   services and returns its routes, socket routes, background jobs, daemon features and shutdown steps.
2. **`fyd.ts` becomes wiring only.** It builds each module, passes it the other modules it needs, and
   hands everything to one composer. Target: under 1,500 lines (today it is 15,795).
3. **The shared lists become per-module.** These are the route table, the route-caller and audit
   contract lists, the `DAEMON_FEATURES` list and the knip entry list. Each module owns its own
   piece, and a completeness test proves no piece is lost (§4).
4. **Order: 4 prerequisite PRs, then one PR per module (38).** Behaviour stays the same. Each PR is
   proven by the existing suites, plus a byte-identical route-table snapshot.
5. **Expected effect:** of the 221 PR pairs that were open at the same time and both edited
   `fyd.ts` since 2026-11-01, **89–123 (40–56%) would no longer share a file**. Knip edits drop by
   67 of 72 commits, and `DAEMON_FEATURES` clashes drop from 39 pairs to 10 (§7).
6. **Two owner decisions** are in §10. Each has my pick.

---

## 1. The problem, measured

`packages/daemon/bin/fyd.ts` is 15,795 lines. Almost all of it sits in four places:

| Region                               | Lines       | What it is                                                                                  |
| ------------------------------------ | ----------- | ------------------------------------------------------------------------------------------- |
| `buildWorld()`                       | 7773–14345  | One 6,573-line function that builds every adapter and service                               |
| └ `createSubsystems` closure         | 9914–14308  | 4,395 lines, 231 `const`/`let` declarations, building all 118 fields of `MountedSubsystems` |
| `start()`                            | 14346–15385 | The boot: lock, config, address, bind, mount, 34 ordered cleanups, jobs                     |
| `DaemonWorld` interface              | 1582–2181   | 600 lines of test seams, one or more per feature                                            |
| 31 `create*` helpers and their types | 2246–7772   | Per-feature factories that already exist but sit in the shared file                         |

Shared files that features must hand-edit, by number of non-release commits from 2026-11-01 to
`c7e6beda1` (372 commits in total; `git log --since=2026-11-01 --no-merges -- <file>`):

| Shared file                                                  | Commits | Why a feature touches it                                              |
| ------------------------------------------------------------ | ------: | --------------------------------------------------------------------- |
| `packages/daemon/bin/fyd.ts`                                 |      92 | Its wiring, its seam and its factory all live here                    |
| `knip.json`                                                  |      72 | Each new PWA harness/fixture is listed by hand (83 of 90 added lines) |
| `packages/daemon/tests/unit/runtime/mounts/surface.test.ts`  |      41 | The whole-table route contract                                        |
| `packages/protocol/src/lib/daemon-features.ts`               |      39 | One object literal; every new name goes at the end                    |
| `packages/daemon/tests/unit/runtime/mounts/route-callers.ts` |      35 | One reviewed line per route                                           |
| `scripts/validate/route-agreement-allowlist.txt`             |      29 | Route drift exemptions                                                |
| `packages/daemon/src/lib/runtime/mounts/index.ts`            |      28 | `MountedSubsystems` (118 fields) and the ordered route list           |
| `packages/daemon/tests/unit/audit/not-audited.ts`            |      24 | Audit exemptions per route                                            |

These numbers differ a little from the brief's (88 of 496) because they come from a different
window and filter. The method is in §7.

**Why this costs so much.** Two PRs that both append to the same list, or both edit `buildWorld`,
conflict even when the features have nothing in common. Each conflict means a rebase, a re-push and
a full CI re-run (about 12 minutes on the last green `main` run, 42143288011).

**The feature code is already modular.** `src/lib/<feature>/` and `src/adapters/<feature>/` are
already split cleanly (81 feature folders), and each feature already has a mount file in
`src/lib/runtime/mounts/`. Only the **composition** is still one file. So this is a composition-root
refactor, not a domain rewrite.

---

## 2. What the doctrine requires, and how this design meets it

| Doctrine                                                      | Requirement                                                                                                                | How the design meets it                                                                                                                                                                                                                       |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Three-Layer](../standards/three-layer-architecture/index.md) | `src/lib` is pure (enforced by `cli-contracts.sh arch`); wiring lives in `bin/`                                            | Module **types** go in `src/lib/runtime/modules.ts` (pure). Module **wiring** goes in `bin/modules/<id>.ts`, which is the composition layer and may import both `lib` and `adapters`.                                                         |
| [Stateless OOP + DI](../standards/stateless-oop-di/index.md)  | Constructor injection; **no service locator**; the graph is visible in one place                                           | A module gets its dependencies through a typed `build(needs)` parameter. `fyd.ts` passes them explicitly, so the dependency graph is still readable in one file and checked by the compiler. No registry looks anything up by name (§10, D1). |
| [Fact Ownership](../standards/fact-ownership/index.md) R1/R2  | A fact two programs share has one owner in `@ferretry/protocol`; a second list must be proven **complete**, not just sound | `DAEMON_FEATURES` stays in protocol (the PWA reads it too) and is split by area. The daemon proves that the union of module claims equals `daemonFeatureList()`, so nothing is missing and nothing is invented.                               |
| [Architecture](../standards/architecture/index.md)            | The app ships before the daemon; features are gated by name                                                                | No change to the wire. `/v1/health › features` reports the same set, and a test pins it.                                                                                                                                                      |
| [cli-authoring](../../.claude/skills/cli-authoring/SKILL.md)  | One composition root; `if (import.meta.main)` guard; tests import factories                                                | `fyd.ts` stays the one root, and its exports (`buildWorld`, `start`, `WorldSeams`) keep their names and shapes, so the 19 test files that import it are unchanged.                                                                            |

---

## 3. The module interface

### 3.1 Types (pure, `packages/daemon/src/lib/runtime/modules.ts`)

```ts
import type { DaemonFeature } from '@ferretry/protocol';
import type { ApiRoute } from '../api/route.ts';
import type { SocketRoute } from '../api/socket.ts';

/** Undoes something a module started. Shutdown runs these in reverse build order. */
export type Release = () => void | Promise<void>;

/** Work that keeps running after the boot. `label` is the ActivityLedger name, so a stall names it. */
export interface BackgroundJob {
  readonly label: string;
  /**
   * When `start` arms it. These map one-to-one onto today's boot points, so the order stays the same:
   *   'mounted'    — once every route is served (auto-resume, the declared-wait monitor, the observer)
   *   'lane'       — submitted to the BackgroundLane (`fyd.ts:15204-15256`: fleet refresh, analytics, terminal reaper)
   *   'ready'      — after the warden is armed, before `progress.finish()` (handover reconcile, GitHub watcher,
   *                  daemon update, send tracking, queue delivery — `fyd.ts:15338-15363`)
   */
  readonly when: 'mounted' | 'lane' | 'ready';
  readonly arm: () => Release | Promise<Release>;
}

/** Everything one module adds to the daemon. Every field is optional: a module adds only what it has. */
export interface ModuleContribution {
  readonly routes?: readonly ApiRoute[];
  readonly sockets?: readonly SocketRoute[];
  readonly jobs?: readonly BackgroundJob[];
  /** Protocol feature names this module serves. The health report sends their union (§4.3). */
  readonly features?: readonly DaemonFeature[];
  readonly release?: readonly Release[];
}

/** A built module: what other modules may use (`provides`) and what the host mounts (`contributes`). */
export interface BuiltModule<Provides> {
  readonly id: string;
  readonly provides: Provides;
  readonly contributes: ModuleContribution;
}

/**
 * A feature module.
 *  - `Seams`: the production adapters a test may replace. These are today's per-feature `DaemonWorld`
 *    fields (a tmux runtime, a browser launcher, a clock). They are built by `buildWorld` and do no IO.
 *  - `Needs`: what the module needs at boot. That is the opened storage, the decided config and the
 *    `provides` of the modules it depends on, all as typed fields.
 */
export interface DaemonModule<Seams, Needs, Provides> {
  readonly id: string;
  readonly seams?: (host: HostSeams) => Seams;
  readonly build: (needs: Needs, seams: Seams) => BuiltModule<Provides> | Promise<BuiltModule<Provides>>;
}
```

These types follow the stateless rules. `BuiltModule` is a readonly structure, and `build` is a
function of its inputs. A module **never** reaches for another module except through `needs`.

### 3.2 One module, concretely (`packages/daemon/bin/modules/learning.ts`)

The pattern already exists. `createLearningSubsystem(parts: LearningSubsystemParts)` at
`fyd.ts:7240` is a module in everything but name. The pilot PR turns it into:

```ts
export interface LearningNeeds {
  readonly paths: FoundationPaths;
  readonly files: StateFileSystem;
  readonly clock: SystemClock;
  readonly sessions: SessionsProvides; // from the sessions module
  readonly configFiles: ConfigFilesProvides; // from the config-files module
  readonly analytics: Pick<AnalyticsProvides, 'pricing'>;
  readonly userHome: string;
}

export const learningModule: DaemonModule<void, LearningNeeds, LearningSubsystem> = {
  id: 'learning',
  build: needs => {
    const subsystem = createLearningSubsystem(/* the body that is at fyd.ts:7240 today, unchanged */);
    return {
      id: 'learning',
      provides: subsystem,
      contributes: {
        routes: learningRoutes(subsystem /* , … exactly the arguments mountedDaemonRoutes passes today */),
        features: [],
      },
    };
  },
};
```

### 3.3 The host (`fyd.ts`, wiring only)

```ts
// inside start(), after storage is open and the address is decided — the kernel half is unchanged
const configFiles = configFilesModule.build({ storage, paths, changes }, world.modules.configFiles);
const sessions = await sessionsModule.build(
  { storage, paths, health, configFiles: configFiles.provides },
  world.modules.sessions,
);
const agenda = agendaModule.build({ storage, sessions: sessions.provides, push: pairing.provides.push }, undefined);
const board = boardModule.build({ storage, agenda: agenda.provides, sessions: sessions.provides }, world.modules.board);
const learning = learningModule.build(
  {
    paths,
    files,
    clock,
    sessions: sessions.provides,
    configFiles: configFiles.provides,
    analytics: analytics.provides,
    userHome,
  },
  undefined,
);
// … one line per module, in the order the dependencies require

const host = composeModules(kernel, [pairing, access, reach, configFiles, sessions, agenda, board, learning /* … */]);
surface.mount(host.dispatcher, host.socketDispatcher);
```

`composeModules` (pure, in `src/lib/runtime/modules.ts`) takes over the job of `mountedDaemonRoutes`
and `mountedSocketRoutes`:

- It **concatenates** every module's routes and sockets.
- It **orders** them by route specificity. This is the D2 pick; the order step is the only behaviour
  question in this plan.
- It **wraps** the whole table in today's cross-cutting layers, in today's order: the session
  addressing layer, the audit layer and the agent-control layer (`mounts/index.ts:563-567`), then
  `configAnnouncedRoutes` and `observedRoutes` (`:868-871`). These stay in the kernel. They are not
  features; they are the dispatcher.
- It **unions** `features`, **groups** `jobs` by `when` (keeping each group in module order), and
  **stacks** `release` in reverse.

### 3.4 What stays in the kernel (not a module)

Boot and shutdown stay in `start()` under the kernel: state-home lock, config load, address decision,
bind, `StagedApiSurface`, the event-loop meter and watchdog, `BackgroundLane`, and the cleanup stack.
Also kernel: `api/`, `core/`, `runtime/`, `performance/`, `legacy-wire/`, health and doctor. That is
about 1,850 lines today, and it is the part of `fyd.ts` that should be left.

---

## 4. Making the shared lists per-module

### 4.1 Routes and sockets

`MountedSubsystems` (118 fields) and the hand-ordered route list in `mounts/index.ts` both go away.
Each module returns its own routes in `contributes.routes`.

### 4.2 Route contract lists (callers, audit, surface)

Today `ROUTE_CALLERS`, `NOT_AUDITED` and `AUDITED_ROUTES` are each one reviewed file. They become one
fragment per module, kept beside that module's tests:
`packages/daemon/tests/unit/modules/<id>/route-contract.ts`. Each fragment exports
`{ callers, notAudited }` for that module's routes only.

`surface.test.ts` keeps its whole-table checks, but it builds the expected table by
**concatenating the fragments**. It then asserts that:

1. every mounted route appears in exactly one fragment, and
2. every fragment line names a mounted route.

That is the R2 completeness proof the lists have today, and the review stays a diff a person reads.
The difference is that the diff lands in the module's own file.

`scripts/validate/route-agreement-allowlist.txt` is a list that only shrinks, so new features do not
append to it. It stays as it is.

### 4.3 `DAEMON_FEATURES`

`DAEMON_FEATURES` is a fact the PWA and the daemon share, so under
[Fact Ownership](../standards/fact-ownership/index.md) R1 its owner stays `@ferretry/protocol`. The
change is how the file is laid out:

- Split it into `packages/protocol/src/lib/daemon-features/<area>.ts` (`agenda.ts`, `board.ts`,
  `catalogs.ts`, …). Each file exports one `as const` fragment.
- `daemon-features/index.ts` spreads the fragments into the same `DAEMON_FEATURES` object, with the
  same keys and values. That index changes only when a whole new area is added, not when a feature
  is added.
- A protocol unit test fails if two fragments use the same key or the same wire value.
- On the daemon side, each module lists the names it serves in `contributes.features`. A daemon unit
  test asserts that the union of those lists equals `daemonFeatureList()`. A feature nobody claims
  fails the test (completeness). So does a claim protocol does not know (soundness).
- The health report stays `daemonFeatureList()`, so the bytes on the wire do not change.

### 4.4 `knip.json` — use naming conventions, not a generator

Every daemon entry is already a glob. The churn is all in the PWA workspace: 83 of the 90 entries
added since 2026-11-01 were harness screenshots/pages or integration scenes. Two globs cover 235 of
the 271 PWA entries today:

```json
"harness/*-{screenshot,page}.{ts,tsx}",
"tests/integration/fixtures/*-scene.tsx"
```

**67 of the 72 commits** that edited `knip.json` would not have needed to. The other 36 entries stay
listed by name (benches, smoke scripts, `fy-render-shell`).

Knip's `files: error` rule keeps the convention honest. A harness file whose name does not match the
glob, and that nothing imports, fails knip loudly. That is why a generator is not needed.

### 4.5 The barrels

`src/lib/index.ts` (149 `export *` lines) and `src/adapters/index.ts` (85) stay as they are. Feature
PRs rarely edit them, and module files import from feature folders directly.

---

## 5. Module catalogue

`fyd.ts` lines today (excluding about 670 import lines) and `fyd.ts` commits since 2026-11-01 that
changed that module. One commit can count for several modules. The method is in §7.

| Module                   | Owns (`src/{lib,adapters}/…`)                                                                                         | `fyd.ts` lines | Commits |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- | -------------: | ------: |
| `sessions`               | the session core (`session/*` apart from the subfolders below)                                                        |          1,362 |      16 |
| `session-messaging`      | `session/{send,queue,signal,question,turn}`                                                                           |            962 |      16 |
| `fleet`                  | `fleet`, `fleet-reading`, `fleet-refresh`, `fleet-credentials`                                                        |            920 |      16 |
| `reach`                  | `relay`, `webrtc`, `tunnel` (carrier mounts)                                                                          |            905 |       6 |
| `session-reads`          | `session/{reads,transcript,hypermedia,attach,snapshot,observer,monitor,live,events,context,compact-at}`, `transcript` |            857 |       6 |
| `warden`                 | `warden`                                                                                                              |            738 |      16 |
| `agenda`                 | `agenda`, `notifications`, `session/agenda-mode`                                                                      |            705 |      34 |
| `session-migrate`        | `migrate`                                                                                                             |            643 |       7 |
| `board`                  | `board`, `board-projects`, `task-plans`                                                                               |            579 |      40 |
| `terminal`               | `terminal`, `tmux`, `session/console`                                                                                 |            446 |      11 |
| `session-resume`         | `session/{resume,restart,auto-resume}`                                                                                |            446 |       7 |
| `secrets`                | `secrets`, `secure-copy`, `sign-in-rules`, `sign-in-grants`                                                           |            436 |      27 |
| `transfer`               | `transfer`, `attachments`                                                                                             |            368 |       5 |
| `pack`                   | `pack`, `sub-ferret`, `session/pack`                                                                                  |            351 |      13 |
| `usage`                  | `usage`, `budget`                                                                                                     |            333 |       3 |
| `catalogs`               | `catalog*`, `shared-catalogs`, `skills`, `local-skill-installs`                                                       |            306 |      13 |
| `browser`                | `browser`                                                                                                             |            282 |       7 |
| `analytics`              | `analytics`                                                                                                           |            265 |       1 |
| `session-handover`       | `handover`                                                                                                            |            238 |       3 |
| `names`                  | `names`                                                                                                               |            228 |       5 |
| `housekeeping`           | `housekeeping`, `scratch`, `tidy`, `speedups`                                                                         |            203 |       3 |
| `agent-tools`            | `agent-tools`, `agent-files`, `agent-pins`, `pins`                                                                    |            199 |      16 |
| `conversation-import`    | `imports` (conversation import, foreign history)                                                                      |            184 |       3 |
| `access`                 | `grants`, `step-up`, `passkeys`, `security`, `audit`                                                                  |            161 |      14 |
| `input-requests`         | `input-requests`                                                                                                      |            158 |      17 |
| `mcp`                    | `mcp-inventory`, `mcp-oauth`, `session-mcp`                                                                           |            144 |       5 |
| `learning`               | `learning`                                                                                                            |            120 |       4 |
| `board-github`           | `board-github`, `board-import`                                                                                        |            119 |       7 |
| `pairing`                | `pairing`, `push`                                                                                                     |            109 |       8 |
| `worktrees`              | `worktrees`                                                                                                           |            109 |       1 |
| `models`                 | `models`, `local-models`, `provider-probe`                                                                            |             89 |       2 |
| `cgroups`                | `cgroups`                                                                                                             |             70 |       1 |
| `update`                 | `update`, `harness-update`                                                                                            |             68 |       1 |
| `session-fork`           | `fork`                                                                                                                |             60 |       2 |
| `config-files`           | `config-files`                                                                                                        |             38 |       8 |
| `shared-drafts`          | `shared-drafts`                                                                                                       |             29 |       4 |
| `fleet-login`            | `fleet-login`                                                                                                         |             23 |       1 |
| `voice`                  | `stt`                                                                                                                 |             19 |       1 |
| `renders`, `work-search` | `renders`, `work-search`                                                                                              |          3 + 0 |   1 + 1 |
| **kernel (stays)**       | boot, address, bind, lanes, cleanups, shared stores, health, doctor                                                   |      **1,852** |       — |

Modules total about 13,275 lines, the kernel about 1,850 and imports about 670. The kernel plus the
wiring is what makes the **< 1,500-line target** reachable. A good part of the kernel's 1,850 lines is
shared-store construction (`paths`, `stateFiles`, the config store, clocks). That moves into a
`kernel.ts` beside `fyd.ts`, which leaves `fyd.ts` with the boot sequence and one line per module.

**How precise these line counts are.** `fyd.ts` is cut into statements (every top-level declaration,
and every statement or member down to about 120 lines inside the giant bodies). Each piece goes to the
module whose imported names it mentions most, with each name weighted by 1 ÷ (the number of pieces
that mention it), so shared plumbing does not decide the vote. Changing the propagation cut-off from
3 to 12 moves any one module's count by up to about ±15%; the order of the big modules stays the same.
These are good enough to size PRs, but they are not exact.

---

## 6. PR order

Each PR does one thing, keeps behaviour the same, and is proven by suites that already exist. One
rule holds for every module PR: **move code, don't change it.** A bug found while moving is written
down and fixed in its own PR.

### 6.1 Prerequisites (independent; any order; each small)

| PR  | What                                                                                                                                                                                                               | Proof                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | Knip globs (§4.4)                                                                                                                                                                                                  | `knip` and `knip --production` give the same report before and after                                                                                                   |
| P2  | Split `DAEMON_FEATURES` by area, and add the duplicate test (§4.3)                                                                                                                                                 | `daemonFeatureList()` deep-equals its old value; protocol unit suite passes                                                                                            |
| P3  | Add `src/lib/runtime/modules.ts` types and `composeModules`. Add the **route-order equivalence test**. `mountedDaemonRoutes` becomes `composeModules` over one temporary `legacy` module that returns today's list | A snapshot of `METHOD path minimum caller` for the whole table, plus the socket table, is **byte-identical** to `route-callers.ts`; `surface.test.ts` passes unchanged |
| P4  | Per-module route-contract fragments (§4.2). The fragments start empty, and `legacy` holds every line                                                                                                               | `surface.test.ts` passes, and the composed lists deep-equal today's                                                                                                    |

**The route-order equivalence test (P3).** For every pair of mounted routes that share a verb and
could match the same concrete path, it asserts that the specificity order picks the same route as
today's registration order (`ApiRouter` tries routes in registration order, `router.ts:47`). If no
pair disagrees, specificity ordering is provably the same behaviour, and module order stops
mattering. If some pair disagrees, the test names it and the pair is pinned with an explicit
`precedence` on the route. This is the only change to dispatch semantics in the whole plan, and it
lands with its own proof.

### 6.2 Module PRs — one module per PR

Each PR does four things:

1. It moves that module's `create*Subsystem` helpers, its `buildWorld` statements, its
   `createSubsystems` statements and its `start()` job and cleanup lines into
   `bin/modules/<id>.ts`.
2. It moves its routes out of the `legacy` module.
3. It moves its contract lines from the `legacy` fragment into its own fragment.
4. It claims its `features`.

`DaemonWorld` fields keep their names and positions during the migration, so the 19 test files that
pass `buildWorld(overrides)` do not change. The seams are regrouped per module only in the last PR.

Each PR is proven by:

- the full unit and integration suites in CI, plus SIT;
- the P3 route snapshot, still byte-identical;
- the composed contract lists, which must deep-equal the previous commit's;
- `composition-reachability.sh`, which shows the module is wired;
- for modules with jobs or cleanups, an added assertion that pins their **position** in the release
  stack (§9, risk 2).

**Order: a pilot wave first, then the modules that clash most, then the session core last.** A module
can be extracted at any point, because `fyd.ts` passes it locals that already exist.

| Wave                                | Modules, in PR order                                                                                                                                           | Why this order                                                                                                                          |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **A — pilot** (prove the pattern)   | `learning`, `cgroups`, `analytics`, `update`, `worktrees`, `voice` + `renders` + `work-search` (one PR, 22 lines between them)                                 | Small, with routes **and** a job (`analytics` uses the lane; `update` uses `ready`), and few dependents                                 |
| **B — the modules that clash most** | `board`, `board-github`, `agenda`, `secrets`, `input-requests`, `agent-tools`, `access`, `pairing`, `config-files`, `catalogs`, `pack`                         | Together they account for 197 of the 353 module-touches in §7. Moving them first gets most of the clash reduction early                 |
| **C — the rest of the edges**       | `fleet-login`, `models`, `usage`, `mcp`, `shared-drafts`, `names`, `housekeeping`, `conversation-import`, `transfer`, `browser`, `terminal`, `fleet`, `warden` | Medium size, moderate clash                                                                                                             |
| **D — reach**                       | `reach`                                                                                                                                                        | Its carriers are built inside the boot sequence (`start():14585-14800`). It goes last outside sessions, once the boot points are proven |
| **E — sessions**                    | `session-fork`, `session-handover`, `session-migrate`, `session-resume`, `session-reads`, `session-messaging`, `sessions`                                      | The deepest graph and most of the 36 late-bound `let` cycles. By this point every other module has proven the pattern                   |
| **F — tidy-up**                     | Delete the `legacy` module and `MountedSubsystems`. Regroup `DaemonWorld` seams per module (`world.modules.<id>`). Add the size and import gate (§8)           | Only once nothing depends on the old shapes                                                                                             |

That makes **38 module PRs** (8 small modules are merged into 3 PRs, so about 35 PRs in practice)
plus 4 prerequisites and 1 tidy-up. Each PR moves a few hundred lines at most, apart from `sessions`
(about 1,360 lines). If the `sessions` PR is too big to review, it can be split by subfolder without
changing anything else in the plan.

**Landing rule during the window.** A module PR claims its `fyd.ts` region (on its card) and merges
fast. Because the move is mechanical, an open feature PR that conflicts with it re-applies its hunk in
the new file during its next rebase. It does not need to wait.

---

## 7. Expected clash reduction (measured)

### 7.1 Method

1. List the non-release commits since 2026-11-01 that edited `fyd.ts`: 92 commits, all squash-merged
   PRs.
2. For each commit, collect the modules it changed:
   - The module of every **other** daemon file it touched, by path (`src/{lib,adapters}/<x>/`,
     `mounts/<x>.ts`, `tests/*/<x>/`). The shared lists in §1 are ignored here, because after the
     split they become the module's own fragment.
   - The module of every **`fyd.ts` line** it added or removed. Each line is attributed with the §5
     method, run on that commit's own version of the file (the new side for `+` lines, the old side
     for `-` lines). A line in the kernel counts as a "wiring" touch.
3. For each pair of these PRs, find whether they were **open at the same time** (`createdAt` to
   `mergedAt`, from `gh pr view`). A pair that overlapped and touched the same file is a clash
   **exposure**: whichever merges second may have to rebase.

### 7.2 Results

| What                                                             | Today (shared `fyd.ts`) | After the split |
| ---------------------------------------------------------------- | ----------------------: | --------------: |
| Overlapping PR pairs that both edited `fyd.ts`                   |                     221 |               — |
| … that share a **feature module** after the split                |                       — |   98 (**−56%**) |
| … that share a module **or both edit wiring** (pessimistic)      |                       — |  132 (**−40%**) |
| Commits that changed exactly one module and no wiring            |                       — |        11 of 92 |
| Commits that changed one module plus wiring                      |                       — |         5 of 92 |
| Median number of modules per `fyd.ts` commit                     |                       — |               3 |
| `knip.json` commits that needed an edit                          |                      72 |    5 (**−93%**) |
| `DAEMON_FEATURES` overlapping PR pairs (same file vs. same area) |                      39 |   10 (**−74%**) |

### 7.3 What this means

- **Most `fyd.ts` commits are cross-feature.** Only 16 of 92 would have stayed inside one module. So
  the split mostly does **not** stop a PR from touching several files. What it stops is unrelated PRs
  colliding in the same file. That is why the pair numbers move far more than the per-commit
  numbers.
- **The pessimistic row overstates the remaining clashes.** In the new `fyd.ts`, a "wiring" touch is
  one line per module, and two PRs that each change a different module's line rarely conflict as
  text. Today's wiring touches are edits in the middle of a 4,395-line closure, where hunks overlap
  easily.
- **The coupling that remains is real, and it is useful to see.** `agenda` and `board` changed
  together in 24 of the 92 commits, and `agenda`/`board`/`warden` together in several more. After the
  split, that coupling shows up as `needs` edges in the module types instead of being hidden in a
  shared closure. Whether `agenda` and `board` should be one module is a question for later.
- **Measurement caveats.** Attribution is approximate (§5). Using PR open windows as "could have
  conflicted" counts every overlap, not only real textual conflicts, so both the before and after
  numbers are exposures, not confirmed conflicts. The ratio is what matters.

---

## 8. Builds: what gets rebuilt, and what doesn't

**Today.** `scripts/validate/typecheck.sh` runs `tsc --noEmit -p tsconfig.json`, which covers every
non-PWA package as **one program**, and then the PWA with its own config. That runs on every
pre-commit that touches a `.ts` file. TypeScript is `^7.0.2`.

**The proposal.**

1. **Per-package project references (P3's sibling, an optional PR P5).** Give `cli`, `daemon`,
   `fleet`, `protocol` and `relay` each a `composite` `tsconfig.json` with `emitDeclarationOnly` into
   a git-ignored `.tsbuild/`. The root becomes a `references` list, and `typecheck.sh` runs
   `tsc -b`. A PR that changes only `packages/daemon` then skips re-checking `protocol` and `fleet`,
   because their `.tsbuildinfo` is unchanged. In CI, the `.tsbuild/` folder is cached and keyed by
   `bun.lock` plus the tsconfigs.
2. **Within the daemon, the file is what gets re-checked, and that is where modules help.** With
   `incremental`, TypeScript re-checks a changed file and the files that depend on its changed
   declarations. Today every feature edit changes `fyd.ts`, so the 15,795-line file and everything
   importing its exports are re-checked each time. After the split, editing the warden re-checks
   `bin/modules/warden.ts`, plus `fyd.ts` only if the warden's `Needs`/`Provides` types changed.
3. **One project per module: rejected.** Modules import each other's `Provides` types, project
   references cannot form cycles, and 38 extra tsconfigs would be another shared list to maintain.
   The file-level gain in point 2 does not need them.
4. **Bun is unaffected.** `bun test` and `bun build --compile` do not typecheck, and the compiled
   binary is the same whether the code is one file or many.

**Check before relying on this.** Optional PR P5 first measures `tsc -b` and `--incremental` under
the pinned TypeScript 7 on a cold and a warm cache. If the pinned compiler lacks either mode, P5 is
dropped. Nothing else in this plan depends on it.

**The bigger rebuild saving is in CI.** Every clash avoided in §7 is one rebase, one re-push and one
full CI run (about 12 minutes of wall-clock, across 20+ jobs) that never happens.

**Gate added in wave F** (`scripts/validate/daemon-modules.sh`, registered like the other contracts):

- `fyd.ts` must stay under its size budget (1,500 lines).
- A file in `bin/modules/` may import another module only with `import type` (for `Provides`/`Needs`).
- Every file in `bin/modules/` must be built in `fyd.ts`. `composition-reachability` already catches
  an unwired module; the gate's error message names the fix.

---

## 9. Risks, and how each is contained

1. **Route order changes which route answers.** Contained by the P3 equivalence test, which proves
   specificity ordering matches today, and by the byte-identical snapshot on every PR.
2. **Boot and shutdown order.** `start()` has 34 ordered `cleanups.push`/`unshift` calls with
   comments that depend on order ("live sockets end BEFORE storage closes"). Jobs are armed at
   specific boot points. Contained by keeping these in the kernel (sockets, storage, lane), by
   `BackgroundJob.when` mapping one-to-one onto today's arm points, and by each module PR adding a test
   that pins the position of its own releases and jobs.
3. **Late-bound cycles.** `buildWorld` contains 36 `let` declarations. Some are local state, and
   some are filled in later because two features need each other (for example `attachmentDaemonId`
   at `fyd.ts:7780` and `seedOwnerSession` at `fyd.ts:8048`). Each late-bound one
   becomes an explicit `LateBound<T>` port in the module that needs it, filled in by `fyd.ts`. The
   cycle stays visible in the wiring instead of being hidden in a closure. Most of them are in wave E.
4. **Test seams churn.** Contained by keeping the `DaemonWorld` and `WorldSeams` shapes until wave F.
5. **Merge pain during the window.** Contained by the quiet window after &C51/&C52, mechanical moves,
   fast merges and the landing rule in §6.2.
6. **A document is a second definition** ([Fact Ownership](../standards/fact-ownership/index.md)).
   The §5 table is a snapshot of `c7e6beda1`, not a registry. The modules themselves become the
   registry. Once wave F lands, this table should be deleted rather than kept up to date.

---

## 10. Owner decisions

**D1 — How modules are wired together.**

- **(a) Explicit wiring in `fyd.ts`** (one typed `build(...)` line per module). The compiler checks
  the dependency graph, and it follows [Stateless OOP + DI](../standards/stateless-oop-di/index.md)
  (no service locator). Cost: adding a module, or changing what a module needs, edits one line in
  `fyd.ts`.
- **(b) An automatic registry.** Modules declare `needs: ['sessions', 'agenda']` and the host sorts
  them and injects by name. No shared edit at all, but dependencies are resolved at runtime by name,
  which is a service locator the doctrine forbids. A missing dependency then fails at boot instead of
  at compile time.
- **My pick: (a).** Under (a), the edits left in `fyd.ts` are one-line changes in different places,
  which rarely conflict (§7.3).

**D2 — How route precedence is decided.**

- **(a) By specificity** (a literal segment beats a parameter, compared segment by segment). It is
  proven equal to today's behaviour by the P3 test, and it makes module order irrelevant to routing.
- **(b) Keep registration order.** That keeps one hand-ordered module list for routing, which is a
  shared list again.
- **My pick: (a).** If the P3 test finds a pair that disagrees, that pair gets an explicit
  `precedence`, and the decision becomes "(a) plus named exceptions".
