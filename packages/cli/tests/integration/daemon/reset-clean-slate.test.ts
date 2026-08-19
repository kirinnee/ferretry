import { afterEach, describe, it } from 'bun:test';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HealthView } from '@ferretry/protocol';
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
import { NixStoreGcRoot } from '../../../src/adapters/daemon/nix-gc-root.ts';
import { BunDaemonProcess } from '../../../src/adapters/daemon/process.ts';
import { FileResetTrees } from '../../../src/adapters/daemon/reset-trees.ts';
import { FileRetiredArtifacts } from '../../../src/adapters/daemon/retired-artifacts.ts';
import { FileServiceStore } from '../../../src/adapters/daemon/service-files.ts';
import { FileStateHomeClaim } from '../../../src/adapters/state-home/claim-files.ts';
import { DaemonController, type DaemonControllerDeps } from '../../../src/lib/daemon/controller.ts';
import { type DaemonLayout, resolveDaemonLayout } from '../../../src/lib/daemon/layout.ts';
import type { IDaemonLifecycleClaim } from '../../../src/lib/daemon/ports.ts';
import { DirectSupervisor } from '../../../src/lib/daemon/supervisor.ts';
import { StateHomeClaimService } from '../../../src/lib/state-home/claim.ts';

/**
 * `fy daemon reset`, end to end, and then `fy daemon start` on what it left behind.
 *
 * THE SECOND HALF IS THE POINT. Removing two directories is easy to get right and easy to prove; what
 * an owner actually needs is a machine that comes back, and that is a claim about the seam between two
 * packages with no compiler across it. So this drives the REAL controller over the REAL filesystem
 * adapters, and then hands the surviving directory to the daemon's own `DaemonStorageFactory` — the
 * same composition `packages/daemon/bin/fyd.ts` uses. A reset that left a subtly wrong home would boot
 * into `StateHomeLayoutError` here rather than in front of the person who ran it.
 *
 * This file and `fresh-home-bootstrap.test.ts` are the only places `packages/cli` reaches into
 * `packages/daemon`, and it stays confined to a test for the reason stated there: the two packages have
 * no dependency on each other and must not gain one, so this seam has no compiler to check it.
 */

const roots = new Set<string>();
const stores = new Set<DaemonStorage>();

/** A harmless executable to launch: this proves the client's filesystem effects, not the daemon's boot. */
const NOTHING = Bun.which('true') ?? '/bin/true';

async function createTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fy-reset-slate-'));
  roots.add(root);
  return root;
}

/** The layout `fy daemon …` resolves, with both roots inside one temporary directory. */
function layoutFor(root: string): DaemonLayout {
  return resolveDaemonLayout({
    platform: 'linux',
    homeDirectory: join(root, 'home'),
    stateHome: join(root, 'home', 'state'),
    configHome: join(root, 'home', 'config-home'),
    stateDirectory: join(root, 'home', 'client-state'),
    userId: 1000,
    daemonName: 'fyd',
    product: 'ferretry',
    searchPath: '/usr/bin:/bin',
  });
}

/** Exactly what `fy daemon start` does to the filesystem before the daemon is running. */
async function startThroughTheClient(layout: DaemonLayout): Promise<void> {
  const supervisor = new DirectSupervisor(
    layout,
    new BunDaemonProcess(),
    new FileServiceStore(),
    new StateHomeClaimService(new FileStateHomeClaim(), 'fy daemon adopt'),
  );
  const handle = await supervisor.start(NOTHING);
  if (handle.pid !== undefined) {
    try {
      process.kill(handle.pid, 'SIGKILL');
    } catch {
      // Already gone — `true` exits at once.
    }
  }
}

/** The daemon's own bootstrap, composed the way `packages/daemon/bin/fyd.ts` composes it. */
async function bootTheDaemon(stateHome: string): Promise<{ created: boolean }> {
  const factory = new DaemonStorageFactory(
    new RuntimeEnvironment({ FY_HOME: stateHome }, () => '/home-must-not-be-used'),
    new StateFileSystemFactory(),
    new StateHomeLayout(),
    new SqliteHomeLockFactory(),
    new BunSqliteIndexFactory(),
    new SystemClock(() => new Date('2026-08-19T12:00:00.000Z')),
    () => new KeyedSerialExecutor(),
  );
  const opened = await factory.open();
  stores.add(opened.storage);
  return opened.layout;
}

async function closeStores(): Promise<void> {
  for (const storage of stores) await storage.close().catch(() => undefined);
  stores.clear();
}

