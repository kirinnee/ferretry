---
id: daemon-plugins
title: Daemon feature modules — splitting fyd.ts so features stop colliding
---

# Daemon feature modules — splitting `fyd.ts` so features stop colliding

**Status: PROPOSED (plan only). Changes no production code.**
**Measured on `origin/main` at `c7e6beda1` (`release: 4.285.0`), 2026-11-06.** Every number below can be
re-run with `scripts/local/daemon-modules-probe/` (see its README).
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
   services and contributes its routes, socket routes, audit rules, background jobs and daemon
   features.
2. **`fyd.ts` becomes wiring plus the boot sequence.** It builds each module, passes it the modules it
   needs, composes the routes, and arms jobs **in today's order with today's await and shutdown
   rules**. Target: under 1,500 lines (today it is 15,795).
3. **The shared lists become per-module.** Each module owns its piece of the route table, the
   route-caller and audit lists, `DAEMON_FEATURES` (split by area) and the knip entries (replaced by
   globs). Completeness tests prove no piece is lost (§4).
4. **Order: 5 prerequisite PRs, 38 extraction PRs (40 modules), 1 tidy-up.** Behaviour stays the
   same. Each PR is proven by the existing suites, a byte-identical canonical route snapshot, and a boot and
   shutdown trace (§6).
5. **Modelled effect on daemon composition:** of the 224 PR pairs that were open at the same time
   and both edited `fyd.ts` since 2026-11-01 00:00 UTC, **81–123 (36–55%) would no longer share a
   daemon composition file**. 75 of the 80 `knip.json` edits would not have been needed, and
   `DAEMON_FEATURES` overlaps drop from 40 pairs to 17 (§7). These are exposure scenarios, not
   counted rebases.
6. **Two owner decisions** are in §10. Each has my pick.

---

## 1. The problem, measured

`packages/daemon/bin/fyd.ts` is 15,795 lines. Almost all of it sits in a few places (line ranges are
the declarations only, without the comments that follow them):

| Region                               | Lines       |  Size | What it is                                                                     |
| ------------------------------------ | ----------- | ----: | ------------------------------------------------------------------------------ |
| `DaemonWorld` interface              | 1582–2175   |   594 | The test seams, one or more per feature                                        |
| 31 `create*` helpers and their types | 2246–7772   | 5,527 | Per-feature factories that already exist but live in the shared file           |
| `buildWorld()`                       | 7773–14320  | 6,548 | One function that builds every adapter and service                             |
| └ `createSubsystems` closure         | 9914–14307  | 4,394 | 231 `const`/`let` declarations, building all 118 fields of `MountedSubsystems` |
| `start()`                            | 14346–15372 | 1,027 | The boot: lock, config, address, bind, mount, ordered cleanups, jobs           |

These are the shared files a feature has to hand-edit, ranked by how many of the **393** non-release,
non-merge commits from 2026-11-01 00:00 UTC to `c7e6beda1` edited each one:

| Shared file                                                  | Commits | Why a feature touches it                                         |
| ------------------------------------------------------------ | ------: | ---------------------------------------------------------------- |
| `packages/daemon/bin/fyd.ts`                                 |      95 | Its wiring, its seams and its factory all live here              |
| `knip.json`                                                  |      80 | Each new PWA harness or fixture file is listed by hand           |
| `packages/daemon/tests/unit/runtime/mounts/surface.test.ts`  |      42 | The contract over the whole route table                          |
| `packages/protocol/src/lib/daemon-features.ts`               |      40 | One object literal; every new feature name is added at the end   |
| `packages/daemon/tests/unit/runtime/mounts/route-callers.ts` |      35 | One reviewed line per route                                      |
| `scripts/validate/route-agreement-allowlist.txt`             |      33 | Route drift exemptions                                           |
| `packages/daemon/src/lib/runtime/mounts/index.ts`            |      28 | `MountedSubsystems` (118 fields) and the hand-ordered route list |
| `packages/daemon/tests/unit/audit/not-audited.ts`            |      24 | Audit exemptions per route                                       |

**Why this costs so much.** Two PRs that both append to the same list, or both edit `buildWorld`,
conflict even when their features have nothing in common. Each real conflict means a rebase, a
re-push and a CI re-run. The last green `main` run, 42143288011, took about 12½ minutes across 22
jobs.

**The feature code is already modular.** `src/lib/` already has 81 feature folders with matching
`src/adapters/` folders, and each feature has a mount file in `src/lib/runtime/mounts/`. Only the
**composition** is still one file. So this is a composition-root refactor, not a domain rewrite.

---

## 2. What the doctrine requires, and how this design meets it

| Doctrine                                                      | Requirement                                                                                                    | How the design meets it                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Three-Layer](../standards/three-layer-architecture/index.md) | `src/lib` is pure (enforced by `cli-contracts.sh arch` for every package); wiring lives in `bin/`              | Module **types** and the pure composer go in `src/lib/runtime/modules.ts`. Module **wiring** goes in `bin/modules/<id>.ts`, the composition layer, which may import both `lib` and `adapters`. Test-only lists stay under `tests/`.                                          |
| [Stateless OOP + DI](../standards/stateless-oop-di/index.md)  | Constructor injection; **no service locator**; the graph visible in one place                                  | A module gets its dependencies through a typed `build(needs)` parameter. `fyd.ts` passes them explicitly, so the dependency graph is readable in one file and checked by the compiler. Nothing is looked up by name (§10, D1).                                               |
| [Fact Ownership](../standards/fact-ownership/index.md) R1/R2  | A shared fact has one owner in `@ferretry/protocol`; a second list must be proven **complete**, not just sound | `DAEMON_FEATURES` stays in protocol (the PWA reads it too) and is split by area. Module feature claims are a build inventory checked against it in both directions. The health report's own decision is not changed (§4.3).                                                  |
| [Architecture](../standards/architecture/index.md)            | The app ships before the daemon; features are gated by name                                                    | No change on the wire. `/v1/health › features` is pinned for both a privileged-loopback request and a remote one.                                                                                                                                                            |
| [cli-authoring](../../.claude/skills/cli-authoring/SKILL.md)  | One composition root; `if (import.meta.main)` guard; tests import factories                                    | `fyd.ts` stays the one root, and `buildWorld`, `start` and `WorldSeams` keep their names and shapes until the tidy-up PR. Of the 16 daemon test files that import `bin/fyd.ts`, only the `createSubsystems` capture in `boot-lifecycle.test.ts` changes, once, in P5 (§3.3). |

