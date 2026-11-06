import { StateFileSystem } from '../../../../src/adapters/index.ts';
import { createFoundationPaths, NO_HARNESS_DECLARATIONS, resolveStateHome } from '../../../../src/lib/index.ts';
import type { BuiltModule, ModuleLifecycle } from '../../../../src/lib/runtime/modules.ts';
import {
  updateModule,
  type UpdateJobs,
  type UpdateNeeds,
  type UpdateProvides,
} from '../../../../bin/modules/update.ts';

/**
 * THE `update` MODULE'S TEST CONSTRUCTION — a per-module fixture fragment (see `../learning/fixture.ts`).
 *
 * The REAL `updateModule.build(needs, seams, lifecycle)` over test inputs, so the route snapshot and the contract
 * checks consume what production builds. Only the INPUTS are doubles: a state home that does not exist, an empty
 * ledger, and ports that find no harness and no ferret mid-turn. Building starts nothing — the services are inert
 * until a request or `jobs.arm()` — and a source run (`Bun.main` is not a compiled binary) asks nobody for a release.
 */

/** A state home that does not exist: every update document reads as absent. */
const FIXTURE_HOME = '/nonexistent/update-fixture-state-home';

/** The inputs `fyd.ts` hands the module, over doubles. */
function updateNeeds(): UpdateNeeds {
  const paths = createFoundationPaths(resolveStateHome({ fyHome: FIXTURE_HOME, homeDirectory: '/unused' }));
  return {
    paths,
    stateFiles: new StateFileSystem(paths),
    userHome: '/nonexistent/update-fixture-user-home',
    clientName: 'fy',
    daemonName: 'fyd',
    clock: { now: () => 0 },
    activities: undefined,
    midTurn: async () => 0,
    harnessDiscovery: NO_HARNESS_DECLARATIONS,
    executables: { resolve: () => undefined, runnable: () => false },
  };
}

const LIFECYCLE: ModuleLifecycle = { onRelease: () => undefined, releasing: () => false };

/** The module as production builds it, over the fixture's inputs. */
export function builtUpdate(): BuiltModule<UpdateProvides, UpdateJobs> {
  return updateModule.build(updateNeeds(), undefined, LIFECYCLE);
}
