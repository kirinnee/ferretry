import { relative } from 'node:path';
import type { BinaryNames, ContractSurface, HostFactsPort, UpdateHostPort } from '../contract/ports.ts';
import type { Instant } from '@ferretry/std';
import { decideHome } from '../contract/home.ts';
import { milliseconds } from '@ferretry/std';
import type {
  AgentControlReader,
  InputHolds,
  OutputGuard,
  Admission,
  Redaction,
  WorkFolders,
} from '../contract/bound.ts';
import {
  AdmissionPort,
  AgentControlPort,
  type ChildEnvironment,
  type ChildEnvironmentOpener,
  ChildEnvironmentPort,
  SecretResolverPort,
  type SecretResolver,
  InputHoldsPort,
  OutputGuardPort,
  RedactionPort,
  WorkFoldersPort,
} from '../contract/bound.ts';
import type { ConfigDef, PortToken } from '../contract/define.ts';
import type { ApiRequest, ApiResponse } from '../contract/http.ts';
import { ApiError, errorResponse } from '../contract/http.ts';
import type { ConfigStatus } from './config/service.ts';
import { type ConfigFileMove, configChangedPayload } from './config/state-change.ts';
import { configFrameShown } from './config/bus-frame.ts';
import { CORE_IDS, type PluginId } from '../contract/ids.ts';
import { beforeListen } from './before-listen.ts';
import { type BootPhases, createBootPhases } from './boot-phases.ts';
import { type HomeLockLease, StateHomeLockedError } from './state/home-lock.ts';
import {
  Carriers,
  ConfigChanged,
  type DoctorCheck,
  DoctorChecks,
  PluginsChanged,
  SessionModes,
} from '../contract/kernel.ts';
import type {
  Clock,
  ConfigFilesWriter,
  ConfigPort,
  FetchPort,
  KernelPorts,
  SpawnPort,
  StateDamage,
  StatePort,
  WebSocketPort,
  WorkersPort,
} from '../contract/ports.ts';
import { KERNEL_REFUSALS } from '../contract/refusals.ts';
import type { PostBuildSnapshot } from '../contract/snapshot.ts';
import type {
  DaemonContext,
  DaemonHalf,
  DaemonImplementation,
  DoctorRun,
  ToolHandler,
  ToolResult,
} from '../manifest/implement.ts';
import type { Manifest, Needer, ToolDecl } from '../manifest/types.ts';
import kernelManifest, { PluginsConfig, type PluginsYaml } from '../plugin.ts';
import { createActRunner, MintedIdRegistry } from './act.ts';
import type { HostFs } from './adapters/node-fs.ts';
import { checkDirectory, gatedOverrides, gatedPaths, gatedWhich } from './paths.ts';
import { type ExecutableProbe, handleReaders, locateCommand, whichCommand, whichForCommand } from './which.ts';
import { currentActor, currentStanding, runInCall } from './call-scope.ts';
import { loadDataPlugins } from './data-plugins.ts';
import { configOwnedKinds, type InstalledItems, installedItemReach, itemReach } from './items.ts';
import {
  admitCall,
  Dispatcher,
  type MountedMemberRoute,
  type MountedRoute,
  type MountedSocket,
  notServing,
  type Owner,
  type Serving,
} from './dispatch.ts';
import { EventBus } from './events.ts';
import { DEFAULT_RECHECK_MS, type PlaceBudget, type TruncationWatcher } from './fence-index.ts';
import { dependentsOf, type GraphRefusal, planGraph } from './graph.ts';
import { type Deadline, HookEngine } from './hooks.ts';
import {
  type InventoryEntry,
  type InventorySurfaces,
  inventorySurfacesOf,
  type KernelHalfSources,
  kernelRoutes,
  kernelSockets,
  kernelTools,
} from './kernel-half.ts';
import { JobRunner } from './jobs.ts';
import type { ResponseCompressor } from './compression.ts';
import { pluginsYamlLine, readAcceptedPlugins, writeAcceptedPlugins } from './accepted-plugins.ts';
import { carrierListenerPort } from './carrier-listener.ts';
import { PluginLifecycle } from './lifecycle.ts';
import { livePort } from './live-port.ts';
import { KERNEL_NEEDER, neederOf, ProvidedPerNeeder } from './needer.ts';
import { guardedToolResult } from './tool-result.ts';
import { type LogSink, scopedLog } from './log.ts';
import { noWebSockets } from './adapters/process.ts';
import { outboundSecretTransport } from './adapters/outbound-secret.ts';
import { exactNetworkHosts, ownSecretsPort } from './secrets.ts';
import { NO_HOST_FACTS } from './no-host-facts.ts';
import { undeclaredHostFacts } from './adapters/host-facts.ts';
import { type UpdateHostFiles, undeclaredUpdateHost } from './adapters/update-host.ts';
import { PRODUCT_BINARIES } from './binaries.ts';
import { descriptorReachNote } from './descriptor-reach.ts';
import { doctorReport } from './doctor-report.ts';
import { createIdentitySigner, signerFor } from './session/signer.ts';
import { type DaemonTimings, DEFAULT_DAEMON_TIMINGS } from './session/timings.ts';
import {
  allowDetachedSpawn,
  hostPermitted,
  effectivePermissions,
  openChildEnvironments,
  restrictFetch,
  restrictSpawn,
  type ResolverOf,
  restrictWebSocket,
  workersFor,
} from './permissions.ts';
import type { HostStatePort, PrivatePin } from './state/state-port.ts';
import { type PinReport, pinCreated, touchesPrivate } from './fence-guard.ts';
import { openHome, probeHome } from './home.ts';
import { composePrivateFiles, privacyRefusals } from '../manifest/privacy.ts';
import { ensureInternalRootBases, ownFolderSpellings, rootsPortFor } from './roots.ts';
import { NO_PROCESS_TABLE, type ProcessTable, processesPortFor } from './processes.ts';
import { PinRegistry } from './pins.ts';
import { FsError, type SessionRootPinner, unsupportedPlatform } from '../contract/pinned.ts';
import type { PathsPort, ScratchPort } from '../contract/ports.ts';

const NO_PINNER: SessionRootPinner = {
  pin: async () => {
    throw unsupportedPlatform(process.platform);
  },
};
const NO_SCRATCH: ScratchPort = {
  open: async () => {
    throw new FsError('unsupported', 'this daemon was started with no scratch folders');
  },
};
import { buildSnapshot, type DataPluginManifest } from './snapshot.ts';
import { type DaemonIdentity, daemonNameFrom, loadIdentity } from './identity.ts';
import {
  createSessionLayer,
  type SessionCrypto,
  type SessionLayerHost,
  WebCryptoSessionCrypto,
} from './session/index.ts';

/** What the store opens for one plugin (the store slice's `openPluginState`). */
export interface PluginStateHandle {
  readonly port: StatePort;
  /** Checks every declared file's format (§9.3); answers the damage found. */
  open(): Promise<readonly StateDamage[]>;
  close(): Promise<void>;
  /** The real state port reports both subsystem damage and a successful repair synchronously. */
  onDamageChanged?(listener: (damage: readonly StateDamage[]) => void): () => void;
  narrowed?(): readonly StateDamage[];
}

/** Everything IO the host is given. `fyd` wires the real ones; the test host wires in-memory ones. */
/** The config service the host drives (`host/config`'s `createConfigFiles`). */
export interface HostConfig {
  port(plugin: string): ConfigPort;
  /** The writer over every declared file; Gate alone receives it. Absent: Gate gets none. */
  writer?(): ConfigFilesWriter;
  /** What every declared file stands at (`GET /v1/config/status`, `config_read`). Absent: none can be listed. */
  status?(): ConfigStatus;
  reload(): Promise<void>;
  /** Writes the editors' JSON Schema for every declared file under `config/.schema/`. Absent: none is written. */
  publishSchemas?(): Promise<void>;
  startWatching?(): () => void;
  /**
   * Every declared file of every plugin that moved on disk or in state at a reload, with its plugin: what the host
   * publishes as `kernel.config-changed`. Absent: the event is never published. Answers the cancel.
   */
  onStateChange?(listener: (plugin: string, move: ConfigFileMove) => void): () => void;
  /** The `${secret:NAME}` names a plugin's own files in effect name. Absent: none, so `kernel.secrets` refuses. */
  secretReferences?(plugin: string): ReadonlySet<string>;
  /** The same names, from the plugin's credential-record defs alone (what a provider counts as its own). Absent: none. */
  credentialRecordReferences?(plugin: string): ReadonlySet<string>;
}

/**
 * How often the kept index of the home's private places is looked at again (§7.7, `host/fence-index.ts`): a private file
 * created or replaced is pinned within this long, which is also the longest one can be reached under a second name.
 */
const PRIVATE_RECHECK_MS = DEFAULT_RECHECK_MS;

