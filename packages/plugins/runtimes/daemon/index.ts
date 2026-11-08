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
 *  - GAP(kernel): an all-or-none write of a change's several configuration documents. The kernel's config write port
 *    (`ConfigPort.write`) writes one declared file per call; the apply pipeline writes through
 *    {@link RuntimeConfigWriter} (`lib/service/ports.ts`), which stays `refusingConfigWriter` until the catalogue is
 *    composed over the host (below) and the documents can land together.
 *  - GAP(kernel): `permissions.roots` is empty and `RootName` is a fixed set, so the state home's `fleet/` folder and
 *    the harnesses' own homes are out of reach; the adapters (`daemon/adapters`) are written against narrow host ports
 *    and take their real answers from the kernel when it opens those.
 * LoginsPort is required and supplies safe sign-in facts independently of the pending host assembly.
 */
import type { ConfigCollectionDef, ConfigFileDef } from '@ferretry/kernel/contract';
import { implementDaemon, type DaemonContext } from '@ferretry/kernel/manifest';
import { milliseconds } from '@ferretry/std';
import type { LoginView } from '@ferretry/plugin-logins/contract';
import {
  MODEL_SET_ITEMS,
  PROFILE_ITEMS,
  RUNTIME_ITEMS,
  RUNTIMES_CONFIG,
  RuntimesChanged,
  RuntimesDefaultChanged,
  RuntimesLaunchFailed,
  type ApplyOutcome,
  type CatalogInstallChange,
  type ModelSetFile,
  type ProfileFile,
  type RuntimeFile,
  type RuntimesFile,
} from '../contract/index.ts';
import manifest from '../manifest.ts';
import { endedSeams } from './host-assembly.ts';
import { assembleServices, unavailableCatalogDeps, unavailableSetupDeps } from './lib/service/assembly.ts';
import type { FleetCatalogService } from './lib/service/catalog-service.ts';
import { autoResumeAnswer, autoResumeSwitch } from './lib/service/auto-resume-answer.ts';
import { DisableExpiryWatch, earliestExpiry, keepUnpublished, runtimesBackOn } from './lib/service/disable-expiry.ts';
import { loginUsers } from './lib/service/login-users.ts';
import { createRuntimesApi } from './lib/service/runtimes-api.ts';
import { RuntimeEndSupervision, type RuntimeEndSeams } from './lib/service/runtime-end-supervision.ts';
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
  /**
   * What an ended Codex ferret's follow-up stands on: the app-server supervisor, a runtime's published wrapper and the
   * dead pane's last screen. Absent until the host offers the process and pane seams; the subscriber then does nothing.
   */
  readonly ended?: RuntimeEndSeams;
  /**
   * The machine's "Auto-resume after restart" switch (`machine.yaml` `autoResume`): `true` on, `false` off. Absent, or
   * answering `undefined`, until the host assembly reaches the account model: auto-resume then resumes nothing (W2-a).
   */
  readonly autoResume?: () => boolean | undefined;
}

export type RuntimesAssembler = (ctx: DaemonContext<typeof manifest>) => RuntimesAssembly;

