/**
 * What Runtimes' daemon half builds from the kernel's ports today (docs/design/redesign.md §7.7), each piece one the
 * kernel now offers and the plugin declares in its manifest:
 *
 *  - the published fleet, read through the `fleet` root ({@link publishedFleet}) between applies (S67);
 *  - an ended Codex ferret's follow-up ({@link endedSeams}): the app-server supervisor over the fleet root and
 *    `kernel.processes`, and a runtime's published wrapper;
 *  - the machine's "Auto-resume after restart" switch, from Runtimes' own `runtimes.yaml`;
 *  - the catalogue and the setup over the files ({@link fileAssembly}): the file provisioner on the fleet root (its
 *    apply claim, its journal, the publication gate), the all-or-none config writer on `ConfigPort.writeAll`, and the
 *    first-run scan over the harness homes;
 *  - the account model in effect and its edit renderer, over Runtimes' own files and Logins' facts
 *    (`adapters/runtimes-config-files.ts`), so a catalogue read answers real data;
 *  - a command's location, looked up ahead through `kernel.paths.which` (`adapters/command-cache.ts`).
 *
 * What is NOT here is what another plugin owns: its components and a login's templates stand in (and an apply is refused
 * while one does), the tool installer, the secret store's list and put; each is a declared
 * GAP in `ports-pending.json`. The machine's name and id are the kernel's `identity`.
 */
import type { FerretsApi, FerretState } from '@ferretry/core-ferrets/contract';
import type { ConfigPort, KernelPorts, RootHandle, RootsPort } from '@ferretry/kernel/contract';
import { type SecretName, SecretNameSchema, type VaultApi } from '@ferretry/core-vault/contract';
import type { HookInvoker } from '@ferretry/kernel/manifest';
import type { UsageApi } from '@ferretry/plugin-usage/contract';
import { InstantSchema, milliseconds } from '@ferretry/std';
import type { LoginsApi } from '@ferretry/plugin-logins/contract';
import { PROFILE_COMPONENTS_KEY, PROFILE_ITEMS, type RuntimeCheckEnvironment } from '../contract/index.ts';
import { applyClaimFor } from './adapters/apply-claim.ts';
import { componentWriters } from './adapters/component-writers.ts';
import { configDirectoryOf, fileFleetCatalogDeps } from './adapters/account-model-files.ts';
import { CommandCache } from './adapters/command-cache.ts';
import { harnessAwareWhich } from './adapters/harness-lookup.ts';
import { statePins } from './adapters/starter-pins.ts';
import { HostPlatform } from './adapters/host-platform.ts';
import { toolInstaller } from './adapters/tool-installer.ts';
import { harnessKits, PROVIDER_ANSWER_MS, withinMs } from './adapters/profile-components.ts';
import { writeAllConfigWriter } from './adapters/config-write-all.ts';
import { credentialMounts, FleetDisk, sourceMounts } from './adapters/fleet-disk.ts';
import { FleetManifestUnreadableError, manifestIsUnreadable, readFleetManifest } from './adapters/manifest-file.ts';
import type { RuntimeLaunchFactsSource } from './lib/launch-gate.ts';
import type { AdapterHost } from './adapters/ports.ts';
import { refuseBeforeWriting, runtimesConfigFiles } from './adapters/runtimes-config-files.ts';
import { fleetMounts, harnessMounts, rootHostFiles } from './adapters/root-host-files.ts';
import { loginsLaunchStores, loginsModelCatalogs } from './adapters/model-sources.ts';
import { fileFleetSetupDeps } from './adapters/setup-files.ts';
import { unavailableSharedHistory } from './adapters/shared-history-unavailable.ts';
import { supportedKinds } from './lib/harness-kind.ts';
import type { AccountModel } from './lib/account/schema.ts';
import { type FleetManifest, type HarnessKind, harnessKindOfKey } from './lib/manifest.ts';
import { claudeStatuslineFor } from './lib/account/statusline.ts';
import { assembleServices, unavailableSetupDeps } from './lib/service/assembly.ts';
import { CodexAppServerSupervisor } from './lib/service/codex-runtime.ts';
import type { FleetCatalogServiceDeps } from './lib/service/catalog-service.ts';
import { FleetPublication } from './lib/service/publication.ts';
import type { FleetSetupServiceDeps } from './lib/service/setup-service.ts';
import { RuntimeSessionRecords, SESSION_STATUS_OF } from './adapters/runtime-session-records.ts';
import type { RuntimeEndSeams } from './lib/service/runtime-end-supervision.ts';