/** The kernel's own `GET /v1/config/file` declaration: what a `kernel.config-changed` frame is asked about as. */
const CONFIG_FILE_READ = (() => {
  const found = kernelManifest.actions?.routes?.find(declared => declared.key === 'GET /v1/config/file');
  if (found === undefined) throw new Error('the kernel manifest declares no GET /v1/config/file');
  return found;
})();

/** Gate's judge of a plugin's own loosening config write, as the config service asks it. */
export type ConfigJudge = (input: {
  readonly plugin: string;
  readonly path: string;
  readonly removal: boolean;
  readonly sentences: readonly string[];
  /** Only a `ConfigPort.writeAsCaller` sets it: `sentences` are the secret references the edit adds. */
  readonly secretAdd?: true;
}) => boolean;

export interface HostAdapters {
  readonly clock: Clock;
  readonly logSink: LogSink;
  readonly fs: HostFs;
  readonly random: () => string;
  /** `pin`: how a create of a private place is pinned by identity before it returns (§7.7); absent, none is. */
  readonly state: (manifest: Manifest, pin?: PrivatePin) => PluginStateHandle;
  /** The config service over every started plugin's declared files (§7.2); reloaded once before build. */
  readonly config: (
    declarations: readonly { readonly plugin: string; readonly def: ConfigDef }[],
    judge?: ConfigJudge,
  ) => HostConfig;
  /** Unrestricted; the host narrows each to the manifest's `permissions`. */
  readonly spawn: SpawnPort;
  readonly fetch: FetchPort;
  readonly workers: WorkersPort;
  /** Unrestricted WebSocket clients; the host narrows them per plugin. Absent: every dial is refused. */
  readonly websocket?: WebSocketPort;
  /** The machine's host name, for the daemon name. Absent: `Ferretry daemon`. */
  readonly hostname?: () => string;
  /** The owner's home directory (`homedir()`), for `kernel.paths.home()`. Absent: the process's `HOME`, else `/`. */
  readonly ownerHome?: () => string;
  /** The daemon's inherited `PATH`, for `kernel.paths.which`. Absent: only the caller's own folders are searched. */
  readonly searchPath?: () => string | undefined;
  /** Whether a path is a regular file this process may execute, for `kernel.paths.which`. Absent: nothing is found. */
  readonly executable?: ExecutableProbe;
  /**
   * The operator's value of ONE environment variable, for `kernel.paths.locate`'s override; only ever asked for a name
   * the calling manifest declared in `permissions.whichOverrides`. Absent: no override is ever set.
   */
  readonly operatorVariable?: (name: string) => string | undefined;
  /** `kernel.hostFacts` (`/proc`, `/sys`). Absent: every read refuses. */
  readonly hostFacts?: HostFactsPort;
  /** This user's process table, for `kernel.processes` (kernel-only). Absent: nothing is listed or signalled. */
  readonly processTable?: ProcessTable;
  /** Gzips an opted-in route's answer. Absent: every answer is plain. */
  readonly compressor?: ResponseCompressor;
  /**
   * `kernel.updateHost` per plugin, over the plugin's own declared `report` and `log` state files (their paths inside
   * its state folder). Absent: facts refuse, launches fail.
   */
  readonly updateHost?: (plugin: string, files: UpdateHostFiles) => UpdateHostPort;
  /** Holds a folder open for `RootHandle.pin`. Absent: every pin is refused (`unsupported`). */
  readonly pinner?: SessionRootPinner;
  /** Private scratch folders. Absent: every open is refused. */
  readonly scratch?: ScratchPort;
  /**
   * Takes the home's lifetime lock (`run/daemon.lock`, §9.2): held from just after the nonmutating home decision until
   * stop, so a second daemon on the same home is refused (G57) before it writes anything or removes the socket.
   * Throws {@link StateHomeLockedError} when another daemon holds it.
   */
  readonly homeLock: (home: string) => Promise<HomeLockLease>;
}

export interface Listening {
  readonly addresses: readonly string[];
  stop(): Promise<void>;
}

export interface HostOptions {
  readonly home: string;
  readonly version: string;
  // biome-ignore lint/suspicious/noExplicitAny: the generated registry is `DaemonImplementation<any>[]` (each half typed by its own manifest).
  readonly implementations: readonly DaemonImplementation<any>[];
  readonly adapters: HostAdapters;
  /** `config/plugins.yaml`: on/off per plugin. Core is always on. Default: on. */
  readonly enabled?: (id: string) => boolean;
  /** The generated contract hash per package (§9.6): the effective hash, or with `'member'` the member-surface hash. */
  readonly contractHash?: (id: string, surface?: ContractSurface) => string;
  readonly instructionText?: (plugin: string, path: string) => string | undefined;
  /** The local listener (Unix socket + loopback port); started at step 7. */
  readonly listen?: (host: RunningHost) => Promise<Listening>;
  /** The session layer's crypto (WebCrypto unless a suite drives it). */
  readonly sessionCrypto?: SessionCrypto;
  readonly pid?: number;
  /** `<home>-worktrees` unless given. */
  readonly worktrees?: string;
  /** `FYD_TEST_TIMINGS` as `fyd` parsed it (R247); absent is the shipped numbers exactly. */
  readonly timings?: DaemonTimings;
  /** `FYD_BACKGROUND_DELAY_SECONDS` as `fyd` parsed it: when the `worker` job lane opens after start. */
  readonly backgroundDelayMs?: number;
  /** The product's binary names for `kernel.identity`. Default: read from the repo's `bin` keys. */
  readonly binaries?: BinaryNames;
}

export type PluginStatus = 'serving' | 'skeleton' | 'failed' | 'damaged' | 'off' | 'refused';

export interface PluginRecord {
  readonly manifest: Manifest;
  status: PluginStatus;
  damage: readonly StateDamage[];
  half?: DaemonHalf<Manifest>;
  failure?: string;
  readonly lifecycle: PluginLifecycle;
  state?: PluginStateHandle;
}

export interface DoctorLine {
  readonly plugin: string;
  readonly state: 'ok' | 'warn' | 'fail';
  readonly detail: string;
  /** The manifest `doctor` id that produced it, when a declared check did. */
  readonly check?: string;
  /** What to do about it, when the check said. */
  readonly fix?: string;
}

export interface RunningHost {
  readonly dispatcher: Dispatcher;
  readonly identity: DaemonIdentity;
  readonly snapshot: PostBuildSnapshot;
  readonly trace: readonly string[];
  readonly plugins: ReadonlyMap<string, PluginRecord>;
  readonly hooks: HookEngine;
  readonly events: EventBus;
  readonly jobs: JobRunner;
  readonly ids: MintedIdRegistry;
  readonly sessionLayer: SessionLayerHost;
  dispatch(request: ApiRequest): Promise<ApiResponse>;
  callTool(plugin: string, name: string, input: unknown, request: ApiRequest): Promise<ToolResult>;
  doctor(): Promise<readonly DoctorLine[]>;
  stop(): Promise<void>;
}

export type BootOutcome =
  | { readonly kind: 'running'; readonly host: RunningHost }
  | { readonly kind: 'refused'; readonly sentence: string; readonly trace: readonly string[] };

/**
 * The plugin's update seam: the real one only for a plugin that declared `permissions.updateHost` AND the state files
 * `report` and `log` the launch writes to. Their paths are the plugin's declared ones, never a second spelling.
 */
function updateHostOf(manifest: Manifest, adapters: HostAdapters, version: string): UpdateHostPort {
  if (manifest.permissions?.updateHost !== true || adapters.updateHost === undefined)
    return undeclaredUpdateHost(manifest.id, version);
  const declared = (name: string): string | undefined => manifest.data?.state?.find(def => def.name === name)?.path;
  const report = declared('report');
  const log = declared('log');
  if (report === undefined || log === undefined)
    return undeclaredUpdateHost(manifest.id, version, `${manifest.id} did not declare the state files report and log.`);
  return adapters.updateHost(manifest.id, { report, log });
}

const isCore = (id: string): boolean => (CORE_IDS as readonly string[]).includes(id);

/** A need on a skeleton provider: every call throws `503 plugin_unavailable` with the skeleton sentence (D10). */
function unavailablePort(title: string): unknown {
  return new Proxy(
    {},
    {
      get: (_target, property) =>
        property === 'then'
          ? undefined
          : () => {
              throw new ApiError(
                KERNEL_REFUSALS.pluginUnavailable.status,
                `${title} is not built yet in this version of Ferretry.`,
                KERNEL_REFUSALS.pluginUnavailable.code,
              );
            },
    },
  );
}

/** The manifest key under which a plugin provides a token (`provides: { board: BoardPort }` → `board`). */
function provideKey(manifest: Manifest, token: PortToken<unknown>): string | undefined {
  return Object.entries(manifest.provides ?? {}).find(([, candidate]) => candidate.name === token.name)?.[0];
}