---

## 3. The module interface

### 3.1 Types (pure, `packages/daemon/src/lib/runtime/modules.ts`)

```ts
import type { DaemonFeature } from '@ferretry/protocol';
import type { ApiRoute } from '../api/route.ts';
import type { SocketRoute } from '../api/socket.ts';
import type { AuditedRouteRule, AuditedSocketRule } from '../audit/routes.ts';

/**
 * The kernel's existing cleanup list, handed to a module while it builds. Every release that is
 * registered today is registered at the same moment and in the same order, so:
 *  - shutdown still runs the list FORWARD in registration order (`fyd.ts:15755-15760`);
 *  - `first: true` keeps today's prepends (queue delivery, `fyd.ts:15363`);
 *  - a build that throws halfway has already registered every release it registers today.
 * Extraction adds no releases. Where today has none (the agenda deadline timers are only `unref`ed,
 * and the member sweep's stop callback is dropped), that stays as it is: see §3.4, named exception.
 */
export interface ModuleLifecycle {
  readonly onRelease: (
    label: string,
    release: () => void | Promise<void>,
    options?: { readonly first?: boolean },
  ) => void;
  /** True once shutdown has begun. A late job result checks this and releases immediately (the warden rule, `fyd.ts:15312-15324`). */
  readonly releasing: () => boolean;
}

/** Everything one module adds to the daemon. Every field is optional. */
export interface ModuleContribution {
  readonly routes?: readonly ApiRoute[];
  readonly sockets?: readonly SocketRoute[];
  /** Production audit rules for this module's routes and sockets; the audit layer gets their union. */
  readonly audit?: { readonly routes?: readonly AuditedRouteRule[]; readonly sockets?: readonly AuditedSocketRule[] };
  /** Protocol feature names this module implements (an inventory — the health report is unchanged, §4.3). */
  readonly features?: readonly DaemonFeature[];
}

/**
 * A built module: what other modules may use (`provides`), the jobs the kernel arms (`jobs`) and what the
 * host mounts (`contributes`).
 *
 * `Jobs` is deliberately NOT one uniform job type. Each job keeps the exact signature it has today, because
 * the kernel's arming line must not change: the GitHub watcher's `arm()` returns its stop callback
 * synchronously (`board-github/watcher.ts:140-153`, pushed at once at `fyd.ts:15341`), the warden's `arm()`
 * returns a promise whose late result is disarmed if shutdown has begun (`fyd.ts:15318-15324`). A uniform
 * `Promise`-returning type would add a yield or delay a registration.
 */
export interface BuiltModule<Provides, Jobs extends object = Record<never, never>> {
  readonly id: string;
  readonly provides: Provides;
  readonly jobs: Jobs;
  readonly contributes: ModuleContribution;
}

/**
 * A feature module.
 *  - `Seams`: the production adapters a test may replace. Until the tidy-up PR these are READ FROM
 *    EFFECTIVE `DaemonWorld` (overrides included) by a per-module adapter (§6.1, P5), so
 *    `buildWorld(overrides)` keeps working.
 *  - `Needs`: the opened storage, the decided config and the `provides` of the modules it depends on.
 *  - `build` is SYNCHRONOUS. All construction inside `createSubsystems` is synchronous today, and an await
 *    between two builds would let work started earlier in construction (the agenda waker tick, the member
 *    sweeps) interleave with the rest of it — the first extraction showed exactly that in the boot trace. A
 *    module that ever needs asynchronous set-up does it in a job armed by `start()`, never in `build`.
 */
export interface DaemonModule<Seams, Needs, Provides, Jobs extends object = Record<never, never>> {
  readonly id: string;
  readonly build: (needs: Needs, seams: Seams, lifecycle: ModuleLifecycle) => BuiltModule<Provides, Jobs>;
}

/**
 * A value one module needs that another module, built later, provides. Filled once by the composition root.
 * It has no throwing getter: each port that reads it keeps TODAY'S early-read behaviour explicitly, because
 * those differ — `seedOwnerSession` answers `undefined` (`fyd.ts:8057`), `seedAgenda.close` is a no-op
 * (`:8063`), `seedAgenda.raise` throws "the agenda is not running yet" (`:8060`), and the warden ledger
 * reader answers `undefined` (`:10407`). P5 pins each one.
 */
export interface LateBound<T> {
  readonly current: () => T | undefined;
  readonly bind: (value: T) => void; // exactly once
}
```

These types follow the stateless rules. `BuiltModule` is a readonly structure, and `build` is a
function of its inputs. A module **never** reaches for another module except through `needs`, a
`LateBound` it was given, or a type-only import.

**Two job shapes, both armed exactly as today** (this is `start()`, unchanged apart from the object it
calls):

```ts
// synchronous stop callback, registered at once — fyd.ts:15341 today
cleanups.push(board.jobs.githubWatcher.arm());

// asynchronous, must not block "ready", disarms a late result once shutdown began — fyd.ts:15318-15324 today
void agenda.provides.homesMigrated
  .then(async () => await warden.jobs.sweep.arm())
  .then(disarm => (releasing ? disarm() : cleanups.push(disarm)))
  .catch(() => undefined);
```