/** The published manifest's name in the fleet folder. */
const MANIFEST_FILE = 'manifest.json';

/** What a person types to run this binary: the wrapper's history claim and the statusLine run it. */
const CLIENT_NAME = 'fy';

/** The thin adapter over Ferrets' two session-record members, or `undefined` when this Ferrets offers neither. */
function sessionRecordsOver(ferrets: Pick<FerretsApi, 'runtimeRecords' | 'repointRuntime'>): {
  readonly sessionRecords?: RuntimeSessionRecords;
} {
  // Called through the port, never detached from it: a port may be an object whose members read their own state.
  if (ferrets.runtimeRecords === undefined || ferrets.repointRuntime === undefined) return {};
  return {
    sessionRecords: new RuntimeSessionRecords({
      runtimeRecords: async () => (await ferrets.runtimeRecords?.()) ?? [],
      repointRuntime: async rename => (await ferrets.repointRuntime?.(rename)) ?? 0,
    }),
  };
}

/**
 * The fleet folder's absolute path, as the `fleet` root names it (the manifest's absolute paths are spelled with it).
 * The kernel keeps no link from the home down to the root, so the root's own spelling is its real one.
 */
function fleetDirectory(fleet: RootHandle): string {
  const base = fleet.resolve('.');
  if (!base.ok) throw new Error(`the fleet folder could not be opened (${base.error})`);
  return base.value.endsWith('/.') ? base.value.slice(0, -2) : base.value;
}

/**
 * The published fleet: its folder and the manifest an apply wrote, or `undefined` for a machine no apply has reached.
 * The manifest is read between applies (S67): a read waits for an apply in flight rather than reading the gap.
 */
async function publishedFleet(
  roots: Pick<RootsPort, 'root'>,
  fleet: RootHandle,
  publication: FleetPublication,
): Promise<{ readonly directory: string; readonly manifest: FleetManifest | undefined }> {
  const directory = fleetDirectory(fleet);
  const files = rootHostFiles(fleetMounts(roots, fleet, directory));
  return {
    directory,
    manifest: await publication.reading(async () => await readFleetManifest(files, `${directory}/${MANIFEST_FILE}`)),
  };
}

/**
 * Whether the published manifest exists and cannot be read, in ONE publication read. It is the daemon's boot check: a
 * manifest the last version wrote in a shape this one does not read is rebuilt from the configuration by a republish
 * (derived data, never fatal), so every start does not stay refused until some other change happens to publish.
 */
/** The job that rebuilds an unreadable manifest: once after start, and whenever a launch reader meets the damage. */
export const MANIFEST_REPAIR_JOB = 'runtimes.manifest-repair';

/**
 * Who owns the manifest repair: the repair job, from the moment an attempt begins until one succeeds. It spans the
 * attempt that is RUNNING and the backoff that follows a failed one (the runner's retry timer is the job's own), so a
 * reader's request has one answer in both states: the owner already has it. A request made while it is held must not
 * run another attempt or leave another timer, so the traffic of refused starts adds no work and no timers.
 */
export class RepairOwner {
  #held = false;

  /** An attempt starts (the job's first act): the repair is now owned until {@link release}. */
  begin(): void {
    this.#held = true;
  }

  /** The manifest reads again: the repair is done, and the next damage is a new request. */
  release(): void {
    this.#held = false;
  }

  get held(): boolean {
    return this.#held;
  }
}

/**
 * Asks for the repair job to run now (a launch reader met an unreadable manifest after a healthy start). It is the
 * runner's own single-flight kick, never a call into the repair, and it asks only when nobody owns the repair: while an
 * attempt runs or waits out its backoff the request coalesces into it (the attempt re-checks the manifest at its end, and
 * a failed one is retried by the runner's own timer). A daemon whose job is not registered has nothing to ask.
 */
export function repairRequester(kernel: Pick<KernelPorts, 'jobs'>, owner: RepairOwner = new RepairOwner()): () => void {
  return () => {
    if (owner.held) return;
    try {
      kernel.jobs.kick(MANIFEST_REPAIR_JOB);
    } catch {
      // No such job on this daemon: the refusal already says to try again and to restart if it stays.
    }
  };
}

