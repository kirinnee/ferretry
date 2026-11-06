import { usageModule, type UsageJobs, type UsageNeeds, type UsageProvides } from '../../../../bin/modules/usage.ts';
import { ActivityLedger } from '../../../../src/lib/index.ts';
import type { ConfigFilesService } from '../../../../src/lib/config-files/index.ts';
import type { OutboundAuthorizerPort } from '../../../../src/lib/index.ts';
import type { BuiltModule, ModuleLifecycle } from '../../../../src/lib/runtime/modules.ts';

/**
 * THE `usage` MODULE'S TEST CONSTRUCTION — a per-module fixture fragment (see `../learning/fixture.ts`).
 *
 * The REAL `usageModule.build(needs, seams, lifecycle)` over test inputs, so the surface tests consume what
 * production builds. Only the INPUTS are doubles. Building starts nothing: the quota reader reads only when
 * somebody watches, and the budget service AND its timer are a job (`jobs.startBudgets()`), never called here — so there is
 * no timer or async work to leave behind in the shared unit process.
 */

const NOT_EXERCISED = (what: string) => () => {
  throw new Error(`${what} is not exercised by the mounted-surface fixture`);
};

/** The inputs `fyd.ts` hands the module, over doubles. */
export function usageNeeds(): UsageNeeds {
  const authorizer: OutboundAuthorizerPort = { send: NOT_EXERCISED('an outbound send') };
  return {
    paths: { state: '/nonexistent/usage-fixture-state-home' },
    storage: {
      listSessions: () => [],
      readConfig: NOT_EXERCISED('a config read'),
      readState: NOT_EXERCISED('a state read'),
    },
    stateFiles: { readText: async () => undefined, writeTextAtomic: NOT_EXERCISED('a budget write') },
    configFiles: { current: NOT_EXERCISED('the configuration files') } as unknown as Pick<
      ConfigFilesService,
      'current'
    >,
    publishedManifest: async () => undefined,
    daemonConfigStore: { readPricing: NOT_EXERCISED('the pricing configuration') },
    modelCatalogs: { catalogs: NOT_EXERCISED('the model catalogs') },
    transcriptSources: [],
    transcriptFiles: () => ({ file: async () => undefined }),
    millisecondClock: { now: () => 0 },
    activities: new ActivityLedger({ now: () => 0 }, undefined, () => undefined),
    credentialCatalog: { entries: NOT_EXERCISED('the credential catalog') },
    presets: { presets: async () => [] },
    authorizer,
    ingestion: { read: NOT_EXERCISED('the analytics index') },
    sends: { interrupt: NOT_EXERCISED('an interrupt') },
    sessionControl: { stop: NOT_EXERCISED('a stop') },
    machineAgenda: { raiseOrUpdate: NOT_EXERCISED('a raise') },
    wardenBudgetMover: {},
    republishFleet: async () => undefined,
    machineName: () => 'fixture',
    clientName: 'fy',
  };
}

export const LIFECYCLE: ModuleLifecycle = { onRelease: () => undefined, releasing: () => false };

/** The module as production builds it, over the fixture's inputs. */
export function builtUsage(): BuiltModule<UsageProvides, UsageJobs> {
  return usageModule.build(usageNeeds(), undefined, LIFECYCLE);
}
