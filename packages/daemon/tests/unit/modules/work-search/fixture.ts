import type { WorkSearchService } from '../../../../src/lib/work-search/index.ts';
import type { BuiltModule, ModuleLifecycle } from '../../../../src/lib/runtime/modules.ts';
import { type WorkSearchNeeds, workSearchModule } from '../../../../bin/modules/work-search.ts';

/**
 * THE `workSearch` MODULE'S TEST CONSTRUCTION — a per-module fixture fragment (see `../learning/fixture.ts`).
 *
 * The REAL `workSearchModule.build(needs, seams, lifecycle)` over test inputs, so the route snapshot and the contract
 * checks consume what production builds. Only the INPUTS are doubles: a board store with no cards, ledgers that hold
 * nothing and ports that fail loudly if a surface test reaches one it never meant to.
 *
 * Unlike a pure module, this one starts two things while it is built, as in production: a watch on the card
 * directory (here a double that returns at once) and a timer that builds the index five seconds after boot. That
 * timer must not exist in the shared unit process (CI runs every non-PWA unit test in ONE process, and a leftover
 * timer breaks `unit-determinism.test.ts`), so `setTimeout` is swapped for a recorder for the duration of the build.
 * Built ONCE and shared, because the surface tests ask for the module on every dispatcher they create.
 */

const NOT_EXERCISED = (what: string) => () => {
  throw new Error(`${what} is not exercised by the mounted-surface fixture`);
};

/** The inputs `fyd.ts` hands the module, over doubles. */
function workSearchNeeds(): WorkSearchNeeds {
  return {
    paths: { state: '/nonexistent/work-search-fixture-state-home' },
    stateFiles: {},
    board: {
      read: NOT_EXERCISED('a board read'),
      watch: () => () => undefined,
    } as unknown as WorkSearchNeeds['board'],
    laneSets: { laneSet: NOT_EXERCISED('a lane set read') },
    agendaSessionIds: async () => [],
    agendaBoards: { read: async () => null },
    machineBoards: { read: async () => null },
    secretRedactor: { batch: NOT_EXERCISED('a redaction batch') } as unknown as WorkSearchNeeds['secretRedactor'],
    fileEvents: { subscribeDirectory: NOT_EXERCISED('a directory subscription') },
    clock: { now: () => '2026-10-20T12:00:00.000Z' },
  };
}

const LIFECYCLE: ModuleLifecycle = { onRelease: () => undefined, releasing: () => false };

let built: BuiltModule<WorkSearchService> | undefined;

/** The module as production builds it, over the fixture's inputs, with the warm-up timer never started. */
export function builtWorkSearch(): BuiltModule<WorkSearchService> {
  if (built === undefined) {
    const realSetTimeout = globalThis.setTimeout;
    // The only timer `build` starts is the index warm-up: swallow it so nothing is left alive in the process.
    globalThis.setTimeout = (() => ({ unref: () => undefined })) as unknown as typeof setTimeout;
    try {
      built = workSearchModule.build(workSearchNeeds(), undefined, LIFECYCLE);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  }
  return built;
}