export function manifestUnreadableProbe(
  kernel: Pick<KernelPorts, 'roots'>,
  publication: FleetPublication = new FleetPublication(),
): () => Promise<boolean> {
  return async () => {
    const fleet = kernel.roots.root('fleet');
    const directory = fleetDirectory(fleet);
    const files = rootHostFiles(fleetMounts(kernel.roots, fleet, directory));
    return await publication.reading(async () => await manifestIsUnreadable(files, `${directory}/${MANIFEST_FILE}`));
  };
}

/** What an ended Codex ferret's follow-up stands on, from the kernel's roots, processes and clock. */
export function endedSeams(
  kernel: Pick<KernelPorts, 'roots' | 'processes' | 'clock'>,
  publication: FleetPublication = new FleetPublication(),
): RuntimeEndSeams {
  const fleet = kernel.roots.root('fleet');
  const supervisor = new CodexAppServerSupervisor({
    inventory: {
      accounts: async () => (await publishedFleet(kernel.roots, fleet, publication)).manifest?.accounts ?? [],
    },
    host: { fleet, processes: kernel.processes },
    homesDirectory: () => `${fleetDirectory(fleet)}/homes`,
    sleep: async ms =>
      await new Promise<void>(resolve => {
        kernel.clock.after(milliseconds(ms), resolve);
      }),
  });
  return {
    supervisor,
    wrapperOf: async runtime =>
      (await publishedFleet(kernel.roots, fleet, publication)).manifest?.runtimes.find(
        published => published.name === runtime,
      )?.wrapper,
  };
}

/**
 * What a launch of a published runtime needs of it (`lib/launch-gate.ts`): its kind, its compaction trigger and the
 * model windows that cap it, all from the published manifest in ONE publication read ({@link FleetPublication.reading}),
 * so an apply cannot land between two reads. A runtime matches by name or by id. It reads no login environment and no
 * `fixed.json`: a project's own Claude settings win over a login's variables (docs/secrets.md).
 */
export function launchFactsSource(
  kernel: Pick<KernelPorts, 'roots'>,
  publication: FleetPublication = new FleetPublication(),
  requestRepair: () => void = () => {},
): RuntimeLaunchFactsSource {
  return {
    facts: async runtime => {
      const fleet = kernel.roots.root('fleet');
      const directory = fleetDirectory(fleet);
      const files = rootHostFiles(fleetMounts(kernel.roots, fleet, directory));
      try {
        return await publication.reading(async () => {
          const manifest = await readFleetManifest(files, `${directory}/${MANIFEST_FILE}`);
          const published = manifest?.runtimes.find(row => row.name === runtime || row.id === runtime);
          const account = manifest?.accounts.find(row => row.id === published?.id);
          if (published === undefined || account === undefined) return undefined;
          return {
            kind: account.kind,
            ...(typeof account.compactAt === 'number' ? { compactAt: account.compactAt } : {}),
            ...(account.autoRefusal === undefined ? {} : { autoRefusal: account.autoRefusal }),
            windows: {
              ...(account.defaultModel === null ? {} : { defaultModel: account.defaultModel }),
              models: account.models.map(model => ({
                id: model.id,
                ...(model.context === undefined ? {} : { context: model.context }),
              })),
            },
          };
        });
      } catch (error) {
        // Asked AFTER the publication read is released: the repair publishes, and the read itself never does.
        if (error instanceof FleetManifestUnreadableError) requestRepair();
        throw error;
      }
    },
  };
}

/**
 * What a published runtime's launch carries for a consumer that fills `${VAR}` from it (`RuntimeHomesApi.checkEnvironment`):
 * the plain variables its account published and the NAMES of the secret-bearing ones, read in ONE publication read.
 */
export function checkEnvironmentSource(
  kernel: Pick<KernelPorts, 'roots'>,
  publication: FleetPublication = new FleetPublication(),
  requestRepair: () => void = () => {},
): (runtime: string) => Promise<RuntimeCheckEnvironment | undefined> {
  return async runtime => {
    const fleet = kernel.roots.root('fleet');
    const directory = fleetDirectory(fleet);
    const files = rootHostFiles(fleetMounts(kernel.roots, fleet, directory));
    try {
      return await publication.reading(async () => {
        const manifest = await readFleetManifest(files, `${directory}/${MANIFEST_FILE}`);
        const published = manifest?.runtimes.find(row => row.name === runtime || row.id === runtime);
        const account = manifest?.accounts.find(row => row.id === published?.id);
        if (published === undefined || account === undefined) return undefined;
        return { values: account.launchEnv ?? {}, opaque: Object.keys(account.secretEnv).sort() };
      });
    } catch (error) {
      if (error instanceof FleetManifestUnreadableError) requestRepair();
      throw error;
    }
  };
}

