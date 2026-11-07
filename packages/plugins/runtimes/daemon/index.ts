/**
 * Runtimes' daemon half (§2.3, §3.3): the sixteen routes the manifest declares, and the `runtimes` port others read
 * through (`list`, `get`, `default`, `resolve`, `installCatalogItem`).
 *
 * `build` is synchronous and touches nothing but the kernel's ports: the routes are handlers over the services in
 * `lib/service`, the port is read from the declared configuration (`config/runtimes/*.yaml`, `config/profiles/*.yaml`,
 * `config/runtimes.yaml`) and from Ferrets, and a change to either publishes `runtimes.changed` /
 * `runtimes.default-changed` so a view wakes without polling.
 *
 * What the services stand on is `RuntimesAssembly`. {@link runtimesDaemon} takes a function that builds it from the
 * kernel's ports; the default builds the one that refuses in a sentence, because host collaborators are not yet reachable
 * from a plugin:
 *
 *  - GAP(kernel): a config WRITE port. The apply pipeline writes through {@link RuntimeConfigWriter}
 *    (`lib/service/ports.ts`); until the kernel offers one it is `refusingConfigWriter`.
 *  - GAP(kernel): `permissions.roots` is empty and `RootName` is a fixed set, so the state home's `fleet/` folder and
 *    the harnesses' own homes are out of reach; the adapters (`daemon/adapters`) are written against narrow host ports
 *    and take their real answers from the kernel when it opens those.
 * LoginsPort is required and supplies safe sign-in facts independently of the pending host assembly.
 */
import type { ConfigCollectionDef, ConfigFileDef } from '@ferretry/kernel/contract';
import { implementDaemon, type DaemonContext } from '@ferretry/kernel/manifest';
import {
  MODEL_SET_ITEMS,
  PROFILE_ITEMS,
  RUNTIME_ITEMS,
  RUNTIMES_CONFIG,
  RuntimesChanged,
  RuntimesDefaultChanged,
  type ApplyOutcome,
  type CatalogInstallChange,
  type ModelSetFile,
  type ProfileFile,
  type RuntimeFile,
  type RuntimesFile,
} from '../contract/index.ts';
import manifest from '../manifest.ts';
import { assembleServices, unavailableCatalogDeps, unavailableSetupDeps } from './lib/service/assembly.ts';
import type { FleetCatalogService } from './lib/service/catalog-service.ts';
import { createRuntimesApi } from './lib/service/runtimes-api.ts';
import type { FleetSetupService } from './lib/service/setup-service.ts';
import { ferretRuntimeRoutes } from './routes/ferret-runtime.ts';
import { fleetCatalogRoutes } from './routes/fleet-catalog.ts';
import { fleetSetupRoutes } from './routes/fleet-setup.ts';

// The contract widens its config defs so `manifest.data.config` accepts them (`contract/config-def.ts`); these put the shapes back.
const runtimeItems = RUNTIME_ITEMS as unknown as ConfigCollectionDef<RuntimeFile>;
const profileItems = PROFILE_ITEMS as unknown as ConfigCollectionDef<ProfileFile>;
const modelSetItems = MODEL_SET_ITEMS as unknown as ConfigCollectionDef<ModelSetFile>;
const runtimesFile = RUNTIMES_CONFIG as unknown as ConfigFileDef<RuntimesFile>;

/** What the routes and the port stand on. */
export interface RuntimesAssembly {
  readonly catalog: Pick<
    FleetCatalogService,
    | 'machine'
    | 'components'
    | 'profiles'
    | 'previewProfile'
    | 'runtimes'
    | 'propose'
    | 'read'
    | 'apply'
    | 'installCatalogItem'
  >;
  readonly setup: Pick<
    FleetSetupService,
    'scan' | 'installTools' | 'exportBundle' | 'reviewClone' | 'forgetCloneSource' | 'recordCloneKeys' | 'executors'
  >;
  /** Running-ferret model discovery and controls. Pending until Ferrets exposes these operations. */
  readonly runtime?: import('./routes/ferret-runtime.ts').FerretRuntimeSubsystem;
}