### 3.2 One module, concretely (`packages/daemon/bin/modules/learning.ts`)

The pattern already exists. `createLearningSubsystem(parts: LearningSubsystemParts)` at
`fyd.ts:7240` is a module in everything but name. The pilot PR turns it into:

```ts
export interface LearningNeeds {
  readonly paths: FoundationPaths;
  readonly files: StateFileSystem;
  readonly clock: SystemClock;
  readonly sessions: SessionsProvides; // from the sessions module (a LateBound until that module is extracted)
  readonly configFiles: ConfigFilesProvides;
  readonly analytics: Pick<AnalyticsProvides, 'pricing'>;
  readonly userHome: string;
}

export const learningModule: DaemonModule<void, LearningNeeds, LearningSubsystem, Record<never, never>> = {
  id: 'learning',
  build: needs => {
    const subsystem = createLearningSubsystem(/* the body at fyd.ts:7240 today, unchanged */);
    return {
      id: 'learning',
      provides: subsystem,
      jobs: {},
      contributes: { routes: learningRoutes(subsystem) }, // mounts/learning.ts:490, same arguments as today
    };
  },
};
```

### 3.3 The host (`fyd.ts`)

**Where the wiring lives during the migration.** Today `start()` calls `world.createSubsystems(...)`
once (`fyd.ts:14810`) and uses the result synchronously. Its declared return is `MountedSubsystems`
(`:2157`). A test replaces that factory to capture the exact analytics-ingestion instance that gets
mounted (`boot-lifecycle.test.ts:4475-4487`, used at `:4594`). So until wave F, the module wiring below
lives **inside the default `createSubsystems` factory**, still invoked once from the same place. P5
changes that factory's contract once, on purpose, with the test that wraps it:

- **Input.** It gains the **effective world** (the one `start()` was given, overrides included), so
  `seamsOf.<id>(world)` reads overridden seams, plus the `ModuleLifecycle`.
- **Output.** It becomes `Promise<{ readonly mounted: MountedSubsystems; readonly modules: ModuleHandles }>`.
  `ModuleHandles` is a typed record of the extracted modules' `BuiltModule`s. It starts empty in P5 and
  each extraction PR adds its own field, so `start()` can hand them to `composeModules` and arm their
  jobs. It is deleted in wave F, when the wiring itself moves into `start()`.
- **The one call is awaited** in `start()`. In the same P5 PR, the capture test's wrapper becomes
  `async`, awaits the original factory, and types its capture as
  `Awaited<ReturnType<DaemonWorld['createSubsystems']>>['mounted']`. P5's trace and identity checks
  prove the wrapped and unwrapped boots still mount the same instances.

```ts
// inside the default createSubsystems factory (moves to start() in wave F)
const configFiles = configFilesModule.build({ storage, paths, changes }, seamsOf.configFiles(world), lifecycle);
const agendaLink = lateBound<AgendaProvides>(); // the board reads the agenda lazily today (fyd.ts:10403-10435)
const board = boardModule.build({ storage, agenda: agendaLink /* … */ }, seamsOf.board(world), lifecycle);
const agenda = agendaModule.build({ storage, board: board.provides /* … */ }, undefined, lifecycle);
agendaLink.bind(agenda.provides);
// … one line per module

return { mounted: legacyMounted, modules: { configFiles, board, agenda /* … */ } };

// back in start(), where the routes are mounted today
const { mounted, modules } = await world.createSubsystems(world, lifecycle /* , today's arguments */);
const host = composeModules(base, [legacyModule(mounted), modules.configFiles, modules.board, modules.agenda /* … */]);
const dispatcher = host.dispatcher;
// The direct carrier needs the HTTP dispatcher AND the socket dispatcher it is part of, so it stays a
// kernel step after composition, exactly as today (fyd.ts:14952-14963): its socket route is appended
// AFTER the decorated module sockets (mounts/index.ts:914-925), outside the module table.
const direct = await world.createDirectCarrier(/* the same closures over dispatcher and socket dispatcher */);
const socketDispatcher = host.socketDispatcher('route' in direct ? [direct.route] : []);
surface.mount(dispatcher, socketDispatcher);
```

`composeModules` is pure and lives in `src/lib/runtime/modules.ts`. It replaces `mountedDaemonRoutes`
and `mountedSocketRoutes`:

- It **concatenates** every module's routes and sockets into the **inventory** (what the contract
  tests read), in module order.
- It gives the router a copy **ordered by route specificity** (the D2 pick, proven equal to today's
  dispatch in P3). Inventory order and dispatch order are separate facts, and only dispatch order
  decides which route answers.
- It **wraps** the HTTP table in today's cross-cutting layers, in today's order: session addressing,
  audit and agent control (`mounts/index.ts:563-567`), then `configAnnouncedRoutes` and
  `observedRoutes` (`:868-871`). The socket table gets its own layers as today (`:891-905`). The
  audit layer is passed the **union of the modules' audit rules** in place of the shared constants
  (`auditedRoutes` already takes `rules` as a parameter, `audit/routes.ts:972-979`). These layers stay
  in the kernel; they are the dispatcher, not features.
- It returns a socket-dispatcher factory that **appends carrier routes after decoration**, as
  `createMountedSocketDispatcher` does today.

### 3.4 What stays in the kernel (not a module)

**The boot and shutdown sequence stays in `start()`.** That means the state-home lock, config load,
address decision, bind, `StagedApiSurface`, the event-loop meter and watchdog, `BackgroundLane`, relay
and tunnel start-up, and the cleanup list.