/** The harness homes a first run may read and a component may come from: the person's own, by the OS's home. */
const harnessHomesOf = (userHome: string): readonly string[] => [`${userHome}/.claude`, `${userHome}/.codex`];

/** Text files of the fleet folder (the clone record, the export keys), written atomically at `0600`. */
function fleetTexts(disk: FleetDisk): AdapterHost['texts'] {
  return {
    read: async path => {
      const found = await disk.lstat(path);
      if (found === undefined) return null;
      if (found.kind !== 'file') throw new Error(`${path} must be a regular file`);
      return await disk.readText(path, 1024 * 1024);
    },
    write: async (path, text) => {
      await disk.makeFolder(path.slice(0, path.lastIndexOf('/')), 0o700);
      await disk.fleet.writeText(disk.fenced(path), text, { mode: 0o600 });
    },
  };
}

/** The harnesses a login can run on, by their command name. */
const INSTALLABLE: readonly HarnessKind[] = supportedKinds();

/** The harness commands every read asks about, looked up ahead (`./adapters/command-cache.ts`). */
const HARNESS_COMMANDS = ['claude', 'codex', 'npm', 'brew', 'apt-get'] as const;

/** A Claude account file is a few KiB; a larger one is not read. */
const MAX_ACCOUNT_FILE_BYTES = 1024 * 1024;

/**
 * The text of the person's own Claude account file (`~/.claude.json`), read through the host mount Runtimes' setup already
 * reads that file by (never a link, never larger than {@link MAX_ACCOUNT_FILE_BYTES}); nothing when it is absent or cannot
 * be read. It is for the ONE non-secret field the Claude channel's default needs (`organizationTypeOfAccountDocument`).
 */
export function hostClaudeAccountText(
  kernel: Pick<KernelPorts, 'roots' | 'paths' | 'clock'>,
): () => Promise<string | undefined> {
  return async () => {
    try {
      const { files } = fleetHost(kernel).host;
      const path = `${kernel.paths.home()}/.claude.json`;
      const info = await files.lstat(path);
      if (info?.kind !== 'file' || info.size > MAX_ACCOUNT_FILE_BYTES) return undefined;
      return await files.readText(path);
    } catch {
      return undefined;
    }
  };
}

/** The disk, the claim and the host the file adapters stand on, from the kernel's roots, clock and PATH lookup. */
export function fleetHost(
  kernel: Pick<KernelPorts, 'roots' | 'paths' | 'clock'>,
  commands: AdapterHost['commands'] = { which: () => undefined },
): {
  readonly host: AdapterHost;
  readonly directory: string;
} {
  const fleet = kernel.roots.root('fleet');
  const directory = fleetDirectory(fleet);
  const userHome = kernel.paths.home();
  const disk = new FleetDisk({
    fleet,
    directory,
    sources: sourceMounts(kernel.roots, directory, harnessHomesOf(userHome)),
    credentials: credentialMounts(kernel.roots, directory),
  });
  const files = rootHostFiles(
    (
      (fleetOnly, homes) => (path: string) =>
        fleetOnly(path) ?? homes(path)
    )(
      fleetMounts(kernel.roots, fleet, directory),
      harnessMounts(kernel.roots, harnessHomesOf(userHome), `${userHome}/.claude.json`),
    ),
  );
  const sleep = async (ms: number): Promise<void> =>
    await new Promise<void>(resolve => {
      kernel.clock.after(milliseconds(ms), resolve);
    });
  return {
    directory,
    host: {
      files,
      texts: fleetTexts(disk),
      // The services ask for a command synchronously and `kernel.paths.which` answers asynchronously: the answer is the
      // one looked up ahead of the read (`CommandCache`), and a command never looked up is not found.
      commands,
      disk,
      now: () => kernel.clock.nowMs(),
      claimFor: manifestPath => applyClaimFor(disk, manifestPath, { now: () => kernel.clock.nowMs(), sleep }),
    },
  };
}

