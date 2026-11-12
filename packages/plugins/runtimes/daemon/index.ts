/**
 * Runtimes' daemon half (§2.3, §3.3): the sixteen routes the manifest declares, and the `runtimes` port others read
 * through (`list`, `get`, `default`, `resolve`, the homes, the profile layers).
 *
 * `build` is synchronous and touches nothing but the kernel's ports: the routes are handlers over the services in
 * `lib/service`, the port is read from the declared configuration (`config/runtimes/*.yaml`, `config/profiles/*.yaml`,
 * `config/runtimes.yaml`) and from Ferrets, and a change to either publishes `runtimes.changed` /
 * `runtimes.default-changed` so a view wakes without polling.
 *
 * What the services stand on is `RuntimesAssembly`. {@link runtimesDaemon} takes a function that builds it from the
 * kernel's ports; the default is {@link hostAssembly}, the real one over the files (`host-assembly.ts`).
 * {@link unavailableAssembly} is the one that refuses every read and change in a sentence: it is what a daemon whose host
 * seams cannot be reached falls back to, and what the tests of that sentence build.
 *
 * LoginsPort is required and supplies safe sign-in facts: they are also what the model's logins are read from.
 */
import type { ConfigCollectionDef, ConfigFileDef, DoctorFinding } from '@ferretry/kernel/contract';
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
  type ModelSetFile,
  type ProfileFile,
  type RuntimeFile,
  RuntimeHomeUnreadable,
  type RuntimeHomesApi,
  type RuntimesFile,
} from '../contract/index.ts';
import manifest from '../manifest.ts';
import { fleetHomes } from './adapters/fleet-home-reader.ts';
import { endedSeams, fileAssembly, launchFactsSource } from './host-assembly.ts';
import { LaunchGate, type RuntimeLaunchFactsSource } from './lib/launch-gate.ts';
import { FleetPublication } from './lib/service/publication.ts';
import { assembleServices, unavailableCatalogDeps, unavailableSetupDeps } from './lib/service/assembly.ts';
import type { FleetCatalogService } from './lib/service/catalog-service.ts';
import { autoResumeAnswer, autoResumeSwitch, readAutoResume } from './lib/service/auto-resume-answer.ts';
import { runtimeStartAnswer } from './lib/service/runtime-start-answer.ts';
import { DisableExpiryWatch, earliestExpiry, keepUnpublished, runtimesBackOn } from './lib/service/disable-expiry.ts';
import { loginUsers } from './lib/service/login-users.ts';
import { createProfileLayers } from './lib/service/profile-layers.ts';
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
    'machine' | 'components' | 'profiles' | 'previewProfile' | 'runtimes' | 'propose' | 'read' | 'apply' | 'serialise'
  > &
    Partial<Pick<FleetCatalogService, 'republish'>>;
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
  /** The harness homes the fleet published and a reader of one. Absent: no homes (the fail-closed fallback). */
  readonly homes?: RuntimeHomesApi;
  /**
   * The etag of one profile file as it is on disk right now, reckoned as the kernel's config writer reckons it (what a
   * change's `ifMatch` is compared with; `ConfigPort.etag` for a host). Absent: the
   * profile layers answer in a sentence that they cannot read the files, and change nothing.
   */
  readonly profileEtag?: (profile: string) => Promise<string>;
  /**
   * The machine's "Auto-resume after restart" switch: `true` on, `false` off, `undefined` when it cannot be read (a no:
   * nothing is resumed). Absent, the switch is `runtimes.yaml` `autoResume` as that file stands; present, this answer is
   * used as given and `undefined` never falls back to the file.
   */
  readonly autoResume?: () => boolean | undefined;
  /**
   * Builds what the services stand on NOW and throws a sentence when it cannot be (the fleet folder cannot be opened).
   * `fy doctor` calls it: the build itself touches nothing, so a broken fleet root would otherwise show only as routes
   * that fail. Absent: nothing to probe, which `fy doctor` says.
   */
  readonly probe?: () => void;
  /**
   * The published runtimes' launch facts (`lib/launch-gate.ts`): the compaction trigger a Claude start is checked against and
   * carries. Absent: a start of a runtime is refused rather than launched unchecked.
   */
  readonly launchFacts?: RuntimeLaunchFactsSource;
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

/** The homes of a daemon whose assembly offers none: no home is published, so no reader is handed out. */
const noHomes: RuntimeHomesApi = { homes: async () => [], home: () => undefined };

/** The names whose parsed value differs between two readings of a collection. */
function changedNames<Shape>(before: ReadonlyMap<string, Shape>, after: ReadonlyMap<string, Shape>): readonly string[] {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names]
    .filter(name => JSON.stringify(before.get(name)) !== JSON.stringify(after.get(name)))
    .toSorted((left, right) => left.localeCompare(right));
}

/** `make` run at most once, on the first call. */
function once<Value>(make: () => Value): () => Value {
  let made: { readonly value: Value } | undefined;
  return () => {
    made ??= { value: make() };
    return made.value;
  };
}

