/**
 * Records what each harness-facing group function of a materialisation is handed, so a test can say which kit (if any)
 * reached it. Every spy forwards to the real function, so a plan is exactly the plan it was.
 *
 * `mock.module` is process-wide and `mock.restore()` does not undo it: call `restore()` after the file (an `afterAll`), or
 * every later file in the same run would draw these spies.
 */
import { mock } from 'bun:test';
import type { RuntimesHarnessKit } from '../../contract/index.ts';
import * as realAdapt from '../../daemon/lib/account/adapt.ts';
import * as realFixedLayer from '../../daemon/lib/account/fixed-layer.ts';
import * as realExtras from '../../daemon/lib/account/runtime-extras.ts';
import * as realWrappers from '../../daemon/lib/wrappers.ts';

type GroupName = 'fixedLayerOf' | 'plumbingOf' | 'priorServersOf' | 'runtimeExtras' | 'autonomousPreparation';

export interface GroupCall {
  readonly group: GroupName;
  readonly harness: string;
  readonly kit: RuntimesHarnessKit | undefined;
}

const ADAPT = '../../daemon/lib/account/adapt.ts';
const FIXED_LAYER = '../../daemon/lib/account/fixed-layer.ts';
const EXTRAS = '../../daemon/lib/account/runtime-extras.ts';
const WRAPPERS = '../../daemon/lib/wrappers.ts';

// Snapshots of the real modules, taken before any spy stands in.
const real = {
  adapt: { ...realAdapt },
  fixedLayer: { ...realFixedLayer },
  extras: { ...realExtras },
  wrappers: { ...realWrappers },
};

/** Stand the spies in. Import whatever uses them AFTER this call. */
export function installGroupSpies(): { readonly calls: GroupCall[]; readonly restore: () => void } {
  const calls: GroupCall[] = [];
  const note = (group: GroupName, harness: string, kit: RuntimesHarnessKit | undefined): void => {
    calls.push({ group, harness, kit });
  };
  mock.module(ADAPT, () => ({
    ...real.adapt,
    plumbingOf: (harness: string, facts: never, kit?: RuntimesHarnessKit) => {
      note('plumbingOf', harness, kit);
      return real.adapt.plumbingOf(harness, facts, kit);
    },
    priorServersOf: (harness: string, servers: never, kit?: RuntimesHarnessKit) => {
      note('priorServersOf', harness, kit);
      return real.adapt.priorServersOf(harness, servers, kit);
    },
  }));
  mock.module(FIXED_LAYER, () => ({
    ...real.fixedLayer,
    fixedLayerOf: (harness: string, request: never, kit?: RuntimesHarnessKit) => {
      note('fixedLayerOf', harness, kit);
      return real.fixedLayer.fixedLayerOf(harness, request, kit);
    },
  }));
  mock.module(EXTRAS, () => ({
    ...real.extras,
    runtimeExtras: (harness: string, input: never, kit?: RuntimesHarnessKit) => {
      note('runtimeExtras', harness, kit);
      return real.extras.runtimeExtras(harness, input, kit);
    },
  }));
  mock.module(WRAPPERS, () => ({
    ...real.wrappers,
    autonomousPreparation: (harness: string, kit?: RuntimesHarnessKit) => {
      note('autonomousPreparation', harness, kit);
      return real.wrappers.autonomousPreparation(harness, kit);
    },
  }));
  return {
    calls,
    restore: () => {
      mock.module(ADAPT, () => real.adapt);
      mock.module(FIXED_LAYER, () => real.fixedLayer);
      mock.module(EXTRAS, () => real.extras);
      mock.module(WRAPPERS, () => real.wrappers);
    },
  };
}
