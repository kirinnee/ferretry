import type { HarnessLoginService } from '../../../../src/lib/fleet-login/service.ts';
import type { BuiltModule, ModuleLifecycle } from '../../../../src/lib/runtime/modules.ts';
import { type FleetLoginNeeds, fleetLoginModule } from '../../../../bin/modules/fleet-login.ts';

/**
 * THE `fleetLogin` MODULE'S TEST CONSTRUCTION — a per-module fixture fragment (see `../learning/fixture.ts`).
 *
 * The REAL `fleetLoginModule.build(needs, seams, lifecycle)` over test inputs, so the route snapshot and the contract
 * checks consume what production builds. Only the INPUTS are doubles: a credential catalogue, a harness lookup, a
 * clock and an environment that nothing here asks anything of. Building starts nothing — the service is inert until a
 * request — so there is no timer or async work to leave behind in the shared unit process.
 */

const NOT_EXERCISED = (what: string) => () => {
  throw new Error(`${what} is not exercised by the mounted-surface fixture`);
};

/** The inputs `fyd.ts` hands the module, over doubles. */
function fleetLoginNeeds(): FleetLoginNeeds {
  return {
    credentials: {
      entry: NOT_EXERCISED('the credential catalogue'),
      signInTarget: NOT_EXERCISED('the credential catalogue'),
    },
    locate: () => undefined,
    clock: { now: () => 0 },
    environment: {},
    clientName: 'fy',
    declaredAccountModel: async () => undefined,
    configChanges: { announce: () => undefined },
  };
}

const LIFECYCLE: ModuleLifecycle = { onRelease: () => undefined, releasing: () => false };

/** The module as production builds it, over the fixture's inputs. */
export function builtFleetLogin(): BuiltModule<HarnessLoginService> {
  return fleetLoginModule.build(fleetLoginNeeds(), undefined, LIFECYCLE);
}
