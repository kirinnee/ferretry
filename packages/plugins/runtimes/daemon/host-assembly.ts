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
 *    first-run scan over the harness homes.
 *
 * What is NOT here is the account-model evaluator (the model in effect from the configuration files) and its edit
 * renderer: until they are ported every catalogue read still answers {@link UNAVAILABLE} in a sentence, and the
 * collaborators below it are real.
 */
import type { ConfigPort, KernelPorts, RootHandle, RootsPort } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import { applyClaimFor } from './adapters/apply-claim.ts';
import { configDirectoryOf, fileFleetCatalogDeps } from './adapters/account-model-files.ts';
import { writeAllConfigWriter } from './adapters/config-write-all.ts';
import { credentialMounts, FleetDisk, sourceMounts } from './adapters/fleet-disk.ts';
import { readFleetManifest } from './adapters/manifest-file.ts';
import type { AdapterHost, ConfigFilesPort } from './adapters/ports.ts';
import { fleetMounts, harnessMounts, rootHostFiles } from './adapters/root-host-files.ts';
import { fileFleetSetupDeps } from './adapters/setup-files.ts';
import { unavailableSharedHistory } from './adapters/shared-history-unavailable.ts';
import type { FleetManifest } from './lib/manifest.ts';
import { assembleServices, UNAVAILABLE, unavailableSetupDeps } from './lib/service/assembly.ts';
import { CodexAppServerSupervisor } from './lib/service/codex-runtime.ts';
import type { FleetCatalogServiceDeps } from './lib/service/catalog-service.ts';
import { FleetPublication } from './lib/service/publication.ts';
import type { RuntimeEndSeams } from './lib/service/runtime-end-supervision.ts';

/** The published manifest's name in the fleet folder. */
const MANIFEST_FILE = 'manifest.json';

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

/** The account model's evaluator is not ported: every read of the model in effect answers the plain sentence. */
const unevaluatedModel: ConfigFilesPort<never> = {
  inEffect: async () => await Promise.reject(new Error(UNAVAILABLE)),
  load: async () => await Promise.reject(new Error(UNAVAILABLE)),
  editsFor: () => {
    throw new Error(UNAVAILABLE);
  },
  mentionsRenamed: () => {
    throw new Error(UNAVAILABLE);
  },
};

/** The disk, the claim and the host the file adapters stand on, from the kernel's roots, clock and PATH lookup. */
export function fleetHost(kernel: Pick<KernelPorts, 'roots' | 'paths' | 'clock'>): {
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
      // GAP(kernel): the services ask for a command SYNCHRONOUSLY and `kernel.paths.which` answers asynchronously, so no
      // command is found from here; the catalogue is unavailable until the evaluator lands, and nothing asks yet.
      commands: { which: () => undefined },
      disk,
      now: () => kernel.clock.nowMs(),
      claimFor: manifestPath => applyClaimFor(disk, manifestPath, { now: () => kernel.clock.nowMs(), sleep }),
    },
  };
}

/**
 * The catalogue and the setup, composed over the files: the file provisioner on the `fleet` root (S67: every apply
 * runs exclusively under `publication`), the all-or-none config writer on `ConfigPort.writeAll`, and the first-run
 * scan over the harness homes. The model evaluator is not ported, so the catalogue still answers {@link UNAVAILABLE}.
 */
export function fileAssembly(
  ctx: {
    readonly kernel: Pick<KernelPorts, 'roots' | 'paths' | 'clock' | 'log'> & {
      readonly config: Pick<ConfigPort, 'writeAll'>;
    };
    readonly needs: {
      readonly logins: FleetCatalogServiceDeps['credentials'] & Parameters<typeof fileFleetSetupDeps>[0]['logins'];
      readonly loginChanges: FleetCatalogServiceDeps['loginChanges'];
    };
  },
  publication: FleetPublication,
): Pick<ReturnType<typeof assembleServices>, 'catalog' | 'setup'> {
  const { host, directory } = fleetHost(ctx.kernel);
  const home = directory.slice(0, directory.lastIndexOf('/'));
  const configDirectory = configDirectoryOf(home);
  const catalog = fileFleetCatalogDeps({
    host,
    paths: { home, fleet: directory, fleetManifest: `${directory}/${MANIFEST_FILE}` },
    userHome: ctx.kernel.paths.home(),
    sessionStatuses: async () => [],
    credentials: ctx.needs.logins,
    loginChanges: ctx.needs.loginChanges,
    configWriter: writeAllConfigWriter(ctx.kernel.config, configDirectory),
    locate: () => undefined,
    machineName: () => 'this machine',
    clientName: 'fy',
    config: unevaluatedModel,
    sharedHistory: unavailableSharedHistory,
    claudeStatusline: () => {
      throw new Error(UNAVAILABLE);
    },
    configDirectory,
    publication,
  });
  const refusing = unavailableSetupDeps(catalog);
  return assembleServices(catalog, base =>
    fileFleetSetupDeps({
      host,
      catalog: base,
      logins: ctx.needs.logins,
      tools: refusing.tools,
      daemonId: () => undefined,
      secrets: { list: refusing.secrets.held, put: refusing.secrets.put },
    }),
  );
}
