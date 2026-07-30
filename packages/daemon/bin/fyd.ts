#!/usr/bin/env bun
import { join } from 'node:path';
import pkg from '../package.json' with { type: 'json' };
import {
  BrowserWorkerClient,
  BunProcessProbe,
  BunCommandRunner,
  BunSqliteIndexFactory,
  CachedUsageFeed,
  CommandUsageSource,
  DaemonBinder,
  DaemonHealthProbe,
  DaemonReadinessWaiter,
  DaemonStorageFactory,
  DaemonSecretsLoader,
  BunSecretShell,
  daemonSecretSourceProgram,
  FileDaemonConfig,
  FileRoutingCatalog,
  HttpUsageSource,
  KeyedSerialExecutor,
  ManifestAccountInventory,
  RuntimeEnvironment,
  SocketViewerDownstream,
  PaneProcessInventory,
  TmuxPaneSnapshot,
  SqliteHomeLockFactory,
  StateFileSystemFactory,
  StateHomeLayout,
  StateFileSystem,
  SystemClock,
  SystemFrameClock,
  type ViewerSocket,
  type WorkerClientOptions,
} from '../src/adapters/index.ts';
import { FileAttentionLedgerRepository } from '../src/adapters/attention/file-attention-ledger-repository.ts';
import { BunGitRunner } from '../src/adapters/git/index.ts';
import { NodeTranscriptSource } from '../src/adapters/transcript/index.ts';
import {
  GitWorktreeGateway,
  ManagedWorktreeAdapter,
  NodeWorktreeFileSystem,
  SystemWorktreeClock,
  WorktreeOperationQueue,
} from '../src/adapters/worktrees/index.ts';
import { NodeWardenReportFileSystem, WardenReportReader } from '../src/adapters/warden/index.ts';
import {
  FileSessionTaskStore,
  NodeWorkingDirectoryResolver,
  StorageSessionLifecycleRepository,
  TimeSessionIdFactory,
  TmuxSessionLifecycleLauncher,
} from '../src/adapters/session/lifecycle/index.ts';
import { BunTmuxProcess } from '../src/adapters/tmux/index.ts';
import type { DaemonStorage } from '../src/adapters/storage/session-storage.ts';
import {
  BrowserViewerStream,
  EXIT_ALREADY_RUNNING,
  SessionPlanner,
  TeamAdvisor,
  createFoundationPaths,
  createSessionPaths,
  createWardenPaths,
  defaultSessionLifecycleSettings,
  defaultStartWaitPolicy,
  packageRole,
  resolveStateHome,
  SessionLifecycleService,
  TmuxController,
  type BrowserViewerHost,
  MigrationPreflight,
  usageProbeCommand,
  type DaemonConfig,
  type DaemonReadinessPorts,
  type UsageFeedPort,
  ClaudeTranscriptParser,
  CodexTranscriptParser,
  type DaemonReadinessPorts,
  type TranscriptSource,
} from '../src/lib/index.ts';

// Identity is single-sourced from package.json, matching the CLI's composition root.
const DAEMON_NAME = Object.keys(pkg.bin ?? {})[0] ?? pkg.name;

/** The tmux process port demands an absolute executable; PATH lookup is the root's business. */
function resolveTmuxExecutable(): string {
  const executable = Bun.which('tmux');
  if (executable === null) throw new Error('tmux was not found on PATH; it is required to manage sessions');
  return executable;
}
/** Fallback when tmux is not on `$PATH`. Absolute by construction: the tmux adapter refuses a bare
 *  name so no lookup can ever land on the machine's default socket, and an absent binary surfaces
 *  as a failed inspection, which the migration gate then refuses. */
const FALLBACK_TMUX = '/usr/bin/tmux';

/**
 * The adapters a daemon process needs. Subsystem units add their ports here as they land; this is
 * the ONLY seam where pure domain (`src/lib`) meets IO (`src/adapters`).
 *
 * It exists because the two repository gates pull in opposite directions: the architecture gate
 * forbids `src/lib` from importing `src/adapters`, while production dead-code analysis requires
 * every module to be reachable from the package entry. A composition root outside both directories
 * satisfies each — the same reason `packages/cli/bin/fy.ts` is shaped this way.
 */
