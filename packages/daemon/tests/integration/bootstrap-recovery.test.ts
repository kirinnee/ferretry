import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  BunSqliteIndexFactory,
  type DaemonStorage,
  DaemonStorageFactory,
  KeyedSerialExecutor,
  type OpenedDaemonStorage,
  RuntimeEnvironment,
  SqliteHomeLockFactory,
  StateFileSystem,
  StateFileSystemFactory,
  StateHomeLayout,
  SystemClock,
} from '../../src/adapters/index.ts';
import {
  createFoundationPaths,
  type FileSystemFactory,
  type FoundationPaths,
  resolveStateHome,
  StateHomeLayoutError,
} from '../../src/lib/index.ts';

const homes = new Set<string>();
const stores = new Set<DaemonStorage>();

/** Aborts the layout bootstrap at one required directory, the way a crash or a full disk would. */
class DirectoryFailingStateFileSystem extends StateFileSystem {
  constructor(
    paths: FoundationPaths,
    private readonly failedDirectory: string,
  ) {
    super(paths);
  }

  override async ensureDirectory(path: string, mode: number): Promise<void> {
    if (path === this.failedDirectory) throw new Error(`injected bootstrap failure at ${path}`);
    await super.ensureDirectory(path, mode);
  }
}

/** Aborts after the whole scaffold exists but before the layout marker is durable. */
class MarkerFailingStateFileSystem extends StateFileSystem {
  override async writeTextAtomic(path: string, text: string): Promise<void> {
    if (path.endsWith('/layout-version')) throw new Error('injected marker write failure');
    await super.writeTextAtomic(path, text);
  }
}

async function createTemporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-bootstrap-test-'));
  homes.add(home);
  return home;
}

function pathsFor(home: string): FoundationPaths {
  return createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: '/home-must-not-be-used' }));
}

function factoryFor(home: string, fileSystems: FileSystemFactory): DaemonStorageFactory {
  return new DaemonStorageFactory(
    new RuntimeEnvironment({ FY_HOME: home }, () => '/home-must-not-be-used'),
    fileSystems,
    new StateHomeLayout(),
    new SqliteHomeLockFactory(),
    new BunSqliteIndexFactory(),
    new SystemClock(() => new Date('2026-07-30T12:00:00.000Z')),
    () => new KeyedSerialExecutor(),
  );
}

async function openStorage(home: string): Promise<OpenedDaemonStorage> {
  const opened = await factoryFor(home, new StateFileSystemFactory()).open();
  stores.add(opened.storage);
  return opened;
}

async function capturedError(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
    return undefined;
  } catch (error) {
    return error;
  }
}