/**
 * A full installation: a claimed and bootstrapped state home, plus the artifact tree an upgraded host
 * carries — a snapshot store sealed read-only, and a garbage-collection link into a store output.
 */
async function installation(layout: DaemonLayout): Promise<void> {
  await startThroughTheClient(layout);
  await bootTheDaemon(layout.stateHome);
  await closeStores();
  // Somebody's real data on the other end of a link inside the tree, and a password verifier and a
  // secret inside the home, so what a reset destroys is something this test can see going.
  await writeFile(join(layout.stateHome, 'state', 'operator-password.json'), '{"digest":"argon2id"}');
  await writeFile(join(layout.stateHome, 'state', 'secrets.json'), '{"ciphertext":"x"}');

  const snapshot = join(layout.legacySnapshotRoot, 'snapshots', `sha256-${'a'.repeat(64)}`);
  await mkdir(snapshot, { recursive: true });
  await writeFile(join(snapshot, 'fyd'), 'x'.repeat(1_000));
  await chmod(join(snapshot, 'fyd'), 0o555);
  await chmod(snapshot, 0o555);
}

/** Every collaborator the client actually ships, apart from the daemon's answer and the terminal. */
function deps(layout: DaemonLayout, out: string[], serving: HealthView | undefined): DaemonControllerDeps {
  return {
    layout,
    service: undefined,
    direct: new DirectSupervisor(
      layout,
      new BunDaemonProcess(),
      new FileServiceStore(),
      new StateHomeClaimService(new FileStateHomeClaim(), 'fy daemon adopt'),
    ),
    health: { probe: () => Promise.resolve(serving) },
    logs: { exists: () => Promise.resolve(false), show: () => Promise.resolve(0) },
    nix: new NixStoreGcRoot(new BunDaemonProcess()),
    lifecycle: {
      acquire: (): Promise<IDaemonLifecycleClaim> => Promise.resolve({ release: () => Promise.resolve(undefined) }),
    },
    installedDaemon: () => ({ path: NOTHING, source: 'PATH', version: '1.2.3' }),
    retired: new FileRetiredArtifacts(),
    resetTrees: new FileResetTrees(),
    // The daemon is down in every case here, so nothing is ever asked of this. That is the ordinary
    // situation for a reset: somebody is resetting a machine whose daemon will not serve.
    resetInventory: { count: () => Promise.resolve(undefined) },
    prompt: { ask: () => Promise.resolve('') },
    interactive: () => false,
    clientName: 'fy',
    clock: { now: () => 0, sleep: () => Promise.resolve() },
    out: {
      success: message => out.push(message),
      warn: message => out.push(message),
      error: message => out.push(message),
      setExitCode: () => {},
    },
    firstPassword: { offer: () => Promise.resolve() },
  };
}

async function exists(path: string): Promise<boolean> {
  return await lstat(path).then(
    () => true,
    () => false,
  );
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
  await closeStores();
  for (const root of roots) {
    // The fixtures seal directories read-only, so the tidy-up needs the same unsealing the subject does.
    await new FileRetiredArtifacts().retire(root);
    await rm(root, { recursive: true, force: true });
  }
  roots.clear();
});

