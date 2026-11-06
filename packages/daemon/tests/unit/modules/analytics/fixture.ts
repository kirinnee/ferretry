import {
  analyticsModule,
  type AnalyticsJobs,
  type AnalyticsNeeds,
  type AnalyticsProvides,
} from '../../../../bin/modules/analytics.ts';
import type { DaemonStorage } from '../../../../src/adapters/storage/session-storage.ts';
import { ANALYTICS_INDEX_SCHEMA_VERSION, type AnalyticsIndexStore } from '../../../../src/lib/index.ts';
import { KeyedSerialExecutor } from '../../../../src/adapters/index.ts';
import type { BuiltModule, ModuleLifecycle } from '../../../../src/lib/runtime/modules.ts';

/**
 * THE `analytics` MODULE'S TEST CONSTRUCTION — a per-module fixture fragment (see `../learning/fixture.ts`).
 *
 * The REAL `analyticsModule.build(needs, seams, lifecycle)` over test inputs, so the route snapshot and the
 * contract checks consume what production builds. Only the INPUTS are doubles: an analytics store that holds no
 * rows, a storage whose state-write listener is a no-op, an operator document with no rates, and ports that fail
 * loudly if a surface test reaches one it never meant to (a pass over the sessions, a transcript read).
 */

const NOT_EXERCISED = (what: string) => () => {
  throw new Error(`${what} is not exercised by the mounted-surface fixture`);
};

/** A store holding nothing: the read answers an empty fleet, as an index that has ingested no session does. */
const EMPTY_STORE: AnalyticsIndexStore = {
  ingested: () => new Map(),
  upsert: NOT_EXERCISED('an analytics write'),
  forget: NOT_EXERCISED('an analytics write'),
  rows: () => [],
  status: () => ({
    schemaVersion: ANALYTICS_INDEX_SCHEMA_VERSION,
    sessions: 0,
    tokenSessions: 0,
    refusedUsageSessions: 0,
    lastIngestedAt: null,
  }),
  drop: NOT_EXERCISED('an analytics write'),
  close: async () => undefined,
};

/** The inputs `fyd.ts` hands the module, over doubles. */
function analyticsNeeds(): AnalyticsNeeds {
  return {
    storage: { subscribeStates: () => () => undefined } as unknown as DaemonStorage,
    analyticsStore: { store: EMPTY_STORE, rebuildRequired: false },
    config: {
      readPricing: async () => ({
        kind: 'read',
        configuration: { catalog: [], sources: [] },
      }),
      writePricing: NOT_EXERCISED('a pricing write'),
    },
    configMutations: new KeyedSerialExecutor(),
    modelCatalogs: async () => ({}),
    transcriptFiles: () => ({ file: async () => undefined }),
    transcriptSources: [],
    clock: { now: () => '2026-10-20T12:00:00.000Z' },
    activities: undefined,
    machineName: () => null,
  };
}

const LIFECYCLE: ModuleLifecycle = { onRelease: () => undefined, releasing: () => false };

/** The module as production builds it, over the fixture's inputs. */
export function builtAnalytics(): BuiltModule<AnalyticsProvides, AnalyticsJobs> {
  return analyticsModule.build(analyticsNeeds(), undefined, LIFECYCLE);
}