function deadlineFrom(clock: Clock): Deadline {
  return ms => {
    let cancel = (): void => {};
    const promise = new Promise<'timeout'>(resolve => {
      cancel = clock.after(milliseconds(ms), () => resolve('timeout'));
    });
    return { promise, cancel: () => cancel() };
  };
}

/**
 * Boots the daemon in the order of §7.6 and records each step in `trace` (the boot-trace test asserts it):
 * home → identity → config → check → state:<id> → build:<id> → bind → snapshot → mount → listen → jobs. The home is
 * decided first because nothing may be read from an undecided folder, and the enabled graph is checked after
 * `config/plugins.yaml` is read, since that file is what says which plugins are on. Nothing is served and no job runs
 * before `bind`; a core piece failing to build stops the boot.
 */
export async function bootHost(options: HostOptions): Promise<BootOutcome> {
  const { adapters, home } = options;
  const trace: string[] = [];
  const phases = createBootPhases(() => adapters.clock.nowMs(), trace);
  // 2. Home: refuse a home that is not ours before creating anything, but decide for real under the lifetime lock —
  // this reading is stale the moment another daemon sets up the same home (today's `storage-factory.ts` order).
  phases.mark('home');
  const preliminary = decideHome(home, await probeHome(adapters.fs, home));
  if (preliminary.kind === 'refuse') return { kind: 'refused', sentence: preliminary.sentence, trace };
  if (preliminary.kind === 'create') await adapters.fs.mkdirp(home, 0o700);
  phases.mark('lock');
  let lease: HomeLockLease;
  try {
    lease = await adapters.homeLock(home);
  } catch (error) {
    if (error instanceof StateHomeLockedError) return { kind: 'refused', sentence: error.message, trace };
    throw error;
  }
  // Held until stop; released on every boot that does not end running.
  const cleanup: (() => void | Promise<void>)[] = [];
  let running = false;
  try {
    const outcome = await bootLocked(options, trace, phases, lease, release => cleanup.push(release));
    running = outcome.kind === 'running';
    return outcome;
  } finally {
    if (!running) {
      for (const release of cleanup.reverse()) {
        try {
          await release();
        } catch {
          /* one failed release must not retain the remaining resources */
        }
      }
      await lease.release();
    }
  }
}