/**
 * The catalogue and the setup, composed over the files: the file provisioner on the `fleet` root (S67: every apply
 * runs exclusively under `publication`), the all-or-none config writer on `ConfigPort.writeAll`, and the first-run
 * scan over the harness homes, and the account model read from Runtimes' own files and Logins' facts
 * (`./adapters/runtimes-config-files.ts`). An apply is refused while a part of the model stands in for a document
 * Runtimes cannot read (another plugin's component, a login's templates).
 */
export function fileAssembly(
  ctx: {
    readonly kernel: Pick<KernelPorts, 'roots' | 'paths' | 'clock' | 'log' | 'identity'> &
      Pick<KernelPorts, 'state'> &
      Partial<Pick<KernelPorts, 'spawn'>> & {
        readonly config: Pick<ConfigPort, 'writeAll' | 'collection' | 'file' | 'etag'>;
      };
    readonly needs: {
      readonly logins: FleetCatalogServiceDeps['credentials'] &
        Parameters<typeof fileFleetSetupDeps>[0]['logins'] &
        Pick<LoginsApi, 'environmentTemplates' | 'modelSources' | 'launchStores'>;
      readonly loginChanges: FleetCatalogServiceDeps['loginChanges'];
      /** Logins' door for an imported harness `env` (r9 A8): only Runtimes is handed one that writes. */
      readonly loginEnvImport?: FleetSetupServiceDeps['loginEnvImport'];
      /**
       * The Vault, through its NAME listing and its CREATE-ONLY write ONLY: `names` answers a name and two times, and `putNew`
       * takes a value in and never hands one back, so no value can flow out through it. Absent: the setup's secret read stays
       * unavailable and says so (a store that cannot be read refuses).
       */
      readonly vault?: Pick<VaultApi, 'names' | 'putNew' | 'filedSame'>;
      readonly ferrets: Pick<FerretsApi, 'lastAutoResume' | 'runtimeRecords' | 'repointRuntime'> & {
        list(): Promise<readonly { readonly state: FerretState }[]>;
      };
    };
    /** The hooks this plugin offers: the profile component sources the owning plugins take (read live, never kept). */
    readonly hooks: Pick<HookInvoker, 'provider'>;
    /** Usage is an optional need (§2.4): its handle answers `undefined` when the plugin is off. */
    readonly uses?: { readonly usage: { current(): Pick<UsageApi, 'pauses'> | undefined } };
  },
  publication: FleetPublication,
): Pick<ReturnType<typeof assembleServices>, 'catalog' | 'setup'> & {
  /** The etag of one profile file right now: the revision a change to it is pinned to. */
  readonly profileEtag: (profile: string) => Promise<string>;
  /** The harnesses installed here, as of the last lookup (`CommandCache`); the lookups are made ahead of every read. */
  readonly installed: () => readonly HarnessKind[];
  /** Looks the harness commands up ahead of a read of `installed`: the ONE lookup every read of it begins with. */
  readonly primeInstalled: () => Promise<void>;
} {
  const platform = new HostPlatform(() => ctx.kernel.spawn);
  const commands = new CommandCache(
    {
      which: harnessAwareWhich({
        which: async (name, options) => await ctx.kernel.paths.which(name, options),
        home: () => ctx.kernel.paths.home(),
        platform,
      }),
    },
    () => ctx.kernel.clock.nowMs(),
  );
  const installed = (): readonly HarnessKind[] => INSTALLABLE.filter(harness => commands.which(harness) !== undefined);
  const { host, directory } = fleetHost(ctx.kernel, commands);
  const home = directory.slice(0, directory.lastIndexOf('/'));
  const configDirectory = configDirectoryOf(home);
  const primeCommands = async (model: AccountModel | undefined): Promise<void> => {
    const wanted = new Set<string>(HARNESS_COMMANDS);
    for (const component of Object.values(model?.components.mcp ?? {}))
      if (component.command !== undefined) wanted.add(component.command);
    await Promise.all([commands.prime(wanted), platform.prime()]);
  };
  const config = runtimesConfigFiles({
    config: ctx.kernel.config,
    logins: ctx.needs.logins,
    pins: statePins(ctx.kernel.state, sentence => {
      ctx.kernel.log.warn(sentence);
    }),
    components: hook => ctx.hooks.provider(hook, PROFILE_COMPONENTS_KEY),
    within: withinMs((delay, fn) => ctx.kernel.clock.after(milliseconds(delay), fn), PROVIDER_ANSWER_MS),
    installed,
    prime: primeCommands,
  });
  const unguarded = fileFleetCatalogDeps({
    host,
    paths: { home, fleet: directory, fleetManifest: `${directory}/${MANIFEST_FILE}` },
    userHome: ctx.kernel.paths.home(),
    sessionStatuses: async () => (await ctx.needs.ferrets.list()).map(ferret => SESSION_STATUS_OF[ferret.state]),
    // The session records a runtime removal reads and a rename re-points: Ferrets owns them, so both go through its port.
    // A Ferrets that does not offer them leaves the confirm card saying only what it knows.
    ...sessionRecordsOver(ctx.needs.ferrets),
    credentials: ctx.needs.logins,
    loginChanges: ctx.needs.loginChanges,
    // The catalogs Logins owns, read live: what each runtime offers, and what an apply pins its tier slots to.
    modelCatalogs: loginsModelCatalogs(ctx.needs.logins, sentence => {
      ctx.kernel.log.warn(sentence);
    }),
    // Where Logins keeps each Ferretry-kept login, read live: how a person-run wrapper is signed in (the ferret launch hook's own projection).
    loginStores: loginsLaunchStores(ctx.needs.logins),
    configWriter: writeAllConfigWriter(ctx.kernel.config, configDirectory),
    locate: harness => commands.which(harness),
    // The daemon's own display name (the host name, normalised by the kernel): what `fy machine` and a copy's source say.
    machineName: () => ctx.kernel.identity.daemonName,
    clientName: CLIENT_NAME,
    config,
    sharedHistory: unavailableSharedHistory,
    claudeStatusline: claudeStatuslineFor(CLIENT_NAME),
    configDirectory,
    publication,
    say: sentence => {
      ctx.kernel.log.warn(sentence);
    },
  });
  const catalog: FleetCatalogServiceDeps = {
    ...unguarded,
    // What the last auto-resume pass after a restart did, for the Machine view; Ferrets keeps it (`null` before any pass).
    lastAutoResume: async () => {
      const report = await ctx.needs.ferrets.lastAutoResume?.();
      return report === undefined || report === null ? null : { ...report, at: InstantSchema.parse(report.at) };
    },
    // Usage's pauses in force now, synchronously (they are memory-only): a login its budget holds is published
    // unavailable, exactly as a disabled one is. Usage off (it is an optional need) holds nothing.
    budgetHolds: () =>
      Object.fromEntries(
        (ctx.uses?.usage.current()?.pauses() ?? []).map(held => [held.login as string, held.pause] as const),
      ),
    // What each harness's plugin gives Runtimes for its own harness, read live with every materialisation and host import.
    kits: () => harnessKits(hook => ctx.hooks.provider(hook, PROFILE_COMPONENTS_KEY)),
    // The setup's and the clone's own writes ask this; a catalogue apply asks the PLAN it applies (catalog-service.ts).
    preflight: refuseBeforeWriting(config),
  };
  const refusing = unavailableSetupDeps(catalog);
  // The tool installer: the plans say what is installed and the command a person would run; an explicit install runs that
  // command through the kernel's spawn (declared `brew` and `npm` only, an argv, never a shell or sudo).
  const installer = toolInstaller({
    commands,
    platform,
    spawn: () => ctx.kernel.spawn,
    clock: ctx.kernel.clock,
  });
  const tools: FleetSetupServiceDeps['tools'] = {
    plans: harnesses => installer.plans(harnesses),
    // "Check again" asks past the ten-second lookup window, for the same names every read looks up.
    refresh: async () => {
      await Promise.all([commands.refresh(HARNESS_COMMANDS), platform.prime()]);
    },
    install: async (request, governance) =>
      // The command the person was shown travels with the request (each entry's harness in the installer's own spelling), so
      // the installer can refuse a plan that changed since; dropping it here would leave that check never made.
      await installer.install(
        {
          harnesses: request.harnesses.map(harnessKindOfKey),
          ...(request.shown === undefined
            ? {}
            : {
                shown: request.shown.map(entry => ({
                  harness: harnessKindOfKey(entry.harness),
                  command: entry.command,
                })),
              }),
        },
        governance,
      ),
  };
  // The Vault's own "this very value, filed by this plugin's earlier create" check (absent on a Vault that offers none).
  const filed = ctx.needs.vault?.filedSame?.bind(ctx.needs.vault);
  const services = assembleServices(catalog, base =>
    fileFleetSetupDeps({
      host,
      catalog: base,
      logins: ctx.needs.logins,
      tools,
      ...(ctx.needs.loginEnvImport === undefined ? {} : { loginEnvImport: ctx.needs.loginEnvImport }),
      // Imported MCP servers, skills and settings go to the plugin that owns each (its own `put`), never written here.
      components: componentWriters(
        hook => ctx.hooks.provider(hook, PROFILE_COMPONENTS_KEY),
        withinMs((delay, fn) => ctx.kernel.clock.after(milliseconds(delay), fn), PROVIDER_ANSWER_MS),
      ),
      daemonId: () => ctx.kernel.identity.daemonId,
      // The NAME listing is the Vault's own (names and times, never a value); writing a key in stays unavailable here.
      secrets: {
        list: ctx.needs.vault === undefined ? refusing.secrets.held : secretNamesOver(ctx.needs.vault),
        put: ctx.needs.vault === undefined ? refusing.secrets.put : putNewOver(ctx.needs.vault),
        ...(filed === undefined ? {} : { filedSame: filedSameOver(filed) }),
      },
    }),
  );
  return {
    catalog: services.catalog,
    setup: services.setup,
    // The profile's file as the kernel's config writer reckons its etag (what `writeAll`'s `ifMatch` is compared with),
    // or the absent sentinel: the kernel's own answer for Runtimes' own declared file, read when asked. (The files are
    // not Runtimes' to read: `config/` is no folder `host.files` mounts.)
    profileEtag: async profile => await ctx.kernel.config.etag(PROFILE_ITEMS as never, profile),
    installed,
    primeInstalled: async () => {
      await primeCommands(undefined);
    },
  };
}