**Job arming also stays here, line for line.** Today the order and the rules differ job by job:

- relay start-up is awaited (`:14981`) and the tunnel started (`:15059`);
- auto-resume is fire-and-forget (`:15128`);
- the declared-wait monitor's first run is awaited **before** the observer arms (`:15152-15160`);
- fleet refresh and analytics go through the lane (`:15204-15256`);
- the warden must **not** block "ready", and must disarm a late result if shutdown has begun
  (`:15312-15324`);
- handover reconcile, GitHub watcher, daemon update, send tracking and queue delivery each have their
  own position (`:15338-15363`).

Three phase buckets cannot express that. So **modules declare jobs, and the kernel arms them**: the
boot calls `board.jobs.githubWatcher.arm()` exactly where it calls `subsystems.boardGitHub.arm()`
today, with the same signature, await and release rule (§3.1). Adding a new job is still a one-line edit to `start()`.
That is deliberate: when a job runs relative to the others is a fact about the whole boot, not about
one feature.

**Named exception: jobs that start while their subsystem is built.** Some jobs are not armed in
`start()` today; they start inside `createSubsystems`, at a specific point in construction:

- the agenda resurfacer and waker (`fyd.ts:11334-11351`) and its deadline sweep interval and timeout
  (`:11364-11365`);
- the catalog member, link-reconcile and link-refresh sweeps (`:14177-14182`, `:14243-14256`).
  `MemberSweepTimer.start()` runs one sweep at once before setting its interval
  (`adapters/catalog-members/sweep-timer.ts:25-31`).

These **stay where they are**: inside their module's `build`, at the same point in that module's
construction. Each extraction PR keeps the module's construction order. Today's cleanup behaviour is
kept exactly, including where there is none (the deadline timers are only `unref`ed). A gap found
there is written down and fixed in its own PR, never during the move. The P5 boot trace records these
starts and the immediate sweep, so a move that shifts them fails.

The kernel also keeps `api/`, `core/`, `runtime/`, `performance/`, health and doctor,
and the shared stores (`paths`, `stateFiles`, the config store, clocks). The shared stores move to a
`kernel.ts` beside `fyd.ts`.

---

## 4. Making the shared lists per-module

### 4.1 Routes and sockets

`MountedSubsystems` (118 fields) and the hand-ordered list in `mounts/index.ts` both go away. Each
module returns its routes in `contributes.routes`. The carrier socket stays a kernel step (§3.3).

### 4.2 Route contract lists (callers, audit, surface)

- **Production audit rules** (`AUDITED_ROUTES` at `audit/routes.ts:87` and the socket rules at
  `:1285`) become `contributes.audit` on each module. The composer passes their union to the audit
  layers. Production code never imports a test file.
- **Reviewed test lists.** `ROUTE_CALLERS` and `NOT_AUDITED` become one fragment per module:
  `packages/daemon/tests/unit/modules/<id>/route-contract.ts`, exporting `{ callers, notAudited }`.
- **The checks.** `surface.test.ts` keeps its whole-table checks (including the route-declaration
  inventory at `:2057-2087`). It now concatenates the fragments and asserts that:
  1. every mounted route is in exactly one fragment;
  2. every fragment line names a mounted route;
  3. every audit rule still names a mounted route, so a stale rule cannot hide.

  The inventory is compared in a **canonical order** (sorted by `METHOD path`, sockets separately),
  not in mount order. Today `surface.test.ts:2049-2054` compares the raw mounted order with
  `ROUTE_CALLERS`, but one module's routes are interleaved with others' in that order (`boardRoutes`
  at `mounts/index.ts:761`, `secureCopyRoutes` at `:774`, `taskPlanRoutes` at `:782`). Grouping by
  module would reorder the list on every extraction PR, so P3 switches the comparison to canonical
  order once, deliberately. Which route answers a request is proven separately, by the P3 dispatch
  test.

  These are the same completeness and staleness proofs the lists give today. The review is still a
  diff a person reads; it now lands in the module's own file.

- **Unchanged:** `scripts/validate/route-agreement-allowlist.txt` only ever shrinks, so it stays as it
  is.

### 4.3 `DAEMON_FEATURES` and the health report

`DAEMON_FEATURES` is a fact the PWA and the daemon share, so under
[Fact Ownership](../standards/fact-ownership/index.md) R1 its owner stays `@ferretry/protocol`. The
change is how the file is laid out:

- **One file per area.** It splits into `packages/protocol/src/lib/daemon-features/<area>.ts`, each
  exporting one `as const` fragment. `daemon-features/index.ts` spreads them back into the same object
  with the same keys and values, and keeps `NOT_YET_REPORTED` and the helpers. Adding the first feature of a new area (or removing an
  area's last) also edits `index`, to import or drop that file; §7 counts that.
- **A guard test.** A protocol unit test fails if two fragments use the same key or the same wire
  value.
- **A completeness test on the daemon side.** The union of the modules' `contributes.features` must
  equal the full set of names this build implements (every name minus `NOT_YET_REPORTED`). A name no
  module claims fails, and so does a claim protocol does not know.
- **The health report is not changed.** `runtime/mounts/health.ts:134-157` still decides what each
  request sees. It withholds `sessionCredential` unless the request arrived on the privileged loopback
  carrier, so it is not simply the union.
- **A health snapshot test.** P2 adds a test that pins the feature list for a privileged-loopback
  request and for a remote one.

### 4.4 `knip.json` — naming conventions, not a generator

The daemon workspace already uses globs, apart from six explicit test-support entries
(`knip.json:17-24`). The churn is in the PWA workspace. Two globs cover 235 of its 271 entries today:

```json
"harness/*-{screenshot,page}.{ts,tsx}",
"tests/integration/fixtures/*-scene.tsx"
```

Checking both sides of every diff, **75 of the 80 commits** that edited `knip.json` would not have
needed to. The other 36 entries stay listed by name (benches, smoke scripts, `fy-render-shell`).

Knip's `files: error` rule keeps the convention honest: a harness file whose name misses the glob,
and that nothing imports, fails knip. That is why a generator is not needed.

### 4.5 The barrels

`src/lib/index.ts` (149 `export *` lines) and `src/adapters/index.ts` (85) stay as they are. Feature
PRs rarely edit them, and module files import from feature folders directly.

---

## 5. Module catalogue (40 modules)

The columns:

- **Lines (range)**: `fyd.ts` lines attributed to the module, at the probe's propagation cut-off 6,
  with the range over cut-offs 3–12 (`attribute.ts --limit N`).
- **Commits**: `fyd.ts` commits since 2026-11-01 00:00 UTC that changed the module. One commit can count for
  several modules.

The line counts are **heuristic**. Most modules move by under 10% across cut-offs, but some move a
lot: `conversation-import` 74–184, `pairing` 29–128, `access` 183–301, `secrets` 377–565,
`session-migrate` 643–870. Use them to rank and roughly size the PRs, not as exact budgets.

| Module                | Owns (`src/{lib,adapters}/…`)                                                                                         |     Lines | Range       | Commits |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- | --------: | ----------- | ------: |
| `sessions`            | the session core (`session/*` apart from the subfolders below)                                                        |     1,387 | 1,354–1,546 |      17 |
| `session-messaging`   | `session/{send,queue,signal,question,turn}`                                                                           |       953 | 933–1,086   |      15 |
| `fleet`               | `fleet`, `fleet-reading`, `fleet-refresh`, `fleet-credentials`                                                        |       928 | 928–974     |      16 |
| `reach`               | `relay`, `webrtc`, `tunnel`                                                                                           |       885 | 796–908     |       6 |
| `session-reads`       | `session/{reads,transcript,hypermedia,attach,snapshot,observer,monitor,live,events,context,compact-at}`, `transcript` |       857 | 830–857     |       6 |
| `warden`              | `warden`                                                                                                              |       711 | 636–736     |      17 |
| `agenda`              | `agenda`, `notifications`, `session/agenda-mode`                                                                      |       705 | 649–705     |      36 |
| `session-migrate`     | `migrate`                                                                                                             |       643 | 643–870     |       7 |
| `board`               | `board`, `board-projects`, `task-plans`                                                                               |       586 | 561–718     |      40 |
| `terminal`            | `terminal`, `tmux`, `session/console`                                                                                 |       446 | 388–461     |      13 |
| `session-resume`      | `session/{resume,restart,auto-resume}`                                                                                |       443 | 443–460     |       7 |
| `secrets`             | `secrets`, `secure-copy`, `sign-in-rules`, `sign-in-grants`                                                           |       443 | 377–565     |      30 |
| `transfer`            | `transfer`, `attachments`                                                                                             |       363 | 298–363     |       5 |
| `pack`                | `pack`, `sub-ferret`, `session/pack`                                                                                  |       351 | 334–351     |      13 |
| `usage`               | `usage`, `budget`                                                                                                     |       341 | 290–347     |       3 |
| `browser`             | `browser`                                                                                                             |       333 | 289–333     |       6 |
| `catalogs`            | `catalog*`, `shared-catalogs`, `skills`, `local-skill-installs`                                                       |       318 | 318–326     |      13 |
| `analytics`           | `analytics`                                                                                                           |       269 | 267–271     |       1 |
| `access`              | `grants`, `step-up`, `passkeys`, `security`, `audit`                                                                  |       253 | 183–301     |      15 |
| `session-handover`    | `handover`                                                                                                            |       238 | 238–273     |       3 |
| `names`               | `names`                                                                                                               |       230 | 220–230     |       5 |
| `agent-tools`         | `agent-tools`, `agent-files`, `agent-pins`, `pins`                                                                    |       199 | 199         |      17 |
| `housekeeping`        | `housekeeping`, `scratch`, `tidy`, `speedups`                                                                         |       195 | 167–195     |       3 |
| `conversation-import` | `imports` (conversation import, foreign history)                                                                      |       184 | 74–184      |       3 |
| `input-requests`      | `input-requests`                                                                                                      |       158 | 149–160     |      20 |
| `mcp`                 | `mcp-inventory`, `mcp-oauth`, `session-mcp`                                                                           |       144 | 134–144     |       5 |
| `learning`            | `learning`                                                                                                            |       120 | 108–120     |       4 |
| `board-github`        | `board-github`, `board-import`                                                                                        |       119 | 119         |       7 |
| `worktrees`           | `worktrees`                                                                                                           |       109 | 109         |       1 |
| `models`              | `models`, `local-models`, `provider-probe`                                                                            |        89 | 89–97       |       2 |
| `pairing`             | `pairing`, `push`                                                                                                     |        74 | 29–128      |       7 |
| `cgroups`             | `cgroups`                                                                                                             |        70 | 70          |       1 |
| `update`              | `update`, `harness-update`                                                                                            |        68 | 68          |       1 |
| `session-fork`        | `fork`                                                                                                                |        60 | 60          |       2 |
| `config-files`        | `config-files`                                                                                                        |        39 | 38–39       |       8 |
| `shared-drafts`       | `shared-drafts`                                                                                                       |        29 | 29          |       4 |
| `fleet-login`         | `fleet-login`                                                                                                         |        23 | 23          |       1 |
| `voice`               | `stt`                                                                                                                 |        19 | 19          |       1 |
| `renders`             | `renders`                                                                                                             |         3 | 3           |       1 |
| `work-search`         | `work-search`                                                                                                         |         0 | 0           |       1 |
| **kernel (stays)**    | boot, address, bind, lanes, cleanups, job arming, shared stores, health, doctor                                       | **1,742** | 1,301–2,072 |       — |

The remaining 669 lines are imports, which move with the modules that use them. The < 1,500-line
target for `fyd.ts` is reachable because part of the kernel's ~1,700 lines is shared-store
construction, which moves into `kernel.ts`.

**How attribution works.** `fyd.ts` is cut into pieces: every top-level declaration, and, inside any
piece over 120 lines, every statement or member at the next indent, recursively. Each piece goes to
the module whose imported names it mentions most, with each name weighted by 1 ÷ (pieces that
mention it), so shared plumbing does not decide the vote. Details are in `attribute.ts`.

---

## 6. PR order

Each PR does one thing, keeps behaviour the same, and is proven by suites that already exist plus the
prerequisite pins. One rule for every extraction PR: **move code, don't change it.** A bug found
while moving is written down and fixed in its own PR.

### 6.1 Prerequisites

| PR  | What                                                                                                                                                                                                                                                                                                             | Proof                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | Knip globs (§4.4)                                                                                                                                                                                                                                                                                                | `knip` and `knip --production` give the same report before and after                                                                                                                                                                                                                                                                                                                                                                                                          |
| P2  | Split `DAEMON_FEATURES` by area; duplicate test; health feature snapshot for privileged-loopback and remote requests (§4.3)                                                                                                                                                                                      | `daemonFeatureList()` deep-equals its old value; both health snapshots pass before and after                                                                                                                                                                                                                                                                                                                                                                                  |
| P3  | `src/lib/runtime/modules.ts` types and `composeModules`. `mountedDaemonRoutes`/`mountedSocketRoutes` become `composeModules` over one temporary `legacy` module that returns today's lists. Add the **dispatch-equivalence test**. Switch the inventory comparison and `ROUTE_CALLERS` to canonical order (§4.2) | The `METHOD path minimum caller` table, both socket tables and the carrier route (present, refused and absent), in canonical order, stays **byte-identical**; the dispatch test passes; the only `surface.test.ts` change is the canonical-order comparison                                                                                                                                                                                                                   |
| P4  | Per-module contract fragments and `contributes.audit` (§4.2). The fragments start empty; `legacy` holds every line and rule                                                                                                                                                                                      | `surface.test.ts` passes; the composed lists and rule sets deep-equal today's                                                                                                                                                                                                                                                                                                                                                                                                 |
| P5  | **The migration bridge.** `ModuleLifecycle` over today's `cleanups`; `LateBound<T>`; a per-module `seamsOf.<id>(world)` over the effective world; the async `createSubsystems` contract (§3.3), with the capture test in `boot-lifecycle.test.ts` adapted in the same PR; a **boot and shutdown trace test**     | The trace test records each boot step, job arm, construction-time job start (with the member sweep's immediate run) and cleanup, in order, for four cases: a clean boot and stop, a stop during boot, a boot that throws after storage opens, and a stop that lands before the warden's late `arm()` result. It also pins each late-bound port's early-read answer (§3.1) and that a `createSubsystems` override still sees the mounted instances. It passes before and after |

