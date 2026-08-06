import { afterEach, describe, it } from 'bun:test';
import type { Stats } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  BunSqliteIndexFactory,
  classifyDirectoryEntry,
  type DaemonStorage,
  DaemonStorageFactory,
  type DirectoryEntryKind,
  KeyedSerialExecutor,
  type OpenedDaemonStorage,
  RuntimeEnvironment,
  SESSION_MESSAGE_TOKEN_KEY_BASENAME,
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

/**
 * The pinned key basename the marker-absent recovery admits, and the root of its scratch name —
 * IMPORTED from the owner rather than restated, so a test cannot keep passing against a name
 * production no longer writes.
 */
const TOKEN_KEY_BASENAME = SESSION_MESSAGE_TOKEN_KEY_BASENAME;

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
    { directory: 'logs' as const, root: ['config', 'daemon.lock', 'fleet'], state: [] },
    { directory: 'state' as const, root: ['config', 'daemon.lock', 'fleet', 'logs'], state: [] },
    { directory: 'index' as const, root: ['config', 'daemon.lock', 'fleet', 'logs', 'state'], state: [] },
    {
      directory: 'sessions' as const,
      root: ['config', 'daemon.lock', 'fleet', 'logs', 'state'],
      state: ['index'],
    },
    {
      directory: 'temporary' as const,
      root: ['config', 'daemon.lock', 'fleet', 'logs', 'state'],
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
    should(await entriesOf(home)).deepEqual(['config', 'daemon.lock', 'fleet', 'layout-version', 'logs', 'state']);
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

  it('should recover a scaffold holding the published token key and its own scratch file', async () => {
    // Arrange: the key is created once, on first use, by the same daemon that bootstraps the home —
    // so a crash between publishing it and writing the marker leaves exactly this shape. Without a
    // rule for it, a perfectly intact installation would refuse to boot for ever.
    const home = await createTemporaryHome();
    const paths = pathsFor(home);
    const failing = factoryFor(home, { create: created => new MarkerFailingStateFileSystem(created) });
    await capturedError(async () => await failing.open());
    const key = join(paths.state, TOKEN_KEY_BASENAME);
    const scratch = join(paths.temporary, `${TOKEN_KEY_BASENAME}.7f3a-1.tmp`);
    await writeFile(key, Buffer.alloc(32), { mode: 0o600 });
    await writeFile(scratch, Buffer.alloc(32), { mode: 0o600 });

    // Act
    const recovered = await openStorage(home);

    // Assert: recovery accepts the home, keeps the key, and sweeps only the scratch.
    should(recovered.layout.created).be.true();
    should(await exists(key)).be.true();
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

/**
 * A state home the CLI has touched but the daemon has never bootstrapped.
 *
 * `fy daemon start` creates the log directory so the service manager has somewhere to write, then
 * launches the daemon. That happens before any lock, directory or marker of ours exists, so the very
 * first daemon on a clean machine always meets a home holding exactly `logs/` — and, on a retry, the
 * log of the attempt that failed.
 */
describe('pre-bootstrap state home', () => {
  it.each([
    { name: 'an empty log directory, as the first ever start leaves it', logs: [] },
    { name: 'the log of a previous failed start', logs: ['fyd.log'] },
    { name: 'several logs', logs: ['fyd.log', 'fyd-old.log'] },
  ])('should initialize a home holding $name', async ({ logs }) => {
    // Arrange
    const home = await createTemporaryHome();
    const paths = pathsFor(home);
    await mkdir(paths.logs, { recursive: true });
    for (const log of logs) await writeFile(join(paths.logs, log), 'refusing to start\n');

    // Act
    const opened = await openStorage(home);

    // Assert — the daemon must reach a bootstrapped home, not refuse its own log directory.
    should(opened.layout.created).be.true();
    should(await readFile(paths.layoutVersion, 'utf8')).equal('1\n');
    should(await entriesOf(paths.logs)).deepEqual([...logs].sort());
  });

  it('should keep the log directory across a later open', async () => {
    // Arrange
    const home = await createTemporaryHome();
    const paths = pathsFor(home);
    await mkdir(paths.logs, { recursive: true });
    await writeFile(join(paths.logs, 'fyd.log'), 'first boot\n');
    const first = await openStorage(home);
    await first.storage.close();
    stores.delete(first.storage);

    // Act — the second `fy daemon start` on an already-initialized home.
    const second = await openStorage(home);

    // Assert
    should(first.layout.created).be.true();
    should(second.layout.created).be.false();
    should(await readFile(join(paths.logs, 'fyd.log'), 'utf8')).equal('first boot\n');
    should((await stat(paths.logs)).mode & 0o777).equal(0o700);
  });

  it.each([
    {
      name: 'a scaffold directory the CLI never creates',
      seed: async (paths: FoundationPaths) => await mkdir(paths.config, { recursive: true }),
    },
    {
      name: 'an unknown root directory beside the logs',
      seed: async (paths: FoundationPaths) => await mkdir(join(paths.home, 'workspaces'), { recursive: true }),
    },
    {
      name: 'an unknown root file beside the logs',
      seed: async (paths: FoundationPaths) => await writeFile(join(paths.home, 'notes.txt'), 'foreign'),
    },
    {
      name: 'a file in the log directory that is not a log',
      seed: async (paths: FoundationPaths) => await writeFile(join(paths.logs, 'notes.txt'), 'foreign'),
    },
    {
      name: 'a name ending in .log that is a directory',
      seed: async (paths: FoundationPaths) => await mkdir(join(paths.logs, 'archive.log'), { recursive: true }),
    },
    {
      name: 'a subdirectory of the log directory',
      seed: async (paths: FoundationPaths) => await mkdir(join(paths.logs, 'archive'), { recursive: true }),
    },
  ])('should still refuse a lockless home holding $name', async ({ seed }) => {
    // Arrange — the log directory alone is legitimate; it does not license anything beside it.
    const home = await createTemporaryHome();
    const paths = pathsFor(home);
    await mkdir(paths.logs, { recursive: true });
    await seed(paths);
    const before = await entriesOf(home);

    // Act
    const error = await capturedError(async () => await openStorage(home));

    // Assert
    should(error instanceof StateHomeLayoutError).be.true();
    should((error as StateHomeLayoutError).decision.reason).equal('missing-marker');
    should(await exists(paths.layoutVersion)).be.false();
    should(await exists(paths.daemonLock)).be.false();
    should(await entriesOf(home)).deepEqual(before);
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
      name: 'a non-log file in the log directory',
      seed: async (paths: FoundationPaths) => {
        await mkdir(paths.logs, { recursive: true });
        await writeFile(join(paths.logs, 'notes.txt'), 'foreign');
      },
      survivor: (paths: FoundationPaths) => join(paths.logs, 'notes.txt'),
    },
    {
      name: 'a directory below the log directory',
      seed: async (paths: FoundationPaths) => await mkdir(join(paths.logs, 'archive'), { recursive: true }),
      survivor: (paths: FoundationPaths) => join(paths.logs, 'archive'),
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

/**
 * The classification itself, including the one case a real filesystem here cannot produce.
 *
 * Some FUSE, overlay and network mounts answer `DT_UNKNOWN` for every entry, so every Dirent
 * predicate is false. Refusing those outright would make an ordinary home unusable there, and
 * calling them regular files would defeat the whole check — so that case, and only that case, is
 * resolved with a non-following `lstat`. Nothing is ever opened.
 */
describe('directory entry classification', () => {
  const indeterminate = (name: string): DirectoryEntryKind => ({
    name,
    isDirectory: () => false,
    isFile: () => false,
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
  });

  const kindOf = (directory: boolean, file: boolean): Stats =>
    ({ isDirectory: () => directory, isFile: () => file }) as Stats;

  it('should resolve an indeterminate entry with lstat, and fail closed when even that cannot', async () => {
    // Arrange
    const asked: string[] = [];
    const answering = (kind: Stats) => async (path: string) => {
      asked.push(path);
      return kind;
    };

    // Act
    const regular = await classifyDirectoryEntry('/state', indeterminate('key'), answering(kindOf(false, true)));
    const folder = await classifyDirectoryEntry('/state', indeterminate('sessions'), answering(kindOf(true, false)));
    const neither = await classifyDirectoryEntry('/state', indeterminate('pipe'), answering(kindOf(false, false)));
    const refused = await classifyDirectoryEntry('/state', indeterminate('gone'), async () => {
      throw Object.assign(new Error('lstat refused'), { code: 'EACCES' });
    });

    // Assert
    should(asked).deepEqual(['/state/key', '/state/sessions', '/state/pipe']);
    should(regular).deepEqual({ name: 'key', directory: false, regularFile: true });
    should(folder).deepEqual({ name: 'sessions', directory: true, regularFile: false });
    should(neither).deepEqual({ name: 'pipe', directory: false, regularFile: false });
    should(refused).deepEqual({ name: 'gone', directory: false, regularFile: false });
  });

  it('should never consult lstat for a kind the directory read already knows', async () => {
    // Arrange: one syscall per unknown entry is acceptable; one per entry on every listing is not,
    // and asking about a FIFO at all is how a classification turns into a hang.
    const known = (kind: keyof DirectoryEntryKind): DirectoryEntryKind => ({
      ...indeterminate('entry'),
      [kind]: () => true,
    });
    const never = async (): Promise<Stats> => {
      throw new Error('the kind was already known, so nothing may be asked about the path');
    };

    // Act
    const results = await Promise.all(
      (
        ['isDirectory', 'isFile', 'isSymbolicLink', 'isFIFO', 'isSocket', 'isBlockDevice', 'isCharacterDevice'] as const
      ).map(async kind => await classifyDirectoryEntry('/state', known(kind), never)),
    );

    // Assert
    should(results.map(entry => entry.regularFile)).deepEqual([false, true, false, false, false, false, false]);
    should(results.map(entry => entry.directory)).deepEqual([true, false, false, false, false, false, false]);
  });
});

/**
 * A recognised NAME is not a recognised ENTRY.
 *
 * Recovery admits two token-key names, and both are admitted as ORDINARY FILES. Anything else
 * wearing one of those names belongs to whoever planted it: a symlink resolves to bytes outside the
 * home, and a FIFO is not data at all — an implementation that decided by opening the path would
 * block the daemon's bootstrap for ever on one. The classification therefore comes from the
 * directory read, and these prove it on the real filesystem rather than on a stand-in.
 */
describe('token-key entries in a marker-absent home', () => {
  /**
   * The link's target lives in its OWN tracked temporary directory, never inside the home under
   * test: an extra unknown file in the home would refuse the layout by itself, and the assertion
   * would then pass even with the classification broken.
   */
  const plantSymlink = async (path: string): Promise<void> => {
    const elsewhere = await createTemporaryHome();
    const outside = join(elsewhere, 'somebody-elses-key');
    await writeFile(outside, Buffer.alloc(32), { mode: 0o600 });
    await symlink(outside, path);
  };

  const plantFifo = (path: string): void => {
    const made = Bun.spawnSync(['mkfifo', path]);
    if (!made.success) throw new Error(`fixture mkfifo failed: ${new TextDecoder().decode(made.stderr)}`);
  };

  it.each([
    {
      name: 'a symlink wearing the key name',
      plant: async (paths: FoundationPaths) => await plantSymlink(join(paths.state, TOKEN_KEY_BASENAME)),
    },
    {
      name: 'a FIFO wearing the key name',
      plant: async (paths: FoundationPaths) => plantFifo(join(paths.state, TOKEN_KEY_BASENAME)),
    },
    {
      name: 'a directory wearing the key name',
      plant: async (paths: FoundationPaths) => await mkdir(join(paths.state, TOKEN_KEY_BASENAME)),
    },
    {
      name: 'a symlink wearing the scratch name',
      plant: async (paths: FoundationPaths) =>
        await plantSymlink(join(paths.temporary, `${TOKEN_KEY_BASENAME}.writer-a.tmp`)),
    },
    {
      name: 'a FIFO wearing the scratch name',
      plant: async (paths: FoundationPaths) => plantFifo(join(paths.temporary, `${TOKEN_KEY_BASENAME}.writer-a.tmp`)),
    },
    {
      name: 'a scratch name whose writer id is outside the strict grammar',
      plant: async (paths: FoundationPaths) =>
        await writeFile(join(paths.temporary, `${TOKEN_KEY_BASENAME}.writer_a.tmp`), 'foreign'),
    },
    {
      name: 'a key name that is nearly, but not exactly, the pinned one',
      plant: async (paths: FoundationPaths) =>
        await writeFile(join(paths.state, `${TOKEN_KEY_BASENAME}.old`), Buffer.alloc(32)),
    },
  ])('should refuse $name and leave the home unclaimed', async ({ plant }) => {
    // Arrange: a complete interrupted scaffold, plus the planted entry and nothing else — so the
    // refusal can only come from the entry's KIND, never from an extra unknown name.
    const home = await createTemporaryHome();
    const paths = pathsFor(home);
    const failing = factoryFor(home, { create: created => new MarkerFailingStateFileSystem(created) });
    await capturedError(async () => await failing.open());
    await plant(paths);

    // Act
    const error = await capturedError(async () => await openStorage(home));

    // Assert: refused promptly — nothing here opens the planted entry — and nothing was claimed.
    should(error instanceof StateHomeLayoutError).be.true();
    should((error as StateHomeLayoutError).decision.reason).equal('missing-marker');
    should(await exists(paths.layoutVersion)).be.false();
  });
});