async function bootLocked(
  options: HostOptions,
  trace: string[],
  phases: BootPhases,
  lease: HomeLockLease,
  own: (release: () => void | Promise<void>) => void,
): Promise<BootOutcome> {
  const { adapters, home } = options;
  const log = scopedLog(adapters.logSink, 'kernel');
  const clock = adapters.clock;

  // Home and fence, identity (before anything is read from the home).
  const opened = await openHome(adapters.fs, home, `fyd ${options.version}`, clock.now() as Instant);
  if (opened.kind === 'refused') return { kind: 'refused', sentence: opened.decision.sentence, trace };
  if (opened.kind === 'logs-refused') return { kind: 'refused', sentence: opened.sentence, trace };
  // From here the log is written: a folder made or tightened now is the first thing it says.
  if (opened.logs !== undefined)
    log.info(
      opened.logs === 'made'
        ? 'logs/ did not exist and was made (0700)'
        : 'logs/ was open to other users and is now 0700',
    );
  const deadline = deadlineFrom(clock);
  phases.mark('identity');
  const identityOutcome = await loadIdentity(adapters.fs, home);
  if (identityOutcome.kind === 'damaged') return { kind: 'refused', sentence: identityOutcome.sentence, trace };
  const identity = identityOutcome.identity;
  const identityPort = Object.freeze({
    daemonId: identity.daemonId,
    daemonName: daemonNameFrom(adapters.hostname?.() ?? ''),
    binaries: options.binaries ?? PRODUCT_BINARIES,
  });
  const websockets = adapters.websocket ?? noWebSockets();
  const sessionSigner = createIdentitySigner(identity);

  const implementations = new Map<string, DaemonImplementation>();
  for (const implementation of options.implementations)
    if (implementation.manifest.id !== 'kernel') implementations.set(implementation.manifest.id, implementation);
  const manifests: Manifest[] = [kernelManifest, ...[...implementations.values()].map(impl => impl.manifest)];
  const unsound = privacyRefusals(manifests);
  if (unsound.length > 0)
    return {
      kind: 'refused',
      sentence: `A plugin's private files are not declared soundly, so the daemon did not start:\n${unsound.join('\n')}`,
      trace,
    };
  /** Every plugin's declared private places, composed once: the one list the fence of EVERY root reads (§7.7). */
  const privateFiles = composePrivateFiles(manifests);
  // Config: every declared file of every known plugin, so a plugin turned on later finds its file checked.
  phases.mark('config');
  // Gate's judge is read live: Admission is bound after build, and an absent or throwing one holds the edit.
  const judgeAdmission: { current?: Admission } = {};
  const config = adapters.config(
    manifests.flatMap(manifest => (manifest.data?.config ?? []).map(def => ({ plugin: manifest.id, def }))),
    input => {
      try {
        return (
          judgeAdmission.current?.judgeConfigWrite?.({
            ...input,
            actor: currentActor(),
            standing: currentStanding(),
          }) === 'apply'
        );
      } catch {
        return false;
      }
    },
  );
  await config.reload();
  // The modeline of every file points an editor at its schema, so the schemas are there once a daemon serves.
  await config.publishSchemas?.().catch((cause: unknown) =>
    // The cause (a path and a system reason, never a secret) is what tells an operator why: a full disk or a read-only folder.
    log.warn('the configuration schemas could not be written', {
      reason: cause instanceof Error ? cause.message : String(cause),
    }),
  );
  const stopWatching = config.startWatching?.();
  if (stopWatching !== undefined) own(stopWatching);
  const pluginsYaml = readPluginsYaml(config.port('kernel'));
  const configWriter = config.writer?.();

  // 1. Check the enabled graph.
  phases.mark('check');
  const yamlEnabled = (id: string): boolean =>
    isCore(id) || (options.enabled?.(id) ?? pluginsYaml?.plugins[id] !== 'off');
  const planWith = (on: (id: string) => boolean) => {
    const planned = HookEngine.plan(
      manifests.filter(manifest => on(manifest.id)),
      log,
      deadline,
      manifests,
    );
    const hookRefused = new Set(planned.refusals.flatMap(refusal => refusal.plugins));
    const hookEdges = (manifest: Manifest): readonly string[] =>
      (manifest.hooks?.takes ?? []).flatMap(take => {
        const offerer = planned.engine.offererOf(take.hook);
        return offerer === undefined ? [] : [offerer];
      });
    const graph = planGraph(
      manifests.filter(manifest => !hookRefused.has(manifest.id) || isCore(manifest.id)),
      on,
      hookEdges,
    );
    const refusals: GraphRefusal[] = [
      ...graph.refused,
      ...planned.refusals.flatMap(refusal =>
        refusal.plugins
          .filter(plugin => !isCore(plugin))
          .map(plugin => ({ plugin, reason: 'hook' as const, sentence: refusal.sentence })),
      ),
    ];
    // a plugin left without a provider only because the enabled set turned that provider off
    const stranded = graph.refused.filter(
      refusal =>
        (refusal.reason === 'needs-refused' || refusal.reason === 'missing-provider') &&
        !planGraph(manifests, () => true, hookEdges).refused.some(other => other.plugin === refusal.plugin),
    );
    return { planned, graph, refusals, stranded };
  };
  let enabled = yamlEnabled;
  let plan = planWith(enabled);
  const bootNotes: DoctorLine[] = [];
  // Said once here, never per call: a host that cannot hold every folder it reads by descriptor.
  const reachNote = await descriptorReachNote(adapters.fs);
  if (reachNote !== undefined) bootNotes.push(reachNote);
  /**
   * The private places that are past their budget now (§7.7). Each one makes every other root on that device refuse
   * everything, so it is never silent: one log line per change, and a standing doctor line until it fits again.
   */
  const pastBudget: { current: readonly PlaceBudget[] } = { current: [] };
  const watchPrivate: TruncationWatcher = budgets => {
    const before = pastBudget.current;
    pastBudget.current = budgets;
    const where = (place: PlaceBudget): string => relative(home, place.path);
    for (const place of budgets)
      if (!before.some(was => was.path === place.path))
        log.warn('a private place holds more than its budget, so every read on its device is refused', {
          place: where(place),
          indexed: place.indexed,
          limit: place.limit,
        });
    for (const place of before)
      if (!budgets.some(now => now.path === place.path))
        log.warn('a private place fits its budget again, so its device is no longer refused', {
          place: where(place),
          limit: place.limit,
        });
  };
  // §2.4: a hand-edited plugins.yaml that strands a plugin is refused; boot keeps the last accepted set. A caller
  // that names the enabled set itself (a suite) is not second-guessed.
  if (options.enabled === undefined) {
    const accepted = await readAcceptedPlugins(adapters.fs, home);
    if (plan.stranded.length === 0)
      await writeAcceptedPlugins(
        adapters.fs,
        home,
        plan.graph.order.map(manifest => manifest.id),
        accepted,
      ).catch(() => log.warn('the accepted plugin set could not be written'));
    else if (accepted !== undefined) {
      const fallback = (id: string): boolean => isCore(id) || accepted.has(id);
      const kept = planWith(fallback);
      if (kept.stranded.length === 0) {
        const turnedOff = manifests.filter(manifest => accepted.has(manifest.id) && !yamlEnabled(manifest.id));
        for (const manifest of turnedOff) {
          const line = await pluginsYamlLine(adapters.fs, home, manifest.id);
          bootNotes.push({
            plugin: 'kernel',
            state: 'warn',
            detail: `config/plugins.yaml${line === undefined ? '' : ` line ${String(line)}`} turns ${manifest.title} off, which ${plan.stranded.map(refusal => manifests.find(item => item.id === refusal.plugin)?.title ?? refusal.plugin).join(', ')} needs, so the daemon started with the last enabled set it accepted.`,
            fix: `Turn ${manifest.title} back on, or turn off what needs it too (fy plugin off ${manifest.id} --with-dependents).`,
          });
        }
        enabled = fallback;
        plan = kept;
      }
    }
  }
  const { planned, graph, refusals } = plan;
  const coreRefusal = [
    ...refusals,
    ...planned.refusals.map(r => ({ plugin: r.plugins[0] ?? '', sentence: r.sentence })),
  ].find(refusal => isCore(refusal.plugin));
  if (coreRefusal !== undefined) return { kind: 'refused', sentence: coreRefusal.sentence, trace };
  // The engine is re-planned over the started set, so a refused plugin's takes do not exist.
  const order = graph.order;
  // Every installed manifest is declared, so a provider turned off or refused is named, unavailable, never absent.
  const { engine: hooks } = HookEngine.plan(order, log, deadline, manifests);

  const data = await loadDataPlugins(adapters.fs, home, new Set(manifests.map(manifest => manifest.id)));
  // What an item names: the installed data plugins' (read once, an install is pinned) united with the owner's config
  // collection of each kind (`config/mcp/<name>.yaml`), read live at every check (no cache: nothing to go stale).
  const items = itemReach({
    installed: await installedItemReach(adapters.fs, home, data.accepted as readonly InstalledItems[]),
    configOwned: configOwnedKinds(order, id => config.port(id)),
  });

  const records = new Map<string, PluginRecord>();
  for (const manifest of manifests) {
    const refusal = refusals.find(candidate => candidate.plugin === manifest.id);
    records.set(manifest.id, {
      manifest,
      status: refusal === undefined ? 'skeleton' : refusal.reason === 'off' ? 'off' : 'refused',
      damage: [],
      lifecycle: new PluginLifecycle(),
      ...(refusal === undefined ? {} : { failure: refusal.sentence }),
    });
  }

  let servingChanged = (): void => undefined;
  const unwatchState: (() => void)[] = [];

  // 3. Open state: every declared file's format.
  /**
   * The state port's pin on the private places (§7.7): a created or replaced private file is pinned by identity, in the
   * very index every root reads, before the write returns. A look that cannot be made rejects the write (the file is on
   * disk, but every root refuses until a look succeeds) and the daemon says so once.
   */
  let toldUnpinned = false;
  const pinReport: PinReport = {
    failed: refusal => {
      if (toldUnpinned) return;
      toldUnpinned = true;
      log.warn(refusal.message);
    },
    // A look that succeeds ends the outage: a second one is said again.
    looked: () => {
      toldUnpinned = false;
    },
  };
  const privatePin: PrivatePin = {
    holds: relativeToState => touchesPrivate(privateFiles, relativeToState),
    created: relativeToState =>
      pinCreated(adapters.fs, home, privateFiles, relativeToState, PRIVATE_RECHECK_MS, watchPrivate, pinReport),
  };
  for (const manifest of order) {
    const record = records.get(manifest.id) as PluginRecord;
    if (manifest.id === 'kernel') continue;
    phases.mark(`state:${manifest.id}`);
    const state = adapters.state(manifest, privatePin);
    record.state = state;
    own(() => state.close());
    record.damage = await state.open();
    const cancel = state.onDamageChanged?.(damage => {
      record.damage = damage;
      servingChanged();
    });
    if (cancel !== undefined) {
      unwatchState.push(cancel);
      own(cancel);
    }
  }

  // Shared kernel machinery. `kernel.config-changed` is the app's (`GET /v1/bus`): no plugin subscribes to it in-process,
  // because it names every plugin's files; a plugin hears its own through `ConfigPort.watchState`.
  const events = new EventBus(log, new Set([ConfigChanged.name]));
  const stopConfigFeed = config.onStateChange?.((plugin, move) => {
    try {
      events.publish(ConfigChanged, configChangedPayload(plugin, move));
    } catch {
      // A path the event's bounds do not carry is a wake-up nobody gets; the file's own state is still read by status.
      log.warn('a config change was not published on the bus', { plugin });
    }
  });
  if (stopConfigFeed !== undefined) own(stopConfigFeed);
  const jobs = new JobRunner(
    clock,
    log,
    plugin => records.get(plugin)?.status === 'serving',
    options.backgroundDelayMs === undefined ? {} : { backgroundDelayMs: options.backgroundDelayMs },
  );
  own(() => jobs.stop());
  const ids = new MintedIdRegistry(adapters.random);
  const bound: {
    admission?: Admission;
    outputGuard?: OutputGuard;
    holds?: InputHolds;
    redaction?: Redaction;
    workFolders?: WorkFolders;
    agentControl?: AgentControlReader;
    childEnvironments?: ChildEnvironmentOpener;
    secretResolver?: SecretResolver;
  } = {};
  const act = createActRunner(() => bound.holds, ids);
  const redaction: Redaction = {
    read: async fn => {
      if (bound.redaction === undefined)
        throw new ApiError(503, 'Masking is unavailable, so nothing is shown.', 'redaction_unavailable');
      return await bound.redaction.read(fn);
    },
  };
  let frozen: PostBuildSnapshot | undefined;
  let phase: 'building' | 'bound' | 'started' = 'building';
  const bootContexts = new Map<string, DaemonContext<Manifest>>();
  const providerHalf = (token: PortToken<unknown>): { record: PluginRecord; key: string } | undefined => {
    const provider = graph.providers.get(token.name);
    const record = provider === undefined ? undefined : records.get(provider);
    const key = record === undefined ? undefined : provideKey(record.manifest, token);
    return record === undefined || key === undefined ? undefined : { record, key };
  };
  // A per-needer provides entry is built once for each plugin it is bound for (§3.7), with that plugin's id and
  // effective permissions; a shared value is handed to every needer as it is.
  const perNeeder = new ProvidedPerNeeder();
  const liveProvided = (record: PluginRecord, key: string, needer: Needer): unknown =>
    livePort(
      perNeeder.valueFor(
        record.manifest.id,
        key,
        (record.half?.provides as Record<string, unknown> | undefined)?.[key],
        needer,
      ),
      () => {
        if (record.status !== 'serving')
          throw new ApiError(503, `${record.manifest.title} is not running.`, 'plugin_unavailable');
      },
    );

  const pins = new PinRegistry(() => adapters.pinner ?? NO_PINNER);
  /**
   * `kernel.paths` for one plugin before its gates. `whichFor`'s readers come from the DECLARED manifests alone (the
   * plugin itself and each one offering a hook it takes), never from anything the caller passes; the Vault answers a
   * handle minted for any other plugin, a forged one and a spent one alike (`unprovable`).
   */
  const ownerPathsFor = (plugin: string): PathsPort => {
    const readers = handleReaders(plugin, manifests);
    const probe: ExecutableProbe = adapters.executable ?? (async () => false);
    return Object.freeze({
      ...ownerPaths,
      locate: async (
        name: string,
        locateOptions: { readonly override: string; readonly directories?: readonly string[] },
      ) =>
        await locateCommand(name, locateOptions, {
          // Asked only for the one variable `gatedOverrides` let through.
          variable: variable => adapters.operatorVariable?.(variable),
          path: adapters.searchPath?.(),
          probe,
        }),
      whichFor: async (name: string, env: ChildEnvironment) => {
        let searchPath: string | undefined;
        try {
          searchPath = bound.childEnvironments?.searchPathOf(env, readers);
        } catch {
          searchPath = undefined;
        }
        return await whichForCommand(name, searchPath, probe);
      },
    });
  };
  const ownerPaths: Pick<PathsPort, 'home' | 'checkDirectory' | 'which'> = Object.freeze({
    home: () => adapters.ownerHome?.() ?? process.env.HOME ?? '/',
    checkDirectory: async (absolutePath: string) => await checkDirectory(adapters.fs, absolutePath),
    // No probe wired (a test host that gave none): nothing is found, never a guess.
    which: async (name: string, whichOptions?: { readonly directories?: readonly string[] }) =>
      adapters.executable === undefined
        ? undefined
        : await whichCommand(
            name,
            { path: adapters.searchPath?.(), directories: whichOptions?.directories ?? [] },
            adapters.executable,
          ),
  });
  /** A plugin's own `resolvers` section, read at each call (unset during build: nothing resolves yet). */
  const resolversOf =
    (id: string): ResolverOf =>
    name =>
      (
        records.get(id)?.half?.resolvers as Readonly<Record<string, (() => readonly string[]) | undefined>> | undefined
      )?.[name];
  const portsFor = (manifest: Manifest, lifecycle: PluginLifecycle): KernelPorts => {
    const rootsPort = rootsPortFor(
      adapters.fs,
      { home, plugin: manifest.id, worktrees: options.worktrees ?? `${home}-worktrees` },
      manifest.permissions?.roots ?? [],
      () => bound.workFolders,
      {
        random: adapters.random,
        privateFiles,
        privateRecheckMs: PRIVATE_RECHECK_MS,
        privateWatch: watchPrivate,
        privateReport: pinReport,
        ...(pins === undefined ? {} : { pins }),
        ...(manifest.permissions?.harnessFiles === undefined
          ? {}
          : { harnessFiles: manifest.permissions.harnessFiles }),
        // Shared trees (`kernel.roots.share`): only a manifest that declares it mints; its own opaque named trees are the
        // only state it may share; every tree it minted is revoked when it stops.
        shareTrees: manifest.permissions?.shareTrees === true,
        setMode: manifest.permissions?.setMode === true,
        ...(manifest.permissions?.projectFiles === undefined
          ? {}
          : { projectFiles: manifest.permissions.projectFiles }),
        stateFiles: manifest.data?.state ?? [],
        onStop: fn => lifecycle.onStop(fn),
      },
    );
    const declaredNetwork = effectivePermissions(manifest.id, manifest.permissions?.network ?? []);
    const fetchPort = restrictFetch(manifest.id, declaredNetwork, adapters.fetch, items, resolversOf(manifest.id));
    return {
      clock,
      log: scopedLog(adapters.logSink, manifest.id),
      state: records.get(manifest.id)?.state?.port as StatePort,
      config: config.port(manifest.id),
      roots: rootsPort,
      events: events.portFor(manifest.id, manifest.data?.publishes ?? []),
      jobs: jobs.portFor(manifest.id),
      workers: workersFor(
        adapters.workers,
        () => {
          const port = records.get(manifest.id)?.state?.port as HostStatePort | undefined;
          return port === undefined ? undefined : (def, name) => port.sqliteGrant(def, name);
        },
        {
          plugin: manifest.id,
          roots: rootsPort,
          fetch: fetchPort,
          declaresNetwork: declaredNetwork.length > 0,
          mayReach: (hostname, host) => hostPermitted(declaredNetwork, items, hostname, resolversOf(manifest.id), host),
          nowMs: () => clock.nowMs(),
          flooded: plugin => log.warn('a worker flooded its grant channel, so the channel was closed', { plugin }),
        },
        { onStop: fn => lifecycle.onStop(fn), stopping: () => lifecycle.stopping() },
        // GAP(kernel): this wiring itself is untested. Compiled-ness is this process's own module URL, so no unit test
        // runs it compiled, and `fyd --check` in the release smoke starts only DECLARED workers: it proves no false
        // refusal, and stays green if this line is deleted. `workersFor`'s rule is unit-tested (declared-workers.test.ts).
        { urls: () => implementations.get(manifest.id)?.workers },
      ),
      spawn: allowDetachedSpawn(
        manifest.id,
        manifest.permissions?.detached,
        effectivePermissions(manifest.id, manifest.permissions?.spawn ?? []),
        restrictSpawn(
          manifest.id,
          effectivePermissions(manifest.id, manifest.permissions?.spawn ?? []),
          openChildEnvironments(adapters.spawn, () => bound.childEnvironments),
          items,
          pins,
          resolversOf(manifest.id),
        ),
        adapters.spawn,
        items,
        // The program's name and pid, never its arguments: a link opener's URL may carry a query.
        (program, pid) => log.info('a detached child was started', { plugin: manifest.id, program, pid }),
        resolversOf(manifest.id),
      ),
      scratch: adapters.scratch ?? NO_SCRATCH,
      fetch: fetchPort,
      websocket: restrictWebSocket(
        manifest.id,
        effectivePermissions(manifest.id, manifest.permissions?.network ?? []),
        websockets,
        items,
        resolversOf(manifest.id),
      ),
      carrierListener: carrierListenerPort({
        manifest,
        dispatcher: () => dispatcher,
        daemonId: identityPort.daemonId,
        onStop: lifecycle.onStop.bind(lifecycle),
        stopping: () => lifecycle.stopping(),
      }),
      identity: identityPort,
      paths: gatedWhich(
        manifest.id,
        manifest.permissions?.which === true,
        gatedPaths(
          manifest.id,
          manifest.permissions?.checkDirectory === true,
          gatedOverrides(manifest.id, manifest.permissions?.whichOverrides, ownerPathsFor(manifest.id)),
        ),
      ),
      updateHost: updateHostOf(manifest, adapters, options.version),
      hostFacts:
        manifest.permissions?.hostFacts === true
          ? (adapters.hostFacts ?? NO_HOST_FACTS)
          : undeclaredHostFacts(manifest.id, adapters.hostFacts ?? NO_HOST_FACTS),
      // The same rule as the testing host (`./processes.ts`), over this machine's table and this host's own handles.
      processes: processesPortFor(
        manifest.id,
        manifest.permissions?.processes,
        ownFolderSpellings,
        adapters.processTable ?? NO_PROCESS_TABLE,
      ),
      timings: options.timings ?? DEFAULT_DAEMON_TIMINGS,
      // `send` goes through this plugin's OWN guarded fetch, to the exact hosts its manifest names (`./secrets.ts`).
      secrets: ownSecretsPort(
        manifest.permissions?.secrets ?? [],
        () => config.secretReferences?.(manifest.id) ?? new Set<string>(),
        () => bound.secretResolver,
        {
          hosts: exactNetworkHosts(declaredNetwork),
          mayReach: (hostname, host) => hostPermitted(declaredNetwork, items, hostname, resolversOf(manifest.id), host),
          transport: outboundSecretTransport(fetchPort, clock),
          log: scopedLog(adapters.logSink, manifest.id),
        },
      ),
      signer: signerFor(manifest.id, sessionSigner),
      ...(manifest.id === 'gate' && configWriter !== undefined ? { configFiles: configWriter } : {}),
      act,
      ids: { mint: prefix => ids.mint(prefix) },
      redaction,
      snapshot: {
        current: () => {
          if (frozen === undefined) throw new TypeError('the post-build snapshot is read after build, not during it');
          return frozen;
        },
      },
      lifecycle,
      contract: {
        hash: surface => {
          if (surface === 'member' && (manifest.actions?.memberRoutes ?? []).length === 0)
            throw new TypeError(`${manifest.id} declares no member routes, so it has no member-surface hash`);
          return options.contractHash?.(manifest.id, surface) ?? 'unhashed';
        },
      },
    };
  };

  // 4. Build in start order.
  const failed = async (id: string, why: string): Promise<void> => {
    const record = records.get(id) as PluginRecord;
    record.status = 'failed';
    record.failure = why;
    hooks.markFailed(id);
    events.unsubscribeAll(id);
    await jobs.discard(id);
    await record.lifecycle.stop(() => log.warn('an onStop handler failed', { plugin: id }));
    for (const dependent of dependentsOf(id, order, graph.providers)) {
      const other = records.get(dependent) as PluginRecord;
      if (other.status === 'serving' || other.status === 'skeleton') {
        other.status = 'failed';
        other.failure = `${other.manifest.title} needs ${record.manifest.title}, which failed.`;
        hooks.markFailed(dependent);
        events.unsubscribeAll(dependent);
        await jobs.discard(dependent);
        await other.lifecycle.stop(() => log.warn('an onStop handler failed', { plugin: dependent }));
      }
    }
  };
  for (const manifest of order) {
    if (manifest.id === 'kernel') {
      records.get('kernel')!.status = 'serving';
      continue;
    }
    const record = records.get(manifest.id) as PluginRecord;
    if (record.status === 'failed') continue;
    phases.mark(`build:${manifest.id}`);
    const implementation = implementations.get(manifest.id);
    if (implementation === undefined || implementation.skeleton === true || implementation.build === undefined) {
      record.status = 'skeleton';
      hooks.attach(manifest.id, undefined, 'skeleton');
      continue;
    }
    const needs: Record<string, unknown> = {};
    const needer = neederOf(manifest, () => config.credentialRecordReferences?.(manifest.id) ?? new Set<string>());
    let missing: string | undefined;
    for (const [key, token] of Object.entries(manifest.needs ?? {})) {
      const provider = providerHalf(token);
      if (provider === undefined || !['serving', 'skeleton'].includes(provider.record.status)) {
        missing = provider?.record.manifest.title ?? token.name;
        break;
      }
      try {
        needs[key] =
          provider.record.status === 'skeleton'
            ? unavailablePort(provider.record.manifest.title)
            : liveProvided(provider.record, provider.key, needer);
      } catch {
        // A per-needer factory that throws binds nothing: the need is unmet, as if its provider were not running.
        missing = provider.record.manifest.title;
        break;
      }
    }
    if (missing !== undefined) {
      await failed(manifest.id, `${manifest.title} needs ${missing}, which is not running.`);
      continue;
    }
    // Each declared internal root's base is made (0700) before any of the plugin's code can ask for it (§7.7).
    const roots = await ensureInternalRootBases(
      adapters.fs,
      { home, plugin: manifest.id },
      manifest.permissions?.roots ?? [],
    );
    for (const refused of roots)
      log.warn('a root base was refused and left as it is', {
        plugin: manifest.id,
        root: refused.name,
        refusal: refused.refusal,
        ...(refused.code === undefined ? {} : { code: refused.code }),
      });
    const uses: Record<string, { current(): unknown }> = {};
    for (const [key, token] of Object.entries(manifest.uses ?? {}))
      uses[key] = {
        current: () => {
          if (phase === 'building') throw new TypeError(`${manifest.id}: an optional port is unbound during build`);
          const provider = providerHalf(token);
          if (provider === undefined || provider.record.status !== 'serving') return undefined;
          return liveProvided(provider.record, provider.key, needer);
        },
      };
    const ctx = {
      manifest,
      needs,
      uses,
      kernel: portsFor(manifest, record.lifecycle),
      hooks: hooks.invokerFor(manifest.id),
    } as unknown as DaemonContext<Manifest>;
    own(() => record.lifecycle.stop(() => log.warn('an onStop handler failed', { plugin: manifest.id })));
    try {
      const built = implementation.build(ctx);
      if (built === null || typeof built !== 'object' || typeof (built as { then?: unknown }).then === 'function')
        throw new TypeError('build must return the half synchronously');
      record.half = built;
      bootContexts.set(manifest.id, ctx);
      record.status = record.damage.length > 0 ? 'damaged' : 'serving';
      hooks.attach(
        manifest.id,
        built.hooks as Readonly<Record<string, unknown>> | undefined,
        record.status === 'serving' ? 'live' : 'failed',
      );
      if (record.status === 'damaged') jobs.pause(manifest.id);
      for (const event of record.status === 'serving' ? (manifest.data?.subscribes ?? []) : []) {
        const fn = (built.subscribers as Record<string, (payload: unknown) => void> | undefined)?.[event.name];
        if (fn !== undefined) events.subscribe(manifest.id, event, fn);
      }
    } catch (error) {
      const thrown = error instanceof Error ? error.message.slice(0, 200) : 'unknown error';
      // The thrown text may carry a path or a value a parser echoed: it stays in the local log and, for a core package
      // (the daemon does not boot), on the operator's own stderr. The record, and so `GET /v1/doctor`, says only which plugin.
      log.error('a plugin failed to build', { plugin: manifest.id, error: thrown });
      if (isCore(manifest.id))
        return { kind: 'refused', sentence: `${manifest.title} failed to build: ${thrown}`, trace };
      await failed(manifest.id, `${manifest.title} failed to build.`);
    }
  }

  // 5. Bind the kernel-bound ports and optional handles; freeze the snapshot.
  phases.mark('bind');
  const boundValue = <T>(token: PortToken<T>): T | undefined => {
    const provider = providerHalf(token as PortToken<unknown>);
    if (provider === undefined || !isCore(provider.record.manifest.id) || provider.record.status !== 'serving')
      return undefined;
    return liveProvided(provider.record, provider.key, KERNEL_NEEDER) as T | undefined;
  };
  Object.defineProperties(bound, {
    admission: { get: () => boundValue(AdmissionPort) },
    outputGuard: { get: () => boundValue(OutputGuardPort) },
    holds: { get: () => boundValue(InputHoldsPort) },
    redaction: { get: () => boundValue(RedactionPort) },
    workFolders: { get: () => boundValue(WorkFoldersPort) },
    agentControl: { get: () => boundValue(AgentControlPort) },
    childEnvironments: { get: () => boundValue(ChildEnvironmentPort) },
    secretResolver: { get: () => boundValue(SecretResolverPort) },
  });
  // Gate's config judge is read live as well.
  Object.defineProperty(judgeAdmission, 'current', { get: () => boundValue(AdmissionPort) });
  phase = 'bound';
  phases.mark('snapshot');
  const started = order.filter(manifest => {
    const status = records.get(manifest.id)?.status;
    return status === 'serving' || status === 'skeleton' || status === 'damaged';
  });
  // A failed plugin stays mounted so its routes answer `plugin_failed` (§3.4); off and refused ones are not.
  const mountable = order.filter(manifest => records.get(manifest.id)?.status !== 'refused');
  frozen = buildSnapshot(
    started,
    data.accepted as readonly DataPluginManifest[],
    options.instructionText ?? (() => undefined),
  );

  // 6. Mount behind admission, by specificity.
  phases.mark('mount');
  const owners = new Map<string, Owner>();
  const ownerOf = (manifest: Manifest): Owner => {
    const existing = owners.get(manifest.id);
    if (existing !== undefined) return existing;
    const owner: Owner = {
      plugin: manifest.id as PluginId,
      title: manifest.title,
      serving: (): Serving => {
        const record = records.get(manifest.id) as PluginRecord;
        switch (record.status) {
          case 'serving':
            return { kind: 'serving' };
          case 'damaged':
            return { kind: 'damaged', files: record.damage.map(damage => damage.file) };
          case 'skeleton':
            return { kind: 'skeleton' };
          default:
            return { kind: 'failed' };
        }
      },
    };
    owners.set(manifest.id, owner);
    return owner;
  };
  const startedAtMs = clock.nowMs();
  const inventory = (): readonly InventoryEntry[] =>
    manifests.map(manifest => {
      const status = records.get(manifest.id)?.status;
      return {
        id: manifest.id,
        on: status === 'serving' || status === 'skeleton' || status === 'damaged',
        contract: options.contractHash?.(manifest.id) ?? 'unhashed',
      };
    });
  // Every declared route, socket and agent tool, by plugin: what Gate asks a device's grants about (§9.6).
  const surfaces: InventorySurfaces = new Map(
    manifests.map(manifest => [manifest.id, inventorySurfacesOf(manifest)] as const),
  );
  const project = (request: ApiRequest, entries: readonly InventoryEntry[]): readonly InventoryEntry[] | undefined => {
    const admission = bound.admission;
    if (admission === undefined) return undefined;
    try {
      return admission.inventory(request, entries, surfaces);
    } catch {
      return undefined;
    }
  };
  const eventPublishers = new Map<string, string>(
    manifests.flatMap(manifest => (manifest.data?.publishes ?? []).map(event => [event.name, manifest.id] as const)),
  );
  const kernelSources: KernelHalfSources = {
    version: options.version,
    inventory,
    project,
    tools: {
      owners: name =>
        [...tools.keys()]
          .filter(key => key.slice(key.indexOf('/') + 1) === name)
          .map(key => key.slice(0, key.indexOf('/'))),
      call: (plugin, name, input, request) => callTool(plugin, name, input, request),
    },
    bus: {
      subscribe: listener => events.onAny(listener),
      publisher: name => eventPublishers.get(name),
      // The projection `GET /v1/plugins` answers with: what the caller may discover. With no Gate bound that is the core
      // pieces only; when Gate IS bound and its projection throws (an undetermined device, a provider error) the answer
      // is no frame at all: a live feed fails closed, where the plugin list falls back to core.
      admits: (request, plugin) => {
        const admission = bound.admission;
        if (admission === undefined) return isCore(plugin);
        try {
          return admission.inventory(request, inventory(), surfaces).some(entry => entry.id === plugin);
        } catch {
          return false;
        }
      },
      // A config change names one file: shown only to a caller `GET /v1/config/file` would let read it.
      frame: (request, name, payload) =>
        name !== ConfigChanged.name || configFrameShown(bound.admission, request, payload, CONFIG_FILE_READ),
    },
    snapshot: () => frozen as PostBuildSnapshot,
    config: { writer: () => configWriter, admission: () => bound.admission, home },
    agentConfig: {
      writer: () => configWriter,
      control: () => bound.agentControl,
      status: () => config.status?.(),
      home,
      binary: options.binaries?.client ?? PRODUCT_BINARIES.client,
      now: () => String(clock.now()),
    },
    admitTool: (name, request) => {
      const entry = tools.get(`kernel/${name}`);
      if (entry === undefined)
        return { outcome: 'refused', response: errorResponse(404, `there is no tool ${name}`, 'unknown_tool') };
      return admitCall(
        bindings,
        'tool',
        { ...entry.decl, method: 'POST', path: `/v1/tools/kernel/${name}` },
        request,
        new Map(),
      );
    },
    recordTool: (name, request, admitted, status) => {
      const entry = tools.get(`kernel/${name}`);
      if (entry === undefined || !('record' in entry.decl.audit)) return;
      try {
        bindings.admission()?.recorded?.({
          table: 'tool',
          descriptor: { ...entry.decl, method: 'POST', path: `/v1/tools/kernel/${name}` },
          request,
          params: new Map(),
          // A call admission refused has no standing: the record names nobody (today's anonymous actor).
          ...(admitted === undefined ? {} : { standing: admitted.standing, actor: admitted.actor }),
          ...(request.principal === undefined ? {} : { principal: request.principal }),
          status,
        });
      } catch {
        // The record is Gate's; the answer stands.
      }
    },
    doctor: async () =>
      doctorReport([
        ...bootNotes,
        ...pastBudgetLines(home, pastBudget.current),
        ...(await doctorLines(records, hooks, jobs, data.refused)),
      ]),
    liveness: () => ({
      status: phase === 'started' ? 'ok' : 'starting',
      uptimeSeconds: Math.max(0, Math.round((clock.nowMs() - startedAtMs) / 1000)),
      pid: options.pid ?? 0,
    }),
  };
  const kernelHandlers = kernelRoutes(kernelSources);
  const kernelBus = kernelSockets(kernelSources);
  const kernelToolHandlers = kernelTools(kernelSources);
  const routes: MountedRoute[] = [];
  const sockets: MountedSocket[] = [];
  const memberRoutes: MountedMemberRoute[] = [];
  const tools = new Map<string, { readonly decl: ToolDecl; readonly owner: Owner; readonly handle?: ToolHandler }>();
  for (const manifest of mountable) {
    const owner = ownerOf(manifest);
    const half = records.get(manifest.id)?.half;
    const handlers =
      manifest.id === 'kernel'
        ? (kernelHandlers as Readonly<Record<string, unknown>>)
        : (half?.routes as Readonly<Record<string, unknown>> | undefined);
    for (const decl of manifest.actions?.routes ?? []) {
      const handle = handlers?.[decl.key] as MountedRoute['handle'];
      routes.push({ ...decl, owner, ...(handle === undefined ? {} : { handle }) });
    }
    for (const decl of manifest.actions?.sockets ?? []) {
      const accept = (
        manifest.id === 'kernel'
          ? (kernelBus as Readonly<Record<string, unknown>>)
          : (half?.sockets as Readonly<Record<string, unknown>> | undefined)
      )?.[decl.key] as MountedSocket['accept'];
      sockets.push({ ...decl, owner, ...(accept === undefined ? {} : { accept }) });
    }
    for (const decl of manifest.actions?.memberRoutes ?? []) {
      const handle = (half?.memberRoutes as Readonly<Record<string, unknown>> | undefined)?.[
        decl.key
      ] as MountedMemberRoute['handle'];
      memberRoutes.push({ ...decl, owner, ...(handle === undefined ? {} : { handle }) });
    }
    for (const decl of manifest.actions?.agentTools ?? []) {
      const handle = (
        manifest.id === 'kernel'
          ? (kernelToolHandlers as Readonly<Record<string, unknown>>)
          : (half?.tools as Readonly<Record<string, unknown>> | undefined)
      )?.[decl.name] as ToolHandler | undefined;
      tools.set(`${manifest.id}/${decl.name}`, { decl, owner, ...(handle === undefined ? {} : { handle }) });
    }
  }
  const bindings = {
    admission: () => bound.admission,
    outputGuard: () => bound.outputGuard,
    version: options.version,
    ...(adapters.compressor === undefined ? {} : { compressor: adapters.compressor }),
  };
  const dispatcher = new Dispatcher(bindings, { routes, sockets, memberRoutes });

  const callTool = async (plugin: string, name: string, input: unknown, request: ApiRequest): Promise<ToolResult> => {
    const entry = tools.get(`${plugin}/${name}`);
    if (entry === undefined) return { text: `There is no tool ${name}.`, isError: true };
    const descriptor = { ...entry.decl, method: 'POST', path: `/v1/tools/${plugin}/${name}` };
    const decision = admitCall(bindings, 'tool', descriptor, request, new Map());
    if (decision.outcome === 'refused') return { text: refusalText(decision.response), isError: true };
    const refusal = notServing(entry.owner);
    if (refusal !== undefined || entry.handle === undefined)
      return { text: refusalText(refusal ?? { status: 503, headers: new Map(), body: '{}' }), isError: true };
    if (entry.decl.input !== undefined && !entry.decl.input.safeParse(input).success)
      return { text: `The input for ${name} does not fit.`, isError: true };
    const handle = entry.handle;
    const call = { request, params: new Map(), ...decision.standing } as Parameters<ToolHandler>[0];
    let ran = false;
    let status = 200;
    const result = await guardedToolResult(
      entry.decl.guard === 'secrets',
      bindings.outputGuard(),
      async () => {
        ran = true;
        try {
          const built = await runInCall({ actor: decision.actor, standing: decision.standing }, () =>
            handle(call, input),
          );
          status = built.isError === true ? 500 : 200;
          return built;
        } catch (error) {
          status = error instanceof ApiError ? error.status : 500;
          throw error;
        }
      },
      () => {
        const unavailable = notServing(entry.owner);
        return unavailable === undefined ? undefined : { text: refusalText(unavailable), isError: true };
      },
    );
    // Audited after the handler settled; the record is Gate's and never changes the answer.
    if (ran && 'record' in entry.decl.audit) {
      try {
        bindings.admission()?.recorded?.({
          table: 'tool',
          descriptor,
          request,
          params: call.params,
          standing: decision.standing,
          actor: decision.actor,
          ...(request.principal === undefined ? {} : { principal: request.principal }),
          status,
        });
      } catch {
        // The record is Gate's; the tool's answer stands.
      }
    }
    return result;
  };

  // The session layer: one per daemon; every carrier opens a link per session on it (§4.8).
  const sessionLayer = createSessionLayer({
    crypto: options.sessionCrypto ?? new WebCryptoSessionCrypto(),
    identity,
    modes: mode => {
      const provided = hooks.provider(SessionModes, mode);
      return provided === 'unavailable' ? undefined : provided;
    },
    dispatch: request => dispatcher.dispatch(request),
    sockets: {
      upgrade: request => dispatcher.upgrade(request),
      reauthorize: request => dispatcher.reauthorize(request),
    },
    clock,
    lease: (options.timings ?? DEFAULT_DAEMON_TIMINGS).lease,
  });
  own(() => sessionLayer.close());
  // The bound admission may tell the host its policy moved (`watch`): every open stream is re-asked at once. The
  // subscription follows the provider: a different or stopped one drops it.
  let watched: { readonly admission: Admission; readonly cancel: () => void } | undefined;
  const followAdmission = (): void => {
    const current = boundValue(AdmissionPort);
    if (watched?.admission === current) return;
    watched?.cancel();
    watched = undefined;
    if (current?.watch === undefined) return;
    try {
      const cancel = current.watch(() => dispatcher.reauthorizeStreams());
      watched = { admission: current, cancel };
    } catch {
      // A provider that cannot be watched is still re-asked on every serving change and frame.
    }
  };
  own(() => {
    watched?.cancel();
    watched = undefined;
  });
  let carriersChanged = (): void => undefined;
  // One live transition owns every serving projection. Repair is observed only when a state read has verified
  // the restored file; a narrower finding never enters record.damage. Failed builds remain failed.
  const reconcileServing = (): void => {
    followAdmission();
    let changed = false;
    for (const manifest of order) {
      const record = records.get(manifest.id) as PluginRecord;
      if (record.half === undefined || record.lifecycle.stopping()) continue;
      const missing = Object.values(manifest.needs ?? {}).some(token => {
        const provider = providerHalf(token);
        return provider === undefined || !['serving', 'skeleton'].includes(provider.record.status);
      });
      const next = record.damage.length > 0 ? 'damaged' : missing ? 'failed' : 'serving';
      if (record.status === next) continue;
      record.status = next;
      changed = true;
      events.unsubscribeAll(manifest.id);
      if (next === 'serving') {
        delete record.failure;
        hooks.attach(manifest.id, record.half.hooks as Readonly<Record<string, unknown>> | undefined, 'live');
        for (const event of manifest.data?.subscribes ?? []) {
          const fn = (record.half.subscribers as Record<string, (payload: unknown) => void> | undefined)?.[event.name];
          if (fn !== undefined) events.subscribe(manifest.id, event, fn);
        }
        jobs.resume(manifest.id);
      } else {
        hooks.markFailed(manifest.id);
        jobs.pause(manifest.id);
        if (next === 'failed') record.failure = `${manifest.title} needs a provider which is not running.`;
      }
    }
    if (!changed) return;
    carriersChanged();
    for (const mode of ['device', 'pair', 'member'] as const)
      if (hooks.provider(SessionModes, mode) === 'unavailable') sessionLayer.endMode(mode);
    // Admission and other bound security providers may affect every standing, including in-flight proofs.
    if (
      [AdmissionPort, OutputGuardPort, InputHoldsPort, RedactionPort].some(token => {
        const provider = providerHalf(token as PortToken<unknown>);
        return provider !== undefined && provider.record.status !== 'serving';
      })
    )
      sessionLayer.close();
    dispatcher.reauthorizeStreams();
  };
  servingChanged = reconcileServing;
  reconcileServing();
  let stopHost = async (): Promise<void> => undefined;
  const running: RunningHost = {
    dispatcher,
    sessionLayer,
    identity,
    snapshot: frozen,
    trace,
    plugins: records,
    hooks,
    events,
    jobs,
    ids,
    dispatch: request => dispatcher.dispatch(request),
    callTool,
    doctor: async () => [
      ...bootNotes,
      ...pastBudgetLines(home, pastBudget.current),
      ...(await doctorLines(records, hooks, jobs, data.refused)),
    ],
    stop: () => stopHost(),
  };

  for (const [id, ctx] of bootContexts) {
    const record = records.get(id);
    const run = record?.half?.beforeListen;
    if (record?.status !== 'serving' || run === undefined) continue;
    phases.mark(`beforeListen:${id}`);
    await beforeListen(() => run(ctx), id, clock, log);
  }

  // 7. Listen: the local listener and every carrier.
  phases.mark('listen');
  const listening: Listening[] = [];
  if (options.listen !== undefined) {
    const listener = await options.listen(running);
    listening.push(listener);
    own(() => listener.stop());
  }
  const carriers = new Map<string, AbortController>();
  const stopCarriers = (): void => {
    for (const controller of [...carriers.values()].reverse()) controller.abort();
    carriers.clear();
  };
  own(stopCarriers);
  carriersChanged = (): void => {
    const provided = hooks.providers(Carriers);
    for (const [key, controller] of carriers) {
      if (provided.has(key as 'direct' | 'relay' | 'tunnel' | 'webrtc')) continue;
      controller.abort();
      carriers.delete(key);
      sessionLayer.close();
    }
    for (const [key, carrier] of provided) {
      if (carriers.has(key)) continue;
      const controller = new AbortController();
      carriers.set(key, controller);
      phases.mark(`carrier:${key}`);
      void carrier.start(sessionLayer, controller.signal).catch(() => log.warn('a carrier stopped', { carrier: key }));
    }
  };
  carriersChanged();

  // 8. Start jobs in start order.
  phases.mark('jobs');
  jobs.start();
  phase = 'started';
  events.publish(PluginsChanged, { generation: 1 });

  // 9. Stop in reverse.
  let stopping: Promise<void> | undefined;
  stopHost = (): Promise<void> => {
    stopping ??= (async () => {
      try {
        trace.push('stop:listen');
        stopCarriers();
        for (const listener of [...listening].reverse()) await listener.stop().catch(() => undefined);
        sessionLayer.close();
        for (const cancel of unwatchState) cancel();
        stopWatching?.();
        watched?.cancel();
        watched = undefined;
        trace.push('stop:jobs');
        await jobs.stop();
        for (const manifest of [...order].reverse()) {
          const record = records.get(manifest.id) as PluginRecord;
          trace.push(`stop:${manifest.id}`);
          await record.lifecycle.stop(() => log.warn('an onStop handler failed', { plugin: manifest.id }));
          await record.state?.close().catch(() => undefined);
        }
      } finally {
        // Last, even when a step above threw: the home is free only once nothing of this daemon still writes in it.
        trace.push('stop:lock');
        await lease.release();
      }
    })();
    return stopping;
  };
  // Where the boot time went: phase names and milliseconds only (see `boot-phases.ts`), before the line that says it is done.
  log.info(phases.line(new Set(manifests.map(manifest => manifest.id))));
  // The first line of every run: a log that stays empty on a healthy boot cannot be told from one nothing writes to.
  log.info('the daemon is serving', { version: options.version });
  return { kind: 'running', host: running };
}

