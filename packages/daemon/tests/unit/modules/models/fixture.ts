import {
  modelsModule,
  type ModelsJobs,
  type ModelsNeeds,
  type ModelsProvides,
} from '../../../../bin/modules/models.ts';
import type { OutboundAuthorizerPort } from '../../../../src/lib/index.ts';
import type { BuiltModule, ModuleLifecycle } from '../../../../src/lib/runtime/modules.ts';

/**
 * THE `models` MODULE'S TEST CONSTRUCTION — a per-module fixture fragment (see `../learning/fixture.ts`).
 *
 * The REAL `modelsModule.build(needs, seams, lifecycle)` over test inputs, so the route snapshot and the contract
 * checks consume what production builds. Only the INPUTS are doubles: a state home that does not exist, no
 * configuration files and no presets, and an outbound holder that refuses to send. Building starts nothing — the
 * services are inert until a request or `jobs.refreshLocal()`, and neither runs here — so there is no timer or async
 * work to leave behind in the shared unit process.
 */

const NOT_EXERCISED = (what: string) => () => {
  throw new Error(`${what} is not exercised by the mounted-surface fixture`);
};

/** The inputs `fyd.ts` hands the module, over doubles. */
function modelsNeeds(): ModelsNeeds {
  const authorizer: OutboundAuthorizerPort = { send: NOT_EXERCISED('an outbound send') };
  return {
    paths: { state: '/nonexistent/models-fixture-state-home' },
    stateFiles: { readText: async () => undefined, writeTextAtomic: NOT_EXERCISED('a catalog cache write') },
    configFiles: { inEffect: NOT_EXERCISED('the configuration files') },
    presets: { presets: async () => [] },
    authorizer,
    stopwatch: { monotonicMs: () => 0 },
    clock: { now: () => '2026-10-20T12:00:00.000Z' },
    millisecondClock: { now: () => 0 },
    pricingChanged: () => undefined,
    republishFleet: async () => undefined,
  };
}

const LIFECYCLE: ModuleLifecycle = { onRelease: () => undefined, releasing: () => false };

/** The module as production builds it, over the fixture's inputs. */
export function builtModels(): BuiltModule<ModelsProvides, ModelsJobs> {
  return modelsModule.build(modelsNeeds(), undefined, LIFECYCLE);
}