/** An object that stands for `make()` and builds it on the first property read; methods run on the real object. */
function deferred<Target extends object>(make: () => Target): Target {
  return new Proxy({} as Target, {
    get(_stand, property) {
      const target = make();
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    has: (_stand, property) => property in make(),
  });
}

/**
 * The homes service built once, on the first call, and handed out as a plain object (a spread copies its own keys; a
 * proxy has none). One build keeps the homes `homes()` listed for the `home(id)` that follows.
 */
function onceHomes(make: () => RuntimeHomesApi): RuntimeHomesApi {
  const built = once(make);
  return {
    // A fleet folder that cannot be opened is the typed refusal the contract names, not whatever the build threw.
    homes: async () => {
      let service: RuntimeHomesApi;
      try {
        service = built();
      } catch {
        throw new RuntimeHomeUnreadable('The fleet folder could not be opened.');
      }
      return await service.homes();
    },
    // `home()` is `RuntimeHomeReader | undefined`: it never throws, and a fleet that cannot be opened names no home.
    home: id => {
      try {
        return built().home(id);
      } catch {
        return undefined;
      }
    },
    // The asset tree answers through the same built service; a fleet that cannot be opened lists and reads nothing.
    assetSkills: () => ({
      skills: async limit => {
        try {
          return (await built().assetSkills?.().skills(limit)) ?? [];
        } catch {
          return [];
        }
      },
      skillManifest: async (name, maxBytes) => {
        try {
          return await built().assetSkills?.().skillManifest(name, maxBytes);
        } catch {
          return undefined;
        }
      },
    }),
  };
}

/**
 * The assembly of this build, and the daemon's default: the catalogue and the setup over the files (the model in effect
 * from Runtimes' own files and Logins' facts, the provisioner on the `fleet` root, the all-or-none config writer), the
 * published fleet and an ended Codex ferret's follow-up through the kernel's roots and processes. What the kernel does
 * not open (another plugin's components, the tool installer, the secret store) stays unavailable and says so.
 */
export const hostAssembly: RuntimesAssembler = ctx => {
  // ONE publication gate: every apply (the catalogue's and the setup's share one provisioner) runs exclusively under
  // it, and every read of the published fleet (the ended-runtime seams, the manifest the republish compares) waits (S67).
  const publication = new FleetPublication();
  // `build` touches nothing (it is also run against an inert kernel to compare it with the manifest): the fleet folder
  // is opened and its paths spelled on the first use of a service, never while the half is built.
  let said = false;
  const assembled = once(() => {
    try {
      return { ...fileAssembly(ctx, publication), ended: endedSeams(ctx.kernel, publication) };
    } catch (error) {
      // The build no longer fails when the fleet folder cannot be opened, so say so here, once, and in `fy doctor`.
      if (!said) {
        said = true;
        ctx.kernel.log.warn(
          `Runtimes could not open the fleet folder, so its catalogue, setup and ended-runtime follow-up are unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw error;
    }
  });
  return {
    catalog: deferred(() => assembled().catalog),
    setup: deferred(() => assembled().setup),
    ended: deferred(() => assembled().ended),
    homes: onceHomes(() =>
      fleetHomes(ctx.kernel.roots, publication, sentence => {
        ctx.kernel.log.warn(sentence);
      }),
    ),
    profileEtag: async profile => await assembled().profileEtag(profile),
    launchFacts: launchFactsSource(ctx.kernel, publication),
    probe: () => {
      assembled();
    },
  };
};

export function runtimesDaemon(assemble: RuntimesAssembler = hostAssembly) {
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
      });
      // What a runtime's profile stack names, and the one act that edits a profile's layers: read live, written through
      // the kernel's config writer, never kept. The etag is the profile file's own, read when asked.
      const layers = createProfileLayers({
        runtimes: () => config.collection(runtimeItems),
        profiles: () => config.collection(profileItems),
        etag: async name => {
          if (assembly.profileEtag === undefined)
            throw new Error('Runtimes cannot read its profile files on this daemon right now');
          return await assembly.profileEtag(name);
        },
        state: name => config.fileState(profileItems, name),
        writeAll: async documents => await config.writeAll(documents),
        // The same one-at-a-time section as an apply (S67). A daemon whose catalogue cannot be opened has no apply to
        // run beside, so the act stands alone there (and its etag read refuses in a sentence).
        serialise: async act => {
          let entered = false;
          try {
            return await assembly.catalog.serialise(async () => {
              entered = true;
              return await act();
            });
          } catch (error) {
            // The section itself could not be reached: stand alone. Whatever the act itself threw is not caught here.
            if (entered) throw error;
            return await act();
          }
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
          // The fleet manifest and the wrappers are published again AT this instant (docs/disabling.md), under the
          // same exclusive section as every apply. A republish that cannot run (the model is not readable yet) is said
          // once and never stops the views from hearing it.
          await assembly.catalog.republish?.().catch((error: unknown) => {
            ctx.kernel.log.warn(
              `a login or runtime switched off until a time came back on, but the fleet could not be published again: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
          const now = clock.nowMs();
          const after = expiredUpTo;
          expiredUpTo = now;
          const back = runtimesBackOn(config.collection(runtimeItems), armedLogins, after, now);
          if (back.length > 0) events.publish(RuntimesChanged, { runtimes: [...back], profiles: [], modelSets: [] });
        },
        setTimer: (run, ms) => clock.after(milliseconds(ms), run),
      });
      void expiry.rearm();
      // A republish that cannot run (the model is not readable yet) is said once and never fails the event.
      const republishForBudget = async (): Promise<void> => {
        await assembly.catalog.republish?.().then(
          () => undefined,
          (error: unknown) => {
            ctx.kernel.log.warn(
              `a login's budget hold moved, but the fleet could not be published again: ${error instanceof Error ? error.message : String(error)}`,
            );
          },
        );
      };
      const unwatchExpiry = config.watch(RUNTIME_ITEMS, () => void expiry.rearm());
      ctx.kernel.lifecycle.onStop(() => {
        unwatchExpiry();
        expiry.stop();
      });

      // Ferrets never calls a plugin (§2.1): Runtimes hears that a ferret stopped and looks after its own runtime.
      const ending = new RuntimeEndSupervision({
        ferrets: ctx.needs.ferrets,
        seams: assembly.ended,
        warn: message => {
          ctx.kernel.log.warn(message);
        },
        launchFailed: failure => events.publish(RuntimesLaunchFailed, failure),
      });

      // What the launch gate reads: the published runtimes. Absent facts refuse a start of a runtime (fail closed).
      const launchFacts: RuntimeLaunchFactsSource = assembly.launchFacts ?? {
        facts: async () => {
          throw new Error('the published runtimes are not available on this daemon');
        },
      };

      // ONE gate: its `start.decide` keeps the facts it read and its `launch.parts` contributes from exactly those.
      const launchGate = new LaunchGate({ source: launchFacts });

      return {
        routes: {
          ...fleetCatalogRoutes(assembly.catalog),
          ...fleetSetupRoutes(assembly.setup),
          ...ferretRuntimeRoutes(assembly.runtime),
        },
        provides: { runtimes: { ...api, ...layers, ...(assembly.homes ?? noHomes) } },
        doctor: {
          // The half builds without opening the fleet folder, so a broken fleet root shows here, not as a failed boot.
          'runtimes-config': async (): Promise<DoctorFinding> => {
            if (assembly.probe === undefined)
              return {
                state: 'warn',
                detail:
                  'Runtimes is running without its host seams, so every catalogue read and change answers that it is unavailable',
                fix: 'restart the daemon; if this stays, report it',
              };
            try {
              assembly.probe();
            } catch (error) {
              return {
                state: 'fail',
                detail: `the fleet folder could not be opened, so Runtimes cannot read or change anything: ${error instanceof Error ? error.message : String(error)}`,
                fix: 'check that the Ferretry home is a folder this user can write, then restart the daemon',
              };
            }
            return { state: 'ok', detail: 'the fleet folder is open' };
          },
        },
        // Logins asks which runtimes use a login before it removes one (`logins.used-by`).
        hooks: {
          // The login's compaction trigger, from the facts `start.decide` read (never its environment: docs/secrets.md).
          'launch.parts': () => [{ id: 'runtimes-compact-at', item: launchGate.parts }],
          'logins.used-by:runtimes': loginUsers(() => config.collection(runtimeItems)),
          // Whether an automatic resume may spend (W2-a): the switch, then the ferret's runtime, each a no when in doubt.
          'auto-resume.decide': autoResumeAnswer({
            switchOn: () =>
              readAutoResume(assembly.autoResume, () =>
                autoResumeSwitch(config.fileState(runtimesFile).state, config.file(runtimesFile)),
              ),
            resolve: async id => await api.resolve(id),
          }),
          // A start that names a runtime spends that runtime's login: its harness and login, or why it cannot start now.
          'runtime.start:runtimes': {
            resolve: runtimeStartAnswer({ resolve: async id => await api.resolve(id) }),
          },
          // A start's own compaction trigger is judged against its model's window, and the facts launch.parts uses are read
          // here; with no facts to read, a Claude start of a runtime is refused.
          'start.decide': launchGate.decide,
        },

        subscribers: {
          'ferrets.changed': async change => await ending.onChanged(change),
          // A login switched off or on, or its `until` moved: the expiry timer reads the logins again.
          'logins.changed': async () => await expiry.rearm(),
          // A login its budget starts or stops holding: the fleet is published again so its wrappers follow (docs/budgets.md).
          'usage.login-paused': async () => await republishForBudget(),
          'usage.login-resumed': async () => await republishForBudget(),
        },
      };
    },
  });
}

export default runtimesDaemon();