/** `config/plugins.yaml` (§3.6), or undefined when it is missing or broken (its last good version is then in effect). */
function readPluginsYaml(port: ConfigPort): PluginsYaml | undefined {
  try {
    return port.file(PluginsConfig);
  } catch {
    return undefined;
  }
}

function refusalText(response: ApiResponse): string {
  try {
    const body = JSON.parse(response.body) as { error?: unknown };
    return typeof body.error === 'string' ? body.error : `Refused (${response.status}).`;
  } catch {
    return `Refused (${response.status}).`;
  }
}

/**
 * One failing line per private place that is past its budget (§7.7): what it stops, and how to lift it. The place is
 * named relative to the home (never a value), with how many places were indexed against how many are allowed.
 */
function pastBudgetLines(home: string, budgets: readonly PlaceBudget[]): readonly DoctorLine[] {
  return budgets.map(place => ({
    plugin: 'kernel',
    state: 'fail',
    detail:
      `The private place ${relative(home, place.path)} holds more than its ${place.limit} places, so it is not indexed whole ` +
      `and every file on its disk is refused (by every root but the one that owns it, and by every owner's root there): ` +
      `agent homes, fleet files, work folders, imports and harness homes read nothing from that disk.`,
    fix:
      `Remove what you no longer need under ${relative(home, place.path)} — for ended ferret sessions delete the ` +
      `environment.json in their session folder (the credential is dead then) — it is lifted at the next look.`,
  }));
}