export type RuntimesAssembler = (ctx: DaemonContext<typeof manifest>) => RuntimesAssembly;

/** The assembly of a daemon whose host seams are not wired: every read and change answers in a sentence. */
export const unavailableAssembly: RuntimesAssembler = ctx => {
  const catalogDeps = unavailableCatalogDeps(() => ctx.kernel.clock.nowMs(), ctx.needs.logins);
  const services = assembleServices(catalogDeps, unavailableSetupDeps);
  return services;
};

/** The names whose parsed value differs between two readings of a collection. */
function changedNames<Shape>(before: ReadonlyMap<string, Shape>, after: ReadonlyMap<string, Shape>): readonly string[] {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names]
    .filter(name => JSON.stringify(before.get(name)) !== JSON.stringify(after.get(name)))
    .toSorted((left, right) => left.localeCompare(right));
}

export function runtimesDaemon(assemble: RuntimesAssembler = unavailableAssembly) {
  return implementDaemon(manifest, {
    build(ctx) {
      const { config, events, clock } = ctx.kernel;
      const assembly = assemble(ctx);

      const api = createRuntimesApi({
        runtimes: () => config.collection(runtimeItems),
        profiles: () => config.collection(profileItems),
        defaultSetting: () => config.file(runtimesFile)?.defaultRuntime,
        harnesses: () => ctx.needs.ferrets.harnesses(),
        logins: ctx.needs.logins,
        now: () => clock.nowMs(),
        install: async (change: CatalogInstallChange): Promise<ApplyOutcome> => {
          const { outcome } = await assembly.catalog.installCatalogItem(change);
          // `installCatalogItem` throws for anything that did not land; an `applied` outcome is the only one it returns.
          if (outcome.outcome !== 'applied') throw new Error('the catalog item was not installed');
          events.publish(RuntimesChanged, { runtimes: [], profiles: [change.profile], modelSets: [] });
          return outcome.apply;
        },
      });

      // A change to the files wakes the views, once per change and naming what moved. The first reading is the baseline.
      let runtimes = config.collection(runtimeItems);
      let profiles = config.collection(profileItems);
      let modelSets = config.collection(modelSetItems);
      let defaultSetting = config.file(runtimesFile)?.defaultRuntime;
      const announce = (): void => {
        const nextRuntimes = config.collection(runtimeItems);
        const nextProfiles = config.collection(profileItems);
        const nextModelSets = config.collection(modelSetItems);
        const moved = {
          runtimes: changedNames(runtimes, nextRuntimes),
          profiles: changedNames(profiles, nextProfiles),
          modelSets: changedNames(modelSets, nextModelSets),
        };
        runtimes = nextRuntimes;
        profiles = nextProfiles;
        modelSets = nextModelSets;
        if (moved.runtimes.length + moved.profiles.length + moved.modelSets.length > 0)
          events.publish(RuntimesChanged, moved);
      };
      config.watch(RUNTIME_ITEMS, announce);
      config.watch(PROFILE_ITEMS, announce);
      config.watch(MODEL_SET_ITEMS, announce);
      config.watch(RUNTIMES_CONFIG, () => {
        const next = config.file(runtimesFile)?.defaultRuntime;
        if (next === defaultSetting) return;
        defaultSetting = next;
        void api.default().then(
          chosen => events.publish(RuntimesDefaultChanged, { defaultRuntime: chosen ?? null }),
          () => events.publish(RuntimesDefaultChanged, { defaultRuntime: null }),
        );
      });

      return {
        routes: {
          ...fleetCatalogRoutes(assembly.catalog),
          ...fleetSetupRoutes(assembly.setup),
          ...ferretRuntimeRoutes(assembly.runtime),
        },
        provides: { runtimes: api },
      };
    },
  });
}

export default runtimesDaemon();
