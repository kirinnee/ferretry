import { namesModule, type NamesNeeds, type NamesProvides } from '../../../../../daemon/modules/names.ts';
import { KeyedSerialExecutor, StateFileSystem } from '../../../../src/adapters/index.ts';
import { createFoundationPaths, resolveStateHome } from '../../../../src/lib/index.ts';
import type { BuiltModule, ModuleLifecycle } from '../../../../src/lib/runtime/modules.ts';

/**
 * THE `names` MODULE'S TEST CONSTRUCTION — a per-module fixture fragment (see `../learning/fixture.ts`).
 *
 * The REAL `namesModule.build(needs, seams, lifecycle)` over test inputs, so the route snapshot and the contract
 * checks consume what production builds. Only the INPUTS are doubles: no sessions, no archive and a state home that
 * does not exist. Building starts nothing — the claim ledger, the counters and the suggestion subsystem only capture
 * their inputs, and the module has no timer of its own — so there is no timer or async work to leave behind in the
 * shared unit process.
 */

/** A state home that does not exist: every document reads as absent. */
const FIXTURE_HOME = '/nonexistent/names-fixture-state-home';

/** The inputs `fyd.ts` hands the module, over doubles. */
function namesNeeds(): NamesNeeds {
  const paths = createFoundationPaths(resolveStateHome({ fyHome: FIXTURE_HOME, homeDirectory: '/unused' }));
  return {
    storage: {
      listSessions: () => [],
      listArchivedSessions: () => [],
      readConfig: async () => undefined,
    },
    stateFiles: new StateFileSystem(paths),
    paths,
    serial: new KeyedSerialExecutor(),
  };
}

const LIFECYCLE: ModuleLifecycle = { onRelease: () => undefined, releasing: () => false };

/** The module as production builds it, over the fixture's inputs. */
export function builtNames(): BuiltModule<NamesProvides> {
  return namesModule.build(namesNeeds(), undefined, LIFECYCLE);
}
