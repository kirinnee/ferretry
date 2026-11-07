import { SystemClock } from '../../../../src/adapters/index.ts';
import { createFoundationPaths, resolveStateHome } from '../../../../src/lib/index.ts';
import type { BuiltModule, ModuleLifecycle } from '../../../../src/lib/runtime/modules.ts';
import {
  type SessionHandoverJobs,
  type SessionHandoverNeeds,
  type SessionHandoverProvides,
  sessionHandoverModule,
} from '../../../../../daemon/modules/session-handover.ts';

/**
 * THE `session-handover` MODULE'S TEST CONSTRUCTION — a per-module fixture fragment (see `../learning/fixture.ts`).
 *
 * The REAL `sessionHandoverModule.build(needs, seams, lifecycle)` over test inputs, so the route snapshot and the contract
 * checks consume what production builds. Only the INPUTS are doubles: a state home that does not exist, and ports that
 * REFUSE to be used (each answers any call with a throw naming it, because the build only captures its inputs and the
 * fixture never begins a handover). Building starts nothing — the reconcile loop's interval is created by `jobs.arm()`,
 * which the fixture never calls — so there is nothing to leave behind in the shared unit process (CI runs every non-PWA
 * unit test in ONE process, and a leftover timer breaks `unit-determinism.test.ts`).
 */

/** A state home that does not exist: every handover receipt reads as absent. */
const FIXTURE_HOME = '/nonexistent/session-handover-fixture-state-home';

/** A port that throws, naming itself, the moment any member of it is called. */
function refusing<T extends object>(name: string): T {
  return new Proxy({} as T, {
    get: (_target, member) => () => {
      throw new Error(`${name}.${String(member)} is not exercised by the session-handover fixture`);
    },
  });
}

/** The inputs `fyd.ts` hands the module, over doubles. */
export function sessionHandoverNeedsForTest(overrides: Partial<SessionHandoverNeeds> = {}): SessionHandoverNeeds {
  return {
    paths: createFoundationPaths(resolveStateHome({ fyHome: FIXTURE_HOME, homeDirectory: '/unused' })),
    storage: refusing('storage'),
    sessions: refusing('sessions'),
    accounts: refusing('accounts'),
    executables: refusing('executables'),
    planner: refusing('planner'),
    clock: new SystemClock(),
    clientName: 'fy',
    activities: undefined,
    ...overrides,
  };
}

const LIFECYCLE: ModuleLifecycle = { onRelease: () => undefined, releasing: () => false };

/** The module as production builds it, over the fixture's inputs. */
export function builtSessionHandover(): BuiltModule<SessionHandoverProvides, SessionHandoverJobs> {
  return sessionHandoverModule.build(sessionHandoverNeedsForTest(), undefined, LIFECYCLE);
}
