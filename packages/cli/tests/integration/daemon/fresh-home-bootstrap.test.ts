import { afterEach, describe, it } from 'bun:test';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  BunSqliteIndexFactory,
  type DaemonStorage,
  DaemonStorageFactory,
  KeyedSerialExecutor,
  RuntimeEnvironment,
  SqliteHomeLockFactory,
  StateFileSystemFactory,
  StateHomeLayout,
  SystemClock,
} from '../../../../daemon/src/adapters/index.ts';
import { StateHomeLayoutError } from '../../../../daemon/src/lib/index.ts';
import { BunDaemonProcess } from '../../../src/adapters/daemon/process.ts';
import { FileServiceStore } from '../../../src/adapters/daemon/service-files.ts';
import { FileDaemonSnapshotStore } from '../../../src/adapters/daemon/snapshot-store.ts';
import { FileStateHomeClaim } from '../../../src/adapters/state-home/claim-files.ts';
import { resolveDaemonLayout } from '../../../src/lib/daemon/layout.ts';
import { DirectSupervisor } from '../../../src/lib/daemon/supervisor.ts';
import { StateHomeClaimRefusedError, StateHomeClaimService } from '../../../src/lib/state-home/claim.ts';

/**
 * The first-run seam, in the tier CI actually runs.
 *
 * `fy daemon start` creates `<state home>/logs` for the log it configured and then launches `fyd`
 * into that home. Neither package can prove this alone: `decideLayout` is a pure function that was
 * always correct on the inputs it was given, and the CLI's supervisor always created the directory it
 * was told to. The defect was that the daemon's layout model had never been told the directory was
 * ours, so the very first start on any clean machine refused its own log directory as foreign state.
 *
 * `tests/e2e/fresh-home-bootstrap.e2e.test.ts` drives the same journey through the compiled binary
 * and is the better test — but no CI job runs the E2E tier, so this one carries the guard. It uses
 * both packages' REAL production classes: the CLI's `DirectSupervisor` over its real filesystem and
 * process adapters, then the daemon's real `DaemonStorageFactory` against the home that left behind.
 *
 * This test file is the only place `packages/cli` reaches into `packages/daemon`. That is deliberate
 * and confined to a test: the two packages have no dependency on each other and must not gain one, so
 * the seam between them has no compiler to check it. The corresponding name invariant is pinned in
 * `scripts/validate/cli-contracts.sh::state-home-log-directory`.
 */

const homes = new Set<string>();
const stores = new Set<DaemonStorage>();

/**
 * A harmless executable to launch: this proves the CLI's filesystem effects, not the daemon's boot.
 *
 * `true` writes nothing and exits at once. Resolved rather than hardcoded because it lives in
 * `/bin` on Linux and `/usr/bin` on macOS — and deliberately something silent, since the supervisor
 * appends its child's output to the log file this test then inspects.
 */
const NOTHING = Bun.which('true') ?? '/bin/true';

async function createTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fy-fresh-home-'));
  homes.add(root);
  return root;
}

/** The layout `fy daemon start` resolves, with a state home that does not exist yet. */
function layoutFor(root: string): ReturnType<typeof resolveDaemonLayout> {
  return resolveDaemonLayout({
    platform: 'linux',
    homeDirectory: root,
    stateHome: join(root, 'state'),
    configHome: join(root, 'config-home'),
    stateDirectory: join(root, 'cli-state'),
    userId: 1000,
    daemonName: 'fyd',
    product: 'ferretry',
    searchPath: '/usr/bin:/bin',
  });
}

/** Exactly what `fy daemon start` does to the filesystem before the daemon is running. */
async function startThroughTheCli(root: string): Promise<string> {
  const layout = layoutFor(root);
  const snapshots = new FileDaemonSnapshotStore({
    root: layout.snapshotRoot,
    daemon: { product: layout.product, name: layout.daemonName },
    sourceBinary: NOTHING,
  });
  const built = await snapshots.build();
  await snapshots.promote(built.id);
  const supervisor = new DirectSupervisor(
    layout,
    new BunDaemonProcess(),
    new FileServiceStore(),
    new StateHomeClaimService(new FileStateHomeClaim(), 'fy daemon adopt'),
  );
  const handle = await supervisor.start(built.binaryPath);
  if (handle.pid !== undefined) {
    // Reap the child immediately: this test is about the directory it was launched into.
    try {
      process.kill(handle.pid, 'SIGKILL');
    } catch {
      // Already gone — `env` with no arguments exits at once.
    }
  }
  return layout.stateHome;
}

async function makeWritable(path: string): Promise<void> {
  const state = await lstat(path).catch(() => undefined);
  if (state === undefined || state.isSymbolicLink()) return;
  await chmod(path, state.isDirectory() ? 0o700 : 0o600);
  if (!state.isDirectory()) return;
  for (const entry of await readdir(path)) await makeWritable(join(path, entry));
}