/**
 * The setup's write of one imported secret, over the Vault's CREATE-ONLY `putNew` alone (a `Pick<VaultApi, 'putNew'>`): a name
 * the Vault already holds is refused in a sentence and keeps its value, so an import adds a key and never replaces one. A Vault
 * that offers no `putNew` refuses too. The value reaches this function from the daemon's own re-read of the host file at apply
 * time and goes nowhere but into the Vault; the sentences name the secret, never the value.
 */
export function putNewOver(vault: Pick<VaultApi, 'putNew'>): (name: string, value: string) => Promise<void> {
  return async (name, value) => {
    if (vault.putNew === undefined)
      throw new Error(`the secret store does not take a new key from this setup, so ${name} was not stored`);
    const parsed = SecretNameSchema.safeParse(name);
    if (!parsed.success) throw new Error(`${name} is not a name the secret store accepts`);
    if ((await vault.putNew(parsed.data, value)) === 'exists')
      throw new Error(`the secret store already holds ${name} and an import never replaces one`);
  };
}

/**
 * Whether the Vault holds exactly this value under this name from this plugin's own earlier create (`VaultApi.filedSame`): one
 * boolean, decided inside the Vault. A name the store does not accept is a plain no.
 */
export function filedSameOver(
  filedSame: (name: SecretName, value: string) => Promise<boolean>,
): (name: string, value: string) => Promise<boolean> {
  return async (name, value) => {
    const parsed = SecretNameSchema.safeParse(name);
    return parsed.success && (await filedSame(parsed.data, value));
  };
}

/**
 * The setup's read of which secrets this machine holds, over the Vault's NAME listing alone (a `Pick<VaultApi, 'names'>`:
 * its answer carries a name and two instants, so there is nowhere for a value to travel). A Vault that cannot answer
 * rejects, and the setup refuses in its sentence: an unreadable store is never read as an empty one.
 */
export function secretNamesOver(
  vault: Pick<VaultApi, 'names'>,
): () => Promise<readonly { readonly name: string; readonly createdAt: string; readonly updatedAt: string }[]> {
  return async () =>
    (await vault.names()).map(({ name, createdAt, updatedAt }) => ({
      name: String(name),
      createdAt: String(createdAt),
      updatedAt: String(updatedAt),
    }));
}
