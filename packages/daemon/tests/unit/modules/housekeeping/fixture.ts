import { type HousekeepingNeeds, housekeepingModule } from '../../../../bin/modules/housekeeping.ts';
import { createFoundationPaths, resolveStateHome } from '../../../../src/lib/index.ts';
import type { BuiltModule, ModuleLifecycle } from '../../../../src/lib/runtime/modules.ts';
import type { HousekeepingProvides } from '../../../../bin/modules/housekeeping.ts';

/**
 * THE `housekeeping` MODULE'S TEST CONSTRUCTION — a per-module fixture fragment (see `../learning/fixture.ts`).
 *
 * The REAL `housekeepingModule.build(needs, seams, lifecycle)` over test inputs, so the route snapshot and the
 * contract checks consume what production builds. Only the INPUTS are doubles: no sessions, an empty board, no
 * agenda, a vault with no names and a state home that does not exist, none of which anything here asks anything of.
 * Building starts nothing — the scratch collector, the tidy service and the speed-ups service only capture their
 * inputs, and the module has no timer of its own — so there is no timer or async work to leave behind in the shared
 * unit process (CI runs every non-PWA unit test in one process; see `../cgroups/fixture.ts` for a module that does).
 */

/** A state home that does not exist: every document reads as absent. */
const FIXTURE_HOME = '/nonexistent/housekeeping-fixture-state-home';

const NOT_EXERCISED = (what: string) => () => {
  throw new Error(`${what} is not exercised by the mounted-surface fixture`);
};

/** The inputs `fyd.ts` hands the module, over doubles. */
function housekeepingNeeds(): HousekeepingNeeds {
  return {
    storage: {
      listSessions: () => [],
      readConfig: async () => undefined,
      readState: async () => undefined,
    },
    paths: createFoundationPaths(resolveStateHome({ fyHome: FIXTURE_HOME, homeDirectory: '/unused' })),
    reviver: { observe: NOT_EXERCISED('a pane observation') as never },
    tidy: {
      board: { snapshot: NOT_EXERCISED('the board') as never },
      switches: { isOn: async () => false },
      sessions: { roster: NOT_EXERCISED('the session roster') as never },
      agenda: { list: NOT_EXERCISED('the agenda') as never },
      subFerrets: { leadOf: async () => undefined, addressOf: async sessionId => sessionId },
      machineId: () => undefined,
    },
    speedups: {
      authorizer: { send: NOT_EXERCISED('the outbound holder') as never },
      secrets: { list: async () => [] },
      stateFiles: { readText: async () => undefined, writeTextAtomic: async () => undefined },
      clock: { now: () => '2026-10-20T12:00:00.000Z' },
      stopwatch: { monotonicMs: () => 0 },
    },
  };
}

const LIFECYCLE: ModuleLifecycle = { onRelease: () => undefined, releasing: () => false };

/** The module as production builds it, over the fixture's inputs. */
export function builtHousekeeping(): BuiltModule<HousekeepingProvides> {
  return housekeepingModule.build(housekeepingNeeds(), undefined, LIFECYCLE);
}
