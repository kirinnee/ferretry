import { type TransferNeeds, transferModule, type TransferProvides } from '../../../../bin/modules/transfer.ts';
import type { BuiltModule, ModuleLifecycle } from '../../../../src/lib/runtime/modules.ts';

/**
 * THE `transfer` MODULE'S TEST CONSTRUCTION — a per-module fixture fragment (see `../learning/fixture.ts`).
 *
 * The REAL `transferModule.build(needs, seams, lifecycle)` over test inputs, so the route snapshot and the contract
 * checks consume what production builds. Only the INPUTS are doubles: a state directory that does not exist, a fixed
 * daemon id and a session directory that holds no session. Building starts nothing — the attachment store only captures
 * its inputs and arms an eviction timer when a document is unlocked, which no unit fixture does — so there is no timer or
 * async work to leave behind in the shared unit process (CI runs every non-PWA unit test in ONE process, and a leftover
 * timer breaks `unit-determinism.test.ts`).
 */

/** The inputs `fyd.ts` hands the module, over doubles. */
function transferNeedsForTest(): TransferNeeds {
  return {
    stateDirectory: '/nonexistent/transfer-fixture-state-home',
    daemonId: 'transfer-fixture-daemon',
    sessions: { get: async () => undefined },
  };
}

const LIFECYCLE: ModuleLifecycle = { onRelease: () => undefined, releasing: () => false };

/** The module as production builds it, over the fixture's inputs. */
export function builtTransfer(): BuiltModule<TransferProvides> {
  return transferModule.build(transferNeedsForTest(), undefined, LIFECYCLE);
}
