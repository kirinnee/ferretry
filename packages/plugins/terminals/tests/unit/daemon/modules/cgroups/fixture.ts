import { DEFAULT_LIMITS_CONFIG } from '@ferretry/protocol';
import { StateFileSystem, unmeasuredHostFacts } from '../../../../src/adapters/index.ts';
import type { DaemonStorage } from '../../../../src/adapters/storage/session-storage.ts';
import type { ConfigFilesService } from '../../../../src/lib/config-files/index.ts';
import {
  ActivityLedger,
  createFoundationPaths,
  EnforcementRuntime,
  type FleetMemoryWatcher,
  type LimitsService,
  resolveStateHome,
  type TmuxController,
} from '../../../../src/lib/index.ts';
import { type BuiltModule, type ModuleLifecycle, lateBound } from '../../../../src/lib/runtime/modules.ts';
import { type CgroupsNeeds, cgroupsModule } from '../../../../bin/modules/cgroups.ts';

/**
 * THE `cgroups` MODULE'S TEST CONSTRUCTION — a per-module fixture fragment (see `../learning/fixture.ts`).
 *
 * The REAL `cgroupsModule.build(needs, seams, lifecycle)` over test inputs, so the route snapshot and the contract
 * checks consume what production builds. Only the INPUTS are doubles: a state home nothing was ever written to,
 * a host that is neither macOS nor a unified-hierarchy Linux (so the module's immediate memory tick measures
 * nothing), and an enforcement probe that answers without running a command.
 *
 * Built ONCE and shared: the surface tests ask for the module on every dispatcher they create. Unlike a pure module
 * this one starts a repeating tick while it is built, as in production — and a unit-tier timer outlives the test
 * that set it (`unit-determinism.ts`: it stays due as far ahead of the next test's start), so left running it would
 * fire inside whichever test happens to be running when the shared clock reaches it. The build therefore runs with
 * the timer globals swapped for inert ones; the module is still the real build, only its tick never fires.
 */

/** A state home that does not exist: the legacy limits document is "not there", so the migration reports `none`. */
const FIXTURE_HOME = '/nonexistent/cgroups-fixture-state-home';

const NOT_EXERCISED = (what: string) => () => {
  throw new Error(`${what} is not exercised by the mounted-surface fixture`);
};

/** The inputs `fyd.ts` hands the module, over doubles. */
function cgroupsNeeds(): CgroupsNeeds {
  const paths = createFoundationPaths(resolveStateHome({ fyHome: FIXTURE_HOME, homeDirectory: '/unused' }));
  return {
    paths,
    stateFiles: new StateFileSystem(paths),
    storage: {
      append: NOT_EXERCISED('a session append'),
      readConfig: NOT_EXERCISED('a config read'),
    } as unknown as DaemonStorage,
    configFiles: { file: NOT_EXERCISED('the configuration files') } as unknown as ConfigFilesService,
    activities: new ActivityLedger({ now: () => 0 }, undefined, () => undefined),
    launchTmux: {} as unknown as TmuxController,
    host: { ...unmeasuredHostFacts(), platform: 'linux', unifiedHierarchy: false },
    enforcement: new EnforcementRuntime(
      async () => ({ kind: 'direct', reason: 'the mounted-surface fixture enforces nothing', ionice: false }),
      () => 0,
    ),
    kills: lateBound<FleetMemoryWatcher>(),
    limitsInEffect: async () => DEFAULT_LIMITS_CONFIG,
    notices: { state: () => undefined },
  };
}

const LIFECYCLE: ModuleLifecycle = { onRelease: () => undefined, releasing: () => false };

let built: BuiltModule<LimitsService> | undefined;

/** A timer handle that is never armed, answering what the build calls on one (`unref`). */
const INERT_TIMER = { ref: () => INERT_TIMER, unref: () => INERT_TIMER, hasRef: () => false, close: () => INERT_TIMER };

/** Runs the synchronous `build` with every timer it asks for refused, restoring the globals even if it throws. */
function withoutTimers<T>(build: () => T): T {
  const { setTimeout: timeout, setInterval: interval, clearTimeout: clearT, clearInterval: clearI } = globalThis;
  const inert = () => INERT_TIMER;
  Object.assign(globalThis, {
    setTimeout: inert,
    setInterval: inert,
    clearTimeout: () => undefined,
    clearInterval: () => undefined,
  });
  try {
    return build();
  } finally {
    Object.assign(globalThis, {
      setTimeout: timeout,
      setInterval: interval,
      clearTimeout: clearT,
      clearInterval: clearI,
    });
  }
}

/** The module as production builds it, over the fixture's inputs. */
export function builtCgroups(): BuiltModule<LimitsService> {
  built ??= withoutTimers(() => cgroupsModule.build(cgroupsNeeds(), undefined, LIFECYCLE));
  return built;
}