describe('resetting an installation and starting again on the clean slate', () => {
  it('should remove BOTH roots of a real installation, including the sealed snapshot store', async () => {
    // Arrange — the exact state an upgraded host is in, and the exact mistake this verb exists to stop:
    // clearing the state home by hand and leaving the artifact tree, then running the pinned daemon
    // inside it.
    const layout = layoutFor(await createTemporaryRoot());
    await installation(layout);
    should(await exists(join(layout.stateHome, 'state', 'operator-password.json'))).be.true();
    should(await exists(layout.legacySnapshotRoot)).be.true();

    // Act
    const out: string[] = [];
    await new DaemonController(deps(layout, out, undefined)).reset({ yes: true });

    // Assert
    should(await exists(layout.stateHome)).be.false();
    should(await exists(layout.stateArtifactRoot)).be.false();
    should(out.join('\n')).containEql('removed 2 path(s)');
  });

  it('should leave a state home the daemon bootstraps exactly as it does on a fresh machine', async () => {
    // Arrange
    const layout = layoutFor(await createTemporaryRoot());
    await installation(layout);
    await new DaemonController(deps(layout, [], undefined)).reset({ yes: true });

    // Act — `fy daemon start` on the clean slate, then the daemon's own boot into what it left.
    await startThroughTheClient(layout);
    const afterTheClient = await entriesOf(layout.stateHome);
    const opened = await bootTheDaemon(layout.stateHome);

    // Assert — byte for byte the shape `fresh-home-bootstrap.test.ts` pins for a machine that has never
    // run this. A reset that left an unclaimed home, or a stray entry the daemon's layout model has not
    // declared, would throw StateHomeLayoutError right here instead of in front of the owner.
    should(afterTheClient).deepEqual(['layout-version', 'logs']);
    should(opened.created).be.false();
    should(await readFile(join(layout.stateHome, 'layout-version'), 'utf8')).equal('1\n');
    should(await entriesOf(layout.stateHome)).deepEqual([
      'config',
      'daemon.lock',
      'fleet',
      'layout-version',
      'logs',
      'state',
    ]);
  });

  it('should leave no operator password, so the first start offers to set one as a fresh install does', async () => {
    // Arrange — this is the escape hatch working: somebody who has forgotten the password resets, and
    // the machine comes back with no password at all rather than with one nobody can prove.
    const layout = layoutFor(await createTemporaryRoot());
    await installation(layout);

    // Act
    await new DaemonController(deps(layout, [], undefined)).reset({ yes: true });
    await startThroughTheClient(layout);
    await bootTheDaemon(layout.stateHome);

    // Assert — the verifier lives at `state/operator-password.json`, and a boot that found one would
    // mean the reset had left the gate standing.
    should(await exists(join(layout.stateHome, 'state', 'operator-password.json'))).be.false();
    should(await exists(join(layout.stateHome, 'state', 'secrets.json'))).be.false();
  });

  it('should never follow a link out of either root, whatever it points at', async () => {
    // Arrange — the artifact tree really does hold links into `/nix/store`, and FY_HOME may hold one of
    // its own. Following either would recursively delete data that is not this daemon's, and nothing in
    // the caller could undo it.
    const root = await createTemporaryRoot();
    const layout = layoutFor(root);
    await installation(layout);
    const precious = join(root, 'not-ours');
    await mkdir(join(precious, 'bin'), { recursive: true });
    await writeFile(join(precious, 'bin', 'fyd'), 'somebody elses executable');
    await mkdir(join(layout.stateArtifactRoot, 'nix'), { recursive: true });
    await symlink(precious, layout.nixGcRoot);
    await symlink(precious, join(layout.stateHome, 'fleet', 'homes'));

    // Act
    const out: string[] = [];
    await new DaemonController(deps(layout, out, undefined)).reset({ yes: true });

    // Assert — both trees gone, both links gone, and every byte on the far side of them still there.
    should(await exists(layout.stateHome)).be.false();
    should(await exists(layout.nixGcRoot)).be.false();
    should(await readFile(join(precious, 'bin', 'fyd'), 'utf8')).equal('somebody elses executable');
    // And it was said out loud before anything was destroyed, so nobody had to trust it.
    should(out.join('\n')).containEql('NOTHING it points at is read, followed or removed');
  });

  it('should be safe to run twice, reporting plainly that there was nothing left', async () => {
    // Arrange — somebody who is not sure the first one worked runs it again.
    const layout = layoutFor(await createTemporaryRoot());
    await installation(layout);
    await new DaemonController(deps(layout, [], undefined)).reset({ yes: true });

    // Act
    const out: string[] = [];
    await new DaemonController(deps(layout, out, undefined)).reset({ yes: true });

    // Assert
    should(out.join('\n')).containEql('had no persistent data on this host; nothing was removed');
  });

  it('should refuse a reset whose state home resolves to the invoking home directory', async () => {
    // Arrange — `FY_HOME=$HOME`, which is a typo somebody will make, and the cost of not catching it is
    // every file that person owns. The refusal has to land before anything is measured, let alone
    // removed.
    const root = await createTemporaryRoot();
    const home = join(root, 'home');
    await mkdir(join(home, 'documents'), { recursive: true });
    await writeFile(join(home, 'documents', 'thesis.txt'), 'years of work');
    const layout = resolveDaemonLayout({
      platform: 'linux',
      homeDirectory: home,
      stateHome: home,
      configHome: join(home, 'config-home'),
      stateDirectory: join(home, 'client-state'),
      userId: 1000,
      daemonName: 'fyd',
      product: 'ferretry',
      searchPath: '/usr/bin:/bin',
    });

    // Act + Assert
    await should(new DaemonController(deps(layout, [], undefined)).reset({ yes: true })).be.rejectedWith(
      /resolves to the home directory itself/u,
    );
    should(await readFile(join(home, 'documents', 'thesis.txt'), 'utf8')).equal('years of work');
  });
});