async function doctorLines(
  records: ReadonlyMap<string, PluginRecord>,
  hooks: HookEngine,
  jobs: JobRunner,
  dataRefused: readonly { readonly folder: string; readonly sentence: string }[],
): Promise<readonly DoctorLine[]> {
  const lines: DoctorLine[] = [];
  for (const [id, record] of records) {
    for (const damage of record.state?.narrowed?.() ?? [])
      lines.push({ plugin: id, state: 'warn', detail: damage.sentence });
    if (record.status === 'failed' || record.status === 'refused')
      lines.push({ plugin: id, state: 'fail', detail: record.failure ?? `${record.manifest.title} is not running.` });
    if (record.status === 'damaged')
      for (const damage of record.damage) lines.push({ plugin: id, state: 'fail', detail: damage.sentence });
  }
  for (const report of jobs.reports())
    if (report.failures > 0)
      lines.push({
        plugin: report.plugin,
        state: 'warn',
        detail: `The job ${report.id} failed ${report.failures} times.`,
      });
  for (const note of hooks.notes) lines.push({ plugin: 'kernel', state: 'warn', detail: note });
  for (const refused of dataRefused) lines.push({ plugin: refused.folder, state: 'fail', detail: refused.sentence });
  // Contributed checks first, in contribution order (G158: reachability leads `fyd --check`), then the declared ones.
  const checks: readonly { readonly id: string; readonly item: DoctorCheck }[] = hooks.contributions(DoctorChecks);
  for (const check of checks) {
    try {
      const finding = await check.item.run();
      lines.push({ plugin: check.id, state: finding.state, detail: finding.detail });
    } catch {
      lines.push({ plugin: check.id, state: 'fail', detail: `The check ${check.item.title} failed to run.` });
    }
  }
  // Each started plugin's declared checks (manifest `doctor`), in start order; a check that throws is a failure that
  // names the check, never the thrown text (which may carry anything).
  for (const [id, record] of records) {
    if (record.status !== 'serving' && record.status !== 'damaged') continue;
    const runs = (record.half?.doctor ?? {}) as Readonly<Record<string, DoctorRun | undefined>>;
    for (const check of record.manifest.doctor ?? []) {
      const run = runs[check];
      if (run === undefined) {
        lines.push({ plugin: id, check, state: 'fail', detail: `The check ${check} has no implementation.` });
        continue;
      }
      try {
        const finding = await run();
        if (finding === undefined) continue;
        lines.push({
          plugin: id,
          check,
          state: finding.state,
          detail: finding.detail,
          ...(finding.fix === undefined ? {} : { fix: finding.fix }),
        });
      } catch {
        lines.push({ plugin: id, check, state: 'fail', detail: `The check ${check} failed to run.` });
      }
    }
  }
  return lines;
}
