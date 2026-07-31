#!/usr/bin/env bun
import pkg from '../package.json' with { type: 'json' };
import {
  BunSqliteIndexFactory,
  DaemonStorageFactory,
  DaemonSecretsLoader,
  BunSecretShell,
  FileDaemonConfig,
  KeyedSerialExecutor,
  RuntimeEnvironment,
  SqliteHomeLockFactory,
  StateFileSystemFactory,
  StateHomeLayout,
  StateFileSystem,
  SystemClock,
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
import { createFoundationPaths, createWardenPaths, packageRole, resolveStateHome } from '../src/lib/index.ts';

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
  readonly config: FileDaemonConfig;
  readonly secrets: DaemonSecretsLoader;
  readonly createAttentionLedgerRepository: (
    sessionDirectory: (sessionId: string) => string,
  ) => FileAttentionLedgerRepository;
  /** Warden report access. The reports directory hangs off the state home,
   *  which is only known once storage has resolved it, so this is a factory
   *  rather than an instance. */
  readonly wardenReports: (stateDirectory: string) => WardenReportReader;
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
    config: new FileDaemonConfig(paths, new StateFileSystem(paths)),
    secrets: new DaemonSecretsLoader(new BunSecretShell(), { set: (key, value) => (process.env[key] = value) }),
    createAttentionLedgerRepository: sessionDirectory => new FileAttentionLedgerRepository(sessionDirectory),
    wardenReports: stateDirectory => new WardenReportReader(wardenFiles, createWardenPaths(stateDirectory).reports),
  };
}

/** Boots the daemon from an already-built world, so tests can inject their own. */
export async function start(world: DaemonWorld): Promise<number> {
  if (world.role !== 'daemon') return 1;
  const config = await world.config.load();
  await world.secrets.load(config.secretsFile);
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