/** The daemon's own bootstrap, composed the way `packages/daemon/bin/fyd.ts` composes it. */
async function bootTheDaemon(stateHome: string): Promise<{ created: boolean }> {
  const factory = new DaemonStorageFactory(
    new RuntimeEnvironment({ FY_HOME: stateHome }, () => '/home-must-not-be-used'),
    new StateFileSystemFactory(),
    new StateHomeLayout(),
    new SqliteHomeLockFactory(),
    new BunSqliteIndexFactory(),
    new SystemClock(() => new Date('2026-08-04T12:00:00.000Z')),
    () => new KeyedSerialExecutor(),
  );
  const opened = await factory.open();
  stores.add(opened.storage);
  return opened.layout;
}

async function entriesOf(path: string): Promise<readonly string[]> {
  try {
    return (await readdir(path)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

afterEach(async () => {
  for (const storage of stores) await storage.close().catch(() => undefined);
  stores.clear();
  for (const home of homes) {
    await makeWritable(home);
    await rm(home, { recursive: true, force: true });
  }
  homes.clear();
});

describe('first-run daemon bootstrap across the package seam', () => {
  it('should leave a state home the daemon can bootstrap, on a machine that has never run this', async () => {
    // Arrange — no state home at all, the way a clean machine arrives.
    const root = await createTemporaryRoot();

    // Act
    const stateHome = await startThroughTheCli(root);
    const afterTheCli = await entriesOf(stateHome);
    const layout = await bootTheDaemon(stateHome);

    // Assert — before the log-directory fix this threw StateHomeLayoutError('… is non-empty but has
    // no layout-version marker'), because `logs` was not a declared part of the layout.
    //
    // The CLI now CLAIMS the home before creating anything inside it, so the marker is already there
    // when the daemon arrives and the daemon adopts rather than initializes. That is the ordering
    // fix: the home stops depending on which of the two ran first.
    should(afterTheCli).deepEqual(['layout-version', 'logs']);
    should(await entriesOf(join(stateHome, 'logs'))).deepEqual(['fyd.log']);
    should(layout.created).be.false();
    should(await readFile(join(stateHome, 'layout-version'), 'utf8')).equal('1\n');
  });

  it('should bootstrap when logs already holds the log of a previous failed attempt', async () => {
    // Arrange — the reporting user's exact state: `rm -rf` did not help them, because the next start
    // recreated `logs/` before the daemon ever looked at the home.
    const root = await createTemporaryRoot();
    const stateHome = join(root, 'state');
    await mkdir(join(stateHome, 'logs'), { recursive: true });
    await writeFile(
      join(stateHome, 'logs', 'fyd.log'),
      `fyd: state home ${stateHome} is non-empty but has no layout-version marker\n`,
      'utf8',
    );

    // Act
    await startThroughTheCli(root);
    const layout = await bootTheDaemon(stateHome);

    // Assert — the CLI adopts this shape rather than refusing it, and that tolerance is required
    // rather than merely convenient: an OLDER `fy` on this same host creates `logs/` without a claim,
    // so every upgrading installation arrives in exactly this state. It mirrors the daemon's own
    // `preBootstrapShape`, so the two writers still agree about what a lone `logs/` means.
    should(layout.created).be.false();
    should(await entriesOf(stateHome)).deepEqual(['config', 'daemon.lock', 'fleet', 'layout-version', 'logs', 'state']);
  });

  it('should reuse the home on a second start rather than re-initializing it', async () => {
    // Arrange
    const root = await createTemporaryRoot();
    const stateHome = await startThroughTheCli(root);
    const first = await bootTheDaemon(stateHome);
    for (const storage of stores) await storage.close();
    stores.clear();

    // Act — a second `fy daemon start` on an already-initialized home.
    await startThroughTheCli(root);
    const second = await bootTheDaemon(stateHome);

    // Assert — neither boot initializes, because the CLI's claim got there before the first one.
    should(first.created).be.false();
    should(second.created).be.false();
    should((await stat(join(stateHome, 'logs'))).mode & 0o777).equal(0o700);
  });

  it('should still refuse a state home holding somebody else s data', async () => {
    // Arrange — the guard neither the log directory nor the claim may have loosened. The foreign
    // data is arranged BEFORE anything of ours runs, which is what the scenario actually is: a
    // person points FY_HOME at a directory that was never Ferretry's.
    //
    // Deliberately not "claim the home, then add a stray directory": a home carrying our marker is
    // one we created, and `decideLayout` proceeds on it whatever else has since appeared inside —
    // that was true before this change too. Asserting the guard through an already-claimed home
    // would be asserting the wrong thing and would pass for the wrong reason.
    const root = await createTemporaryRoot();
    const stateHome = join(root, 'state');
    await mkdir(join(stateHome, 'workspaces'), { recursive: true });
    await writeFile(join(stateHome, 'notes.txt'), 'not a state home\n', 'utf8');

    // Act — both writers refuse it now. Before this change the CLI would have provisioned into it.
    const cliFailure = await startThroughTheCli(root).then(
      () => undefined,
      (error: unknown) => error,
    );
    const daemonFailure = await bootTheDaemon(stateHome).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert — refused by both, and nothing of ours written into it.
    should(cliFailure).be.instanceOf(StateHomeClaimRefusedError);
    should(daemonFailure).be.instanceOf(StateHomeLayoutError);
    should(await entriesOf(stateHome)).deepEqual(['notes.txt', 'workspaces']);
  });
});