/** The assembly of a daemon whose host seams are not wired: every read and change answers in a sentence. */
export const unavailableAssembly: RuntimesAssembler = ctx => {
  const catalogDeps = unavailableCatalogDeps(
    () => ctx.kernel.clock.nowMs(),
    ctx.needs.logins,
    ctx.needs.loginChanges,
    (message, fields) => {
      ctx.kernel.log.warn(message, fields);
    },
  );
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

      // A runtime, or the login it runs on, switched off `until` a time reads as on once that time passes (the port
      // judges both blocks at now), so the views are told AT that instant rather than at their next read
      // (docs/disabling.md). One timer, for the earliest `until` ahead among the runtime files and the logins (read
      // through the Logins port), set again whenever a runtime file moves or Logins says a login changed.
      //
      // Logins drops a login's `disabled` from its view once the `until` has passed, so the list read when the timer
      // fires no longer names the block that expired: the fire judges the logins' `until`s as the arming read saw them.
      // A re-read that lands after a login's `until` passed but before the timer fired keeps the block it no longer
      // names, so that expiry is still published; the timer is set for the earliest `until` not yet published, which
      // fires at once for one already past.
      // A login list that cannot be read counts as no login blocks, so the runtimes' own `until`s still arm and publish.
      const loginBlocks = async (): Promise<ReadonlyMap<string, LoginView>> =>
        await ctx.needs.logins.list().then(
          list => new Map(list.logins.map(view => [view.id as string, view])),
          () => {
            ctx.kernel.log.warn('the logins could not be read: a login switched off until a time is not watched');
            return new Map();
          },
        );
      let expiredUpTo = clock.nowMs();
      let armedLogins: ReadonlyMap<string, LoginView> = new Map();
      let loginReads = 0;
      const expiry = new DisableExpiryWatch({
        next: async () => {
          const read = ++loginReads;
          const fresh = await loginBlocks();
          // An older read landing after a newer one never replaces what the newer one saw.
          // `rearm` discards the value of a stale read (its generation moved), so there is none to compute.
          if (read !== loginReads) return undefined;
          armedLogins = keepUnpublished(armedLogins, fresh, expiredUpTo, clock.nowMs());
          return earliestExpiry(config.collection(runtimeItems), armedLogins, expiredUpTo);
        },
        now: () => clock.nowMs(),
        republish: async () => {
          const now = clock.nowMs();
          const after = expiredUpTo;
          expiredUpTo = now;
          const back = runtimesBackOn(config.collection(runtimeItems), armedLogins, after, now);
          if (back.length > 0) events.publish(RuntimesChanged, { runtimes: [...back], profiles: [], modelSets: [] });
        },
        setTimer: (run, ms) => clock.after(milliseconds(ms), run),
      });
      void expiry.rearm();
      const unwatchExpiry = config.watch(RUNTIME_ITEMS, () => void expiry.rearm());
      ctx.kernel.lifecycle.onStop(() => {
        unwatchExpiry();
        expiry.stop();
      });

      // Ferrets never calls a plugin (§2.1): Runtimes hears that a ferret stopped and looks after its own runtime.
      const ending = new RuntimeEndSupervision({
        ferrets: ctx.needs.ferrets,
        seams: assembly.ended,
        launchFailed: failure => events.publish(RuntimesLaunchFailed, failure),
      });

      return {
        routes: {
          ...fleetCatalogRoutes(assembly.catalog),
          ...fleetSetupRoutes(assembly.setup),
          ...ferretRuntimeRoutes(assembly.runtime),
        },
        provides: { runtimes: api },
        // Logins asks which runtimes use a login before it removes one (`logins.used-by`).
        hooks: {
          'logins.used-by:runtimes': loginUsers(() => config.collection(runtimeItems)),
          // Whether an automatic resume may spend (W2-a): the switch, then the ferret's runtime, each a no when in doubt.
          'auto-resume.decide': autoResumeAnswer({
            switchOn: () =>
              assembly.autoResume?.() ??
              autoResumeSwitch(config.fileState(runtimesFile).state, config.file(runtimesFile)),
            resolve: async id => await api.resolve(id),
          }),
        },
        subscribers: {
          'ferrets.changed': async change => await ending.onChanged(change),
          // A login switched off or on, or its `until` moved: the expiry timer reads the logins again.
          'logins.changed': async () => await expiry.rearm(),
        },
      };
    },
  });
}

/** The assembly of this build: the services stay unwired where the kernel offers no way yet, the rest is the host's. */
const hostAssembly: RuntimesAssembler = ctx => ({ ...unavailableAssembly(ctx), ended: endedSeams(ctx.kernel) });

export default runtimesDaemon(hostAssembly);