async function entriesOf(path: string): Promise<readonly string[]> {
  try {
    return (await readdir(path)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

afterEach(async () => {
  for (const storage of stores) await storage.close().catch(() => undefined);
  stores.clear();
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

describe('interrupted bootstrap recovery', () => {
  it.each([
    { directory: 'config' as const, root: ['daemon.lock'], state: [] },
    { directory: 'fleet' as const, root: ['config', 'daemon.lock'], state: [] },
    { directory: 'state' as const, root: ['config', 'daemon.lock', 'fleet'], state: [] },
    { directory: 'index' as const, root: ['config', 'daemon.lock', 'fleet', 'state'], state: [] },
    { directory: 'sessions' as const, root: ['config', 'daemon.lock', 'fleet', 'state'], state: ['index'] },
    {
      directory: 'temporary' as const,
      root: ['config', 'daemon.lock', 'fleet', 'state'],
      state: ['index', 'sessions'],
    },
  ])('should recover a home abandoned while creating $directory', async ({ directory, root, state }) => {
    // Arrange
    const home = await createTemporaryHome();
    const paths = pathsFor(home);
    const failing = factoryFor(home, {
      create: created => new DirectoryFailingStateFileSystem(created, created[directory]),
    });

    // Act
    const failure = await capturedError(async () => await failing.open());
    const abandonedRoot = await entriesOf(home);
    const abandonedState = await entriesOf(paths.state);
    const recovered = await openStorage(home);

    // Assert
    should(String(failure)).containEql(`injected bootstrap failure at ${paths[directory]}`);
    should(abandonedRoot).deepEqual(root);
    should(abandonedState).deepEqual(state);
    should(recovered.layout.created).be.true();
    should(await readFile(paths.layoutVersion, 'utf8')).equal('1\n');
    should(await entriesOf(home)).deepEqual(['config', 'daemon.lock', 'fleet', 'layout-version', 'state']);
    should(await entriesOf(paths.state)).deepEqual(['index', 'sessions', 'tmp']);
  });

  it('should recover a scaffold still holding the marker scratch file', async () => {
    // Arrange
    const home = await createTemporaryHome();
    const paths = pathsFor(home);
    const failing = factoryFor(home, { create: created => new MarkerFailingStateFileSystem(created) });
    const failure = await capturedError(async () => await failing.open());
    const scratch = join(paths.temporary, 'layout-version.7f3a-1.tmp');
    await writeFile(scratch, '1\n', { mode: 0o600 });

    // Act
    const recovered = await openStorage(home);

    // Assert
    should(String(failure)).containEql('injected marker write failure');
    should(recovered.layout.created).be.true();
    should(await readFile(paths.layoutVersion, 'utf8')).equal('1\n');
    should(await exists(scratch)).be.false();
  });

  it('should reuse a recovered home on the next open without re-initializing it', async () => {
    // Arrange
    const home = await createTemporaryHome();
    const paths = pathsFor(home);
    const failing = factoryFor(home, {
      create: created => new DirectoryFailingStateFileSystem(created, created.sessions),
    });
    await capturedError(async () => await failing.open());
    const first = await openStorage(home);
    await first.storage.close();
    stores.delete(first.storage);

    // Act
    const second = await openStorage(home);

    // Assert
    should(first.layout.created).be.true();
    should(second.layout.created).be.false();
    should((await stat(paths.layoutVersion)).mode & 0o777).equal(0o600);
  });
});

describe('foreign state-home refusal', () => {
  it.each([
    {
      name: 'an unknown root file beside the lock',
      seed: async (paths: FoundationPaths) => await writeFile(join(paths.home, 'notes.txt'), 'foreign'),
      survivor: (paths: FoundationPaths) => join(paths.home, 'notes.txt'),
    },
    {
      name: 'an unknown root directory beside the lock',
      seed: async (paths: FoundationPaths) => await mkdir(join(paths.home, 'workspaces')),
      survivor: (paths: FoundationPaths) => join(paths.home, 'workspaces'),
    },
    {
      name: 'an authoritative daemon config',
      seed: async (paths: FoundationPaths) => {
        await mkdir(paths.config, { recursive: true });
        await writeFile(paths.daemonConfig, '{"foreign":true}\n');
      },
      survivor: (paths: FoundationPaths) => paths.daemonConfig,
    },
    {
      name: 'an authoritative fleet manifest',
      seed: async (paths: FoundationPaths) => {
        await mkdir(paths.fleet, { recursive: true });
        await writeFile(paths.fleetManifest, '{"foreign":true}\n');
      },
      survivor: (paths: FoundationPaths) => paths.fleetManifest,
    },
    {
      name: 'index content',
      seed: async (paths: FoundationPaths) => {
        await mkdir(paths.index, { recursive: true });
        await writeFile(paths.sessionIndex, 'foreign');
      },
      survivor: (paths: FoundationPaths) => paths.sessionIndex,
    },
    {
      name: 'session content',
      seed: async (paths: FoundationPaths) => {
        await mkdir(join(paths.sessions, 'foreign-session'), { recursive: true });
        await writeFile(join(paths.sessions, 'foreign-session', 'session-version'), '1\n');
      },
      survivor: (paths: FoundationPaths) => join(paths.sessions, 'foreign-session', 'session-version'),
    },
    {
      name: 'an unexpected temporary file',
      seed: async (paths: FoundationPaths) => {
        await mkdir(paths.temporary, { recursive: true });
        await writeFile(join(paths.temporary, 'daemon.json.abc.tmp'), 'foreign');
      },
      survivor: (paths: FoundationPaths) => join(paths.temporary, 'daemon.json.abc.tmp'),
    },
    {
      name: 'an unknown directory below state',
      seed: async (paths: FoundationPaths) => await mkdir(join(paths.state, 'cache'), { recursive: true }),
      survivor: (paths: FoundationPaths) => join(paths.state, 'cache'),
    },
    {
      name: 'a known name of the wrong type',
      seed: async (paths: FoundationPaths) => await writeFile(paths.state, 'foreign'),
      survivor: (paths: FoundationPaths) => paths.state,
    },
  ])('should refuse a home holding $name', async ({ seed, survivor }) => {
    // Arrange
    const home = await createTemporaryHome();
    const paths = pathsFor(home);
    await writeFile(paths.daemonLock, '', { mode: 0o600 });
    await seed(paths);
    const before = await entriesOf(home);

    // Act
    const error = await capturedError(async () => await openStorage(home));

    // Assert
    should(error instanceof StateHomeLayoutError).be.true();
    should(await exists(survivor(paths))).be.true();
    should(await exists(paths.layoutVersion)).be.false();
    should(await entriesOf(home)).deepEqual(before);
  });

  it('should refuse a complete scaffold that never held the lifetime lock', async () => {
    // Arrange
    const home = await createTemporaryHome();
    const paths = pathsFor(home);
    for (const directory of [paths.config, paths.fleet, paths.index, paths.sessions, paths.temporary])
      await mkdir(directory, { recursive: true });

    // Act
    const error = await capturedError(async () => await openStorage(home));

    // Assert
    should(error instanceof StateHomeLayoutError).be.true();
    should((error as StateHomeLayoutError).decision.reason).equal('missing-marker');
    should(await exists(paths.daemonLock)).be.false();
    should(await exists(paths.layoutVersion)).be.false();
  });

  it('should refuse a lock entry of the wrong type', async () => {
    // Arrange
    const home = await createTemporaryHome();
    const paths = pathsFor(home);
    await mkdir(paths.daemonLock);

    // Act
    const error = await capturedError(async () => await openStorage(home));

    // Assert
    should(error instanceof StateHomeLayoutError).be.true();
    should(await exists(paths.layoutVersion)).be.false();
    should(await entriesOf(home)).deepEqual(['daemon.lock']);
  });
});