export interface DaemonWorld {
  readonly role: typeof packageRole;
  readonly storage: DaemonStorageFactory;
  readonly worktrees: ManagedWorktreeAdapter;
  readonly boot: {
    readonly probe: DaemonHealthProbe;
    readonly binder: DaemonBinder;
  };
  readonly createReadinessWaiter: (ports: DaemonReadinessPorts, daemonLog: string) => DaemonReadinessWaiter;
  readonly config: FileDaemonConfig;
  readonly secrets: DaemonSecretsLoader;
  /** The destructive-migration safety gate: it inventories in-flight work and refuses to migrate
   *  a session whose work cannot be shown to survive the relaunch. */
  readonly migratePreflight: MigrationPreflight;
  readonly createAttentionLedgerRepository: (
    sessionDirectory: (sessionId: string) => string,
  ) => FileAttentionLedgerRepository;
  /** Warden report access. The reports directory hangs off the state home,
   *  which is only known once storage has resolved it, so this is a factory
   *  rather than an instance. */
  readonly wardenReports: (stateDirectory: string) => WardenReportReader;
  readonly browserTransport: BrowserTransportWorld;
  /** Session lifecycle: create, launch, deliver turn one, stop. The authoritative store is only
   *  open once storage has resolved and locked the state home, so the service is built per opened
   *  storage rather than at process start. */
  readonly createSessionLifecycle: (storage: DaemonStorage) => SessionLifecycleService;
  /** The daemon-wide account-health feed: one snapshot shared by every session
   *  instead of one probe per session. Its sources are configured, so it is
   *  built once configuration has loaded. */
  readonly createUsageFeed: (config: DaemonConfig) => UsageFeedPort;
  /** Team recommendation over the published fleet manifest and the operator's
   *  routing catalog, reading account headroom from the feed above. */
  readonly createTeamAdvisor: (usage: UsageFeedPort) => TeamAdvisor;
  /** The shape of one session: its name, parent, display model, context window
   *  and launch window. */
  readonly sessions: SessionPlanner;
  /** One follower per harness. The daemon never branches on harness: it picks the source whose
   *  `harness` matches the session and reads through the common port. */
  readonly transcriptSources: readonly TranscriptSource[];
}

/**
 * The browser transport seam: the session runtime asks for a driver and for viewer streams, and never
 * learns what a child process or a socket is.
 */
export interface BrowserTransportWorld {
  connectWorker(options: WorkerClientOptions): Promise<BrowserWorkerClient>;
  openViewerStream(host: BrowserViewerHost, sessionId: string, socket: ViewerSocket): Promise<BrowserViewerStream>;
}