**The dispatch-equivalence test (P3).** For every pair of mounted routes that share a verb and
could match the same concrete path, it asserts that specificity order picks the same route as
today's registration order (`ApiRouter` tries routes in registration order, `router.ts:47`). If no
pair disagrees, specificity ordering is provably the same behaviour and module order stops mattering.
If a pair disagrees, the test names it and that route gets an explicit `precedence`. This is the only
change to dispatch in the whole plan, and it lands with its own proof.

### 6.2 Extraction PRs — 38 PRs for 40 modules

Each PR moves one module (the pilot wave merges `voice`, `renders` and `work-search`, 22 lines
between them, into one PR). It moves:

1. the module's `create*` helpers;
2. its `buildWorld` and `createSubsystems` statements;
3. its routes out of `legacy`, its contract lines out of the `legacy` fragment, its audit rules, and
   its `features` claims;
4. its jobs: a job armed in `start()` today goes into `jobs`, and its arming line stays exactly where
   it is and only changes which object it calls. A job started during construction today stays in
   `build` at the same point (§3.4, named exception);
5. its `ModuleHandles` field (P5), so `start()` can compose it.

`DaemonWorld` keeps the shape P5 gave it. The module reads its seams from the effective world through
`seamsOf.<id>` and is built inside the default `createSubsystems`, so `buildWorld(overrides)` and a
`createSubsystems` override behave the same.

Each PR is proven by:

- the full unit and integration suites in CI, plus SIT;
- the P3 canonical route snapshot, still byte-identical;
- the P4 composed lists, which deep-equal the previous commit's;
- the P5 boot and shutdown trace, unchanged.

**Order: a pilot wave, then the modules that clash most, then the session core last.** Any module
can be extracted at any time, because `fyd.ts` passes it locals that already exist. Late binding
shows up early, not only in the session wave: the board reads the agenda lazily (`fyd.ts:10403-10435`),
and secrets captures `seedAgenda`, `seedCards` and `seedOwnerSession` (`fyd.ts:8046-8063`). P5's
`LateBound` is why wave B can go second.

