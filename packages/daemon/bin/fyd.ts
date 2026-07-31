#!/usr/bin/env bun
import pkg from '../package.json' with { type: 'json' };
import {
  BrowserWorkerClient,
  BunSqliteIndexFactory,
  DaemonBinder,
  DaemonHealthProbe,
  DaemonReadinessWaiter,
  DaemonStorageFactory,
  DaemonSecretsLoader,
  BunSecretShell,
  daemonSecretSourceProgram,
  FileDaemonConfig,
  KeyedSerialExecutor,
  RuntimeEnvironment,
  SocketViewerDownstream,
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
import {
  GitWorktreeGateway,
  ManagedWorktreeAdapter,
  NodeWorktreeFileSystem,
  SystemWorktreeClock,
  WorktreeOperationQueue,
} from '../src/adapters/worktrees/index.ts';
import { NodeWardenReportFileSystem, WardenReportReader } from '../src/adapters/warden/index.ts';
<<<<<<< HEAD
import {
  EXIT_ALREADY_RUNNING,
  createFoundationPaths,
  createWardenPaths,
  packageRole,
  resolveStateHome,
  type DaemonReadinessPorts,
} from '../src/lib/index.ts';
=======
import { BrowserViewerStream, type BrowserViewerHost, createWardenPaths, packageRole } from '../src/lib/index.ts';
>>>>>>> 39218e5 (feat(daemon): add the browser worker client and viewer socket adapters)

// Identity is single-sourced from package.json, matching the CLI's composition root.
const DAEMON_NAME = Object.keys(pkg.bin ?? {})[0] ?? pkg.name;

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
  readonly createAttentionLedgerRepository: (
    sessionDirectory: (sessionId: string) => string,
  ) => FileAttentionLedgerRepository;
  /** Warden report access. The reports directory hangs off the state home,
   *  which is only known once storage has resolved it, so this is a factory
   *  rather than an instance. */
  readonly wardenReports: (stateDirectory: string) => WardenReportReader;
  readonly browserTransport: BrowserTransportWorld;
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
    config: new FileDaemonConfig(paths, new StateFileSystem(paths)),
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
    createAttentionLedgerRepository: sessionDirectory => new FileAttentionLedgerRepository(sessionDirectory),
    wardenReports: stateDirectory => new WardenReportReader(wardenFiles, createWardenPaths(stateDirectory).reports),
    browserTransport: {
      connectWorker: options => BrowserWorkerClient.connect(options),
      openViewerStream: (host, sessionId, socket) =>
        BrowserViewerStream.connect(host, sessionId, new SocketViewerDownstream(socket), new SystemFrameClock()),
    },
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
