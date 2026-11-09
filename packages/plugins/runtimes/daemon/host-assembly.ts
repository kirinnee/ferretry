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
 * while one does), the tool installer, the secret store's list and put, the shared-history pooling and the machine's
 * name; each is a declared GAP in `ports-pending.json`.
 */
import type { FerretState } from '@ferretry/core-ferrets/contract';
import type { ConfigPort, KernelPorts, RootHandle, RootsPort } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import { applyClaimFor } from './adapters/apply-claim.ts';
import { configDirectoryOf, fileFleetCatalogDeps } from './adapters/account-model-files.ts';
import { CommandCache } from './adapters/command-cache.ts';
import { writeAllConfigWriter } from './adapters/config-write-all.ts';
import { credentialMounts, FleetDisk, sourceMounts } from './adapters/fleet-disk.ts';
import { readFleetManifest } from './adapters/manifest-file.ts';
import type { AdapterHost, SharedHistoryPooling } from './adapters/ports.ts';
import { refuseWhileUnreadable, runtimesConfigFiles } from './adapters/runtimes-config-files.ts';
import { fleetMounts, harnessMounts, rootHostFiles } from './adapters/root-host-files.ts';
import { fileFleetSetupDeps } from './adapters/setup-files.ts';
import { type FleetManifest, harnessKindOfKey } from './lib/manifest.ts';
import { claudeStatuslineFor } from './lib/account/statusline.ts';
import { assembleServices, unavailableSetupDeps } from './lib/service/assembly.ts';
import { CodexAppServerSupervisor } from './lib/service/codex-runtime.ts';
import type { FleetCatalogServiceDeps } from './lib/service/catalog-service.ts';
import { FleetPublication } from './lib/service/publication.ts';
import type { FleetSetupServiceDeps } from './lib/service/setup-service.ts';
import { ToolInstallService } from './lib/service/tool-install.ts';
import type { HarnessLocation, SessionStatus } from './lib/service/foreign.ts';
import type { RuntimeEndSeams } from './lib/service/runtime-end-supervision.ts';

/** The published manifest's name in the fleet folder. */
const MANIFEST_FILE = 'manifest.json';

/** What a person types to run this binary: the wrapper's history claim and the statusLine run it. */
const CLIENT_NAME = 'fy';

/** A ferret's state as the catalogue counts a session (it counts the ones still going). */
const SESSION_STATUS_OF: Readonly<Record<FerretState, SessionStatus>> = {
  starting: 'starting',
  working: 'running',
  idle: 'waiting',
  stopped: 'stopped',
};

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

/** The shared-history migration is Conversation's; until it is wired it is unavailable, which an apply skips and names. */
const unavailableSharedHistory: SharedHistoryPooling = {
  preview: async () => await Promise.reject(new Error(SHARED_HISTORY_UNAVAILABLE)),
  materialize: async () => await Promise.reject(new Error(SHARED_HISTORY_UNAVAILABLE)),
  isUnavailable: error => error instanceof Error && error.message === SHARED_HISTORY_UNAVAILABLE,
};
const SHARED_HISTORY_UNAVAILABLE =
  'pooling conversation history across runtimes is not available from the Runtimes plugin yet, so it was skipped';

/** The harness commands every read asks about, looked up ahead (`./adapters/command-cache.ts`). */
const HARNESS_COMMANDS = ['claude', 'codex', 'npm', 'brew', 'apt-get'] as const;

/** What an install says when it is asked to run a package manager: it is not composed over the kernel yet. */
const PACKAGE_MANAGER_NOT_COMPOSED =
  'running a package manager is not available from the Runtimes plugin yet, so run the command yourself';

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
    readonly kernel: Pick<KernelPorts, 'roots' | 'paths' | 'clock' | 'log'> & {
      readonly config: Pick<ConfigPort, 'writeAll' | 'collection' | 'file'>;
    };
    readonly needs: {
      readonly logins: FleetCatalogServiceDeps['credentials'] & Parameters<typeof fileFleetSetupDeps>[0]['logins'];
      readonly loginChanges: FleetCatalogServiceDeps['loginChanges'];
      readonly ferrets: { list(): Promise<readonly { readonly state: FerretState }[]> };
    };
  },
  publication: FleetPublication,
): Pick<ReturnType<typeof assembleServices>, 'catalog' | 'setup'> {
  const commands = new CommandCache({ which: async name => await ctx.kernel.paths.which(name) }, () =>
    ctx.kernel.clock.nowMs(),
  );
  const { host, directory } = fleetHost(ctx.kernel, commands);
  const home = directory.slice(0, directory.lastIndexOf('/'));
  const configDirectory = configDirectoryOf(home);
  const config = runtimesConfigFiles({
    config: ctx.kernel.config,
    logins: ctx.needs.logins,
    prime: async model => {
      const wanted = new Set<string>(HARNESS_COMMANDS);
      for (const component of Object.values(model?.components.mcp ?? {}))
        if (component.command !== undefined) wanted.add(component.command);
      await commands.prime(wanted);
    },
  });
  const unguarded = fileFleetCatalogDeps({
    host,
    paths: { home, fleet: directory, fleetManifest: `${directory}/${MANIFEST_FILE}` },
    userHome: ctx.kernel.paths.home(),
    sessionStatuses: async () => (await ctx.needs.ferrets.list()).map(ferret => SESSION_STATUS_OF[ferret.state]),
    credentials: ctx.needs.logins,
    loginChanges: ctx.needs.loginChanges,
    configWriter: writeAllConfigWriter(ctx.kernel.config, configDirectory),
    locate: harness => commands.which(harness),
    // GAP(kernel): the kernel offers no host name, so a copy's source is named "this machine".
    machineName: () => 'this machine',
    clientName: CLIENT_NAME,
    config,
    sharedHistory: unavailableSharedHistory,
    claudeStatusline: claudeStatuslineFor(CLIENT_NAME),
    configDirectory,
    publication,
  });
  const catalog: FleetCatalogServiceDeps = {
    ...unguarded,
    provisioner: refuseWhileUnreadable(unguarded.provisioner, config),
  };
  const refusing = unavailableSetupDeps(catalog);
  // The tool installer's PLANS are real (what is installed, and the command a person would run); running a package
  // manager is not composed, so an install ends in `could-not-start` with the manual command named.
  const installer = new ToolInstallService({
    // GAP(kernel): Runtimes declares no `hostFacts`, so the platform is not known and the plan names npm only.
    platform: 'unknown',
    executables: { resolve: name => commands.which(name), runnable: () => false },
    locate: (kind): HarnessLocation => {
      const path = commands.which(kind);
      return path === undefined ? { kind, outcome: 'absent', searched: [] } : { kind, outcome: 'located', path };
    },
    run: async () => ({ kind: 'not-started', reason: PACKAGE_MANAGER_NOT_COMPOSED }),
    environment: {},
  });
  const tools: FleetSetupServiceDeps['tools'] = {
    plans: harnesses => installer.plans(harnesses),
    install: async (request, governance) =>
      await installer.install({ harnesses: request.harnesses.map(harnessKindOfKey) }, governance),
  };
  return assembleServices(catalog, base =>
    fileFleetSetupDeps({
      host,
      catalog: base,
      logins: ctx.needs.logins,
      tools,
      daemonId: () => undefined,
      secrets: { list: refusing.secrets.held, put: refusing.secrets.put },
    }),
  );
}