| Wave                           | Modules, in PR order                                                                                                                                           | Why this order                                                                                                    |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **A — pilot** (6 PRs)          | `learning`, `cgroups`, `analytics`, `update`, `worktrees`, `voice` + `renders` + `work-search`                                                                 | Small; routes **and** jobs (`analytics` uses the lane, `update` arms near "ready"); few dependents                |
| **B — clash most** (11)        | `board`, `board-github`, `agenda`, `secrets`, `input-requests`, `agent-tools`, `access`, `pairing`, `config-files`, `catalogs`, `pack`                         | 206 of the 363 module-touches in §7, so most of the clash relief arrives early                                    |
| **C — rest of the edges** (13) | `fleet-login`, `models`, `usage`, `mcp`, `shared-drafts`, `names`, `housekeeping`, `conversation-import`, `transfer`, `browser`, `terminal`, `fleet`, `warden` | Medium size, moderate clash                                                                                       |
| **D — reach** (1)              | `reach`                                                                                                                                                        | Its carriers are built inside the boot sequence (`start():14585-14800`), so it goes once the boot trace is proven |
| **E — sessions** (7)           | `session-fork`, `session-handover`, `session-migrate`, `session-resume`, `session-reads`, `session-messaging`, `sessions`                                      | The deepest graph and the most late binding; every other module has proven the pattern by then                    |
| **F — tidy-up** (1)            | Delete `legacy`, `MountedSubsystems` and the `seamsOf` bridge. Regroup `DaemonWorld` seams per module. Add the module gate (§8)                                | Only once nothing depends on the old shapes                                                                       |

**PR size.** Most extraction PRs move under 500 lines. Eight move 640–1,550: `sessions`,
`session-messaging`, `fleet`, `reach`, `session-reads`, `warden`, `agenda` and `session-migrate`.
Any of those can be split by subfolder if it is too big to review, without changing the rest of the
plan.

**Landing rule during the window.** An extraction PR claims its `fyd.ts` region on its card and
merges fast. The move is mechanical, so an open feature PR that conflicts re-applies its hunk in the
new file on its next rebase. It does not need to wait.

---

## 7. Expected clash reduction (modelled)

### 7.1 Method (`classify.ts`, `shared-lists.ts`)

1. List the non-release commits from 2026-11-01 00:00 UTC to `c7e6beda1` that edited `fyd.ts`: 95, all
   squash-merged PRs. (A bare `--since=2026-11-01` would start at the current time of day, so the
   probes pass a full UTC timestamp.)
2. For each commit, collect the modules it changed:
   - The module of every **other** daemon file it touched, by path. The shared lists in §1 are
     skipped, because after the split each becomes the module's own fragment.
   - The module of every **`fyd.ts` line** it added or removed. Lines are attributed against **that
     commit's own tree**: `+` lines on the commit and `-` lines on its parent, each with its own
     `src/` unpacked. A line attributed to the kernel counts as a "wiring" touch, and so does **any line
     inside `start()`**: the plan keeps the boot sequence, job arming and cleanup registration there
     (§3.4), so changing them still edits `fyd.ts` after the split. Such a line also keeps its feature
     touch. The one retired folder in this history, `quota-failover` (the Warden's old automatic
     migration), is counted as `warden`.
3. For each pair of PRs, check whether they were **open at the same time** (`createdAt` to
   `mergedAt`, from `gh pr view`). A pair that overlapped and touched the same file is an
   **exposure**: if their hunks met, whichever merged second had to rebase.
4. `DAEMON_FEATURES` commits are attributed per changed line to the **file it would live in after the
   split**. An entry of the object, and the comment above it, go to its area's file. Every other line
   (the header, `NOT_YET_REPORTED`, the helpers) goes to the shared `index`, even when it names a
   single feature, because those stay in one file. A commit that adds an area's first entry or removes
   its last also touches `index`, because `index` imports every area file. Two PRs clash when they share
   an area file or both touch `index`.

### 7.2 Results (cut-offs 3, 6 and 12)

| Scenario                                                                | Pairs today | Pairs after the split | Change       |
| ----------------------------------------------------------------------- | ----------: | --------------------: | ------------ |
| Overlapping PR pairs that both edited `fyd.ts`                          |         224 |                     — | —            |
| … still sharing a **feature module** after the split                    |           — |               101–106 | −53% to −55% |
| … still sharing a module **or both touching wiring**                    |           — |               130–143 | −36% to −42% |
| `DAEMON_FEATURES`: overlapping pairs (same file → same area or `index`) |          40 |                    17 | −58%         |
| `knip.json`: commits that needed an edit                                |          80 |                     5 | −94%         |

Per commit, at cut-off 6:

- 11 of the 95 `fyd.ts` commits changed exactly one module and no wiring; 4 more changed one module
  plus wiring.
- The median commit changed 3 modules.

### 7.3 What this means, and what it does not

- **Most `fyd.ts` commits are cross-feature.** So the split mostly does **not** stop a PR touching
  several files. What it stops is **unrelated** PRs colliding in one file, which is why the pair
  numbers move much more than the per-commit numbers.
- **These are exposure scenarios, not limits on real rebases or CI re-runs.**
  - An exposure is not a conflict: many overlapping pairs never touched nearby lines.
  - One rebase can settle several exposures at once.
  - The model looks only at daemon composition files. Other shared files can still clash after the
    split. For example, the overlapping commits 79d273de4 and cb09a05ec both edit
    `packages/protocol/src/lib/index.ts`.

  Real rebases and re-runs were not counted, so the CI saving is a likely direction, not a number.

- **The wiring scenario is pessimistic.** After the split, a wiring touch is one line per module in
  `fyd.ts`. Two PRs changing different modules' lines rarely conflict as text. Today a wiring touch is
  an edit somewhere inside a 4,394-line closure.
- **The remaining coupling is real, and now it is visible.** `agenda` and `board` changed together in
  24 of the 95 commits. After the split that shows up as `needs` edges in the module types instead of
  being hidden in a shared closure. Whether they should be one module is a question for later.

---

## 8. Builds: what gets rebuilt, and what doesn't