/** Builds the production adapter set. Subsystem units extend this as they land. */
export function buildWorld(): DaemonWorld {
  const clock = new SystemClock();
  const environment = new RuntimeEnvironment();
  const paths = createFoundationPaths(resolveStateHome(environment.stateHomeInput()));
  const worktreeClock = new SystemWorktreeClock();
  const files = new NodeWorktreeFileSystem();
  const gateway = new GitWorktreeGateway(new BunGitRunner(), files, worktreeClock);
  const wardenFiles = new NodeWardenReportFileSystem();
  const tmux = new BunTmuxProcess(Bun.which('tmux') ?? FALLBACK_TMUX, join(paths.home, 'tmux.sock'));
  const stateFiles = new StateFileSystem(paths);
  return {
    role: packageRole,
    storage: new DaemonStorageFactory(
      environment,
      new StateFileSystemFactory(),
      new StateHomeLayout(),
      new SqliteHomeLockFactory(),
      new BunSqliteIndexFactory(),
      clock,
      () => new KeyedSerialExecutor(),
    ),
    worktrees: new ManagedWorktreeAdapter(gateway, files, worktreeClock, new WorktreeOperationQueue()),
    boot: {
      probe: new DaemonHealthProbe({ fetch: (url, init) => fetch(url, init) }),
      binder: new DaemonBinder({ sleep: milliseconds => Bun.sleep(milliseconds) }, { now: () => Date.now() }),
    },
    createReadinessWaiter: (ports, daemonLog) => new DaemonReadinessWaiter(ports, daemonLog),
    config: new FileDaemonConfig(paths, stateFiles),
    secrets: new DaemonSecretsLoader(
      new BunSecretShell({
        source: file => {
          const child = Bun.spawnSync({
            cmd: ['/bin/sh', '-c', daemonSecretSourceProgram, 'fyd-secrets', file, process.execPath],
            stdin: 'ignore',
            stdout: 'pipe',
            stderr: 'ignore',
            timeout: 5_000,
            maxBuffer: 1_024 * 1_024,
          });
          return { success: child.success, stdout: child.stdout.toString() };
        },
      }),
      { set: (key, value) => (process.env[key] = value) },
    ),
    migratePreflight: new MigrationPreflight(
      new PaneProcessInventory(tmux, new BunProcessProbe(Bun.which('ps') ?? undefined)),
      new TmuxPaneSnapshot(tmux),
    ),
    createAttentionLedgerRepository: sessionDirectory => new FileAttentionLedgerRepository(sessionDirectory),
    wardenReports: stateDirectory => new WardenReportReader(wardenFiles, createWardenPaths(stateDirectory).reports),
    browserTransport: {
      connectWorker: options => BrowserWorkerClient.connect(options),
      openViewerStream: (host, sessionId, socket) =>
        BrowserViewerStream.connect(host, sessionId, new SocketViewerDownstream(socket), new SystemFrameClock()),
    },
    createSessionLifecycle: storage =>
      new SessionLifecycleService(
        {
          repository: new StorageSessionLifecycleRepository(storage),
          launcher: new TmuxSessionLifecycleLauncher(
            // A private absolute socket inside the state home is what keeps managed panes off any
            // tmux server the host already runs.
            new TmuxController(new BunTmuxProcess(resolveTmuxExecutable(), join(paths.home, 'tmux.sock'))),
            milliseconds => Bun.sleep(milliseconds),
          ),
          tasks: new FileSessionTaskStore(id => createSessionPaths(paths, id).directory),
          directories: new NodeWorkingDirectoryResolver(),
          ids: new TimeSessionIdFactory(),
          clock,
          // Its own queue: session mutations must not serialize behind storage-wide work.
          serial: new KeyedSerialExecutor(),
        },
        defaultSessionLifecycleSettings,
      ),
    createUsageFeed: config => {
      // The collector endpoint first, then the command fallback for hosts where it is not
      // listening. Both are optional: a daemon configured with neither serves an empty fleet and
      // says so, rather than pretending every account is at zero.
      const command = usageProbeCommand(config.usage.fallbackCommand);
      return new CachedUsageFeed(
        [
          ...(config.usage.url === undefined ? [] : [new HttpUsageSource(config.usage.url)]),
          ...(command === undefined ? [] : [new CommandUsageSource(new BunCommandRunner(process.env), command)]),
        ],
        { refreshMs: config.usage.refreshSeconds * 1_000 },
      );
    },
    createTeamAdvisor: usage =>
      new TeamAdvisor(
        new ManifestAccountInventory(stateFiles, paths.fleetManifest),
        new FileRoutingCatalog(stateFiles, paths.routingCatalog),
        usage,
      ),
    sessions: new SessionPlanner({
      startWait: defaultStartWaitPolicy,
      contextWindowOverrides: {},
      namePrefix: DAEMON_NAME,
      remoteControlPrefix: DAEMON_NAME,
    }),
    transcriptSources: [
      new NodeTranscriptSource(new ClaudeTranscriptParser()),
      new NodeTranscriptSource(new CodexTranscriptParser()),
    ],
  };
}

/** Boots the daemon from an already-built world, so tests can inject their own. */
export async function start(world: DaemonWorld): Promise<number> {
  if (world.role !== 'daemon') return 1;
  const config = await world.config.load();
  await world.secrets.load(config.secretsFile);
  if (await world.boot.probe.responds({ url: config.publicUrl })) return EXIT_ALREADY_RUNNING;
  return 0;
}

async function execute(): Promise<number> {
  const cleanups: Array<() => void | Promise<void>> = [];
  try {
    return await start(buildWorld());
  } catch (error) {
    process.stderr.write(`${DAEMON_NAME}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    // Each cleanup runs in its own try/catch so a failing one never masks the exit code.
    for (const cleanup of cleanups) {
      try {
        await cleanup();
      } catch {
        // Intentionally ignored: cleanup failures must not change the result.
      }
    }
  }
}

if (import.meta.main) {
  process.exit(await execute());
}