**Today.** `scripts/validate/typecheck.sh` runs `tsc --noEmit -p tsconfig.json`. That checks every
non-PWA package (and `scripts/`) as **one program**. The PWA is then checked with its own config. The
pinned compiler is TypeScript 7.0.2, which supports `--build`, `--incremental` and `composite`.

**Measured on this box** (`tsc --noEmit --incremental -p tsconfig.json`, warm file cache, 2026-11-06):

| Case                                       | Wall time |
| ------------------------------------------ | --------: |
| Cold, no build info                        |     7.8 s |
| Warm, nothing changed                      |     1.2 s |
| After a comment-only edit to `fyd.ts`      |     2.9 s |
| After the same edit to `learning/index.ts` |     1.5 s |

**What this shows.**

1. **Most of the local saving comes from `--incremental` alone, split or not.** P6 (optional): turn
   it on in `typecheck.sh`, with the build info in a git-ignored `.tsbuild/`, and cache that folder in
   CI keyed by `bun.lock` and the tsconfigs. Cold 7.8 s becomes warm 1.2–2.9 s.
2. **The split then removes the big-file penalty.** Today every feature edit lands in `fyd.ts`, and
   re-checking a 15,795-line file costs about twice as much as a small feature file. After the split,
   a warden edit re-checks `bin/modules/warden.ts`, plus `fyd.ts` only if the warden's
   `Needs`/`Provides` types changed.
3. **Per-package project references (`tsc -b`) are not worth it yet.** The whole program cold-checks
   in 7.8 s, so cutting protocol or fleet out of a daemon-only check saves little and adds five
   composite tsconfigs.
4. **One project per module is rejected.** Modules import each other's `Provides` types, references
   cannot form cycles, and 38 extra tsconfigs would be another shared list.
5. **Bun is unaffected.** `bun test` and `bun build --compile` do not typecheck, and the compiled
   binary is the same whether the code is one file or many.

**The bigger rebuild cost is CI.** Every real conflict that §7 removes is a rebase and a full CI re-run
that does not happen. The plan does not put a number on it (§7.3).

**The module gate, added in wave F** (`scripts/validate/daemon-modules.sh`, registered like the other
contracts):

- `fyd.ts` stays under its size budget (1,500 lines).
- A file under `bin/modules/` may import another module only with `import type`.
- **Every file under `bin/modules/` is built in `fyd.ts`.** The gate lists `bin/modules/` itself and
  checks that each module's `build` is called. `composition-reachability.ts` cannot do this: it only
  enumerates `packages/<pkg>/src` (`:654-663`), and an imported symbol is not proof that `build` runs.
- The gate's own test plants an unused module and expects the gate to fail.

---

## 9. Risks, and how each is contained

1. **Route order changes which route answers.** Contained by the P3 equivalence test, the
   byte-identical canonical snapshot on every PR, and the carrier route kept outside module composition.
2. **Boot and shutdown order.** `start()` registers its cleanups in order, with prepends, and runs
   them forward. Jobs arm at specific points under different await and late-release rules. Contained
   by:
   - keeping the boot sequence and job arming in `start()`;
   - registering releases at acquisition time through `ModuleLifecycle`, so the list and its order
     are exactly today's;
   - the P5 trace test (clean stop, stop during boot, failed boot) on every PR.
3. **Late-bound cycles.** `buildWorld` has 36 `let` declarations. Some are local state, and some are
   filled in later because two features need each other (`attachmentDaemonId` at `fyd.ts:7780`,
   `seedOwnerSession` at `:8048`, the board's lazy agenda). Each late-bound one becomes a `LateBound<T>`
   from P5. Each port that reads it keeps its own early-read answer from today (`undefined`, a no-op or
   a "not running yet" error, §3.1), P5 pins each one, and `fyd.ts` binds it, so the
   cycle is visible in the wiring.
4. **Test seams churn.** Contained by `seamsOf.<id>(world)` over the unchanged `DaemonWorld` and by
   building modules inside the default `createSubsystems`, both of which
   stay until wave F.
5. **Health feature list changes by accident.** Contained by P2's two health snapshots and the
   unchanged decision in `health.ts`.
6. **Merge pain during the window.** Contained by the quiet window after &C51/&C52, mechanical moves,
   fast merges and the landing rule (§6.2).
7. **This document is a second definition** ([Fact Ownership](../standards/fact-ownership/index.md)).
   The §5 table is a snapshot of `c7e6beda1`, not a registry. Once wave F lands, the modules
   themselves are the registry, and that table should be deleted rather than kept up to date.

---

## 10. Owner decisions

**D1 — How modules are wired together.**

- **(a) Explicit wiring in `fyd.ts`:** one typed `x.build(...)` line per module. The compiler
  checks the dependency graph, and it follows [Stateless OOP + DI](../standards/stateless-oop-di/index.md)
  (no service locator). Cost: adding a module, changing what a module needs, or adding a job edits a
  line in `fyd.ts`.
- **(b) An automatic registry:** modules declare `needs: ['sessions', 'agenda']` and the host sorts
  them and injects by name. No shared edit at all, but dependencies are resolved at runtime by name,
  which is the service locator the doctrine forbids. A missing dependency would fail at boot instead
  of at compile time, and job order would become implicit.
- **My pick: (a).** Under (a), the edits left in `fyd.ts` are one-line changes in different places,
  which rarely conflict (§7.3).

**D2 — How route precedence is decided.**

- **(a) By specificity:** a literal segment beats a parameter, compared segment by segment. P3
  proves it equal to today, and module order stops mattering for routing.
- **(b) Keep registration order:** one hand-ordered module list for routing, which is a shared list
  again.
- **My pick: (a).** If P3 finds a pair that disagrees, that route gets an explicit `precedence`, and
  the decision becomes "(a) plus named exceptions".
