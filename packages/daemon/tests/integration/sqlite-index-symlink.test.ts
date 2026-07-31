import { Database } from 'bun:sqlite';
import { afterEach, describe, it } from 'bun:test';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { BunSqliteIndexFactory, StateFileSystem } from '../../src/adapters/index.ts';
import {
  CURRENT_INDEX_SCHEMA_VERSION,
  createFoundationPaths,
  type FoundationPaths,
  indexFiles,
  resolveStateHome,
} from '../../src/lib/index.ts';

const directories = new Set<string>();

/** Plants a symlink at the index path after the drop step has removed every index file. */
class SymlinkPlantingStateFileSystem extends StateFileSystem {
  constructor(
    paths: FoundationPaths,
    private readonly plant: () => Promise<void>,
  ) {
    super(paths);
  }

  override async removeFile(path: string): Promise<void> {
    await super.removeFile(path);
    if (path.endsWith('-shm')) await this.plant();
  }
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ferretry-index-symlink-'));
  directories.add(directory);
  return directory;
}

async function createTemporaryPaths(): Promise<FoundationPaths> {
  const home = await createTemporaryDirectory();
  return createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: '/home-must-not-be-used' }));
}

/** A valid SQLite file the daemon does not own: opening it at all would already be a breach. */
async function createForeignDatabase(path: string, generation: number): Promise<void> {
  const database = new Database(path, { create: true, strict: true });
  try {
    database.exec(`PRAGMA user_version = ${generation}`);
    database.exec('CREATE TABLE secrets (value TEXT NOT NULL)');
    database.query('INSERT INTO secrets (value) VALUES (?)').run('must survive');
  } finally {
    database.close();
  }
}

function sidecarPath(paths: FoundationPaths, suffix: string): string {
  const file = indexFiles(paths).find(candidate => candidate.endsWith(suffix));
  if (file === undefined) throw new Error(`no index file ends with ${suffix}`);
  return file;
}

async function capturedError(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
    return undefined;
  } catch (error) {
    return error;
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
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
  directories.clear();
});

describe('session index symlink refusal', () => {
  it('should refuse a symlinked session index before SQLite can open its target', async () => {
    // Arrange
    const paths = await createTemporaryPaths();
    const outside = await createTemporaryDirectory();
    const target = join(outside, 'foreign.sqlite');
    await createForeignDatabase(target, CURRENT_INDEX_SCHEMA_VERSION);
    await mkdir(paths.index, { recursive: true });
    await symlink(target, paths.sessionIndex);
    const bytesBefore = await readFile(target);
    const entriesBefore = (await readdir(outside)).sort();

    // Act
    const error = await capturedError(
      async () => await new BunSqliteIndexFactory().open(paths, new StateFileSystem(paths)),
    );

    // Assert
    should(error instanceof Error).be.true();
    should(String(error)).containEql('symbolic links are not allowed');
    should((await readFile(target)).equals(bytesBefore)).be.true();
    should((await readdir(outside)).sort()).deepEqual(entriesBefore);
    should((await lstat(paths.sessionIndex)).isSymbolicLink()).be.true();
  });

  it.each(['-wal', '-shm'])('should refuse a symlinked %s sidecar without writing to its target', async suffix => {
    // Arrange
    const paths = await createTemporaryPaths();
    const outside = await createTemporaryDirectory();
    const target = join(outside, `foreign${suffix}`);
    await writeFile(target, 'must survive\n');
    await mkdir(paths.index, { recursive: true });
    await symlink(target, sidecarPath(paths, suffix));
    const bytesBefore = await readFile(target);
    const entriesBefore = (await readdir(outside)).sort();

    // Act
    const error = await capturedError(
      async () => await new BunSqliteIndexFactory().open(paths, new StateFileSystem(paths)),
    );

    // Assert
    should(error instanceof Error).be.true();
    should(String(error)).containEql('symbolic links are not allowed');
    should((await readFile(target)).equals(bytesBefore)).be.true();
    should((await readdir(outside)).sort()).deepEqual(entriesBefore);
    should(await exists(paths.sessionIndex)).be.false();
  });

  it('should refuse a symlink planted between dropping and reopening an obsolete index', async () => {
    // Arrange
    const paths = await createTemporaryPaths();
    const outside = await createTemporaryDirectory();
    const target = join(outside, 'foreign.sqlite');
    await createForeignDatabase(target, CURRENT_INDEX_SCHEMA_VERSION);
    await mkdir(paths.index, { recursive: true });
    await createForeignDatabase(paths.sessionIndex, 99);
    const bytesBefore = await readFile(target);
    const entriesBefore = (await readdir(outside)).sort();
    const fileSystem = new SymlinkPlantingStateFileSystem(paths, async () => await symlink(target, paths.sessionIndex));

    // Act
    const error = await capturedError(async () => await new BunSqliteIndexFactory().open(paths, fileSystem));

    // Assert
    should(error instanceof Error).be.true();
    should(String(error)).containEql('symbolic links are not allowed');
    should((await readFile(target)).equals(bytesBefore)).be.true();
    should((await readdir(outside)).sort()).deepEqual(entriesBefore);
    should((await lstat(paths.sessionIndex)).isSymbolicLink()).be.true();
  });

  it('should still open a fresh index when no index path is a symlink', async () => {
    // Arrange
    const paths = await createTemporaryPaths();
    await mkdir(paths.index, { recursive: true });

    // Act
    const index = await new BunSqliteIndexFactory().open(paths, new StateFileSystem(paths));
    const sessions = index.listSessions();
    index.close();

    // Assert
    should(sessions).deepEqual([]);
    should(await exists(paths.sessionIndex)).be.true();
    should((await lstat(paths.sessionIndex)).isSymbolicLink()).be.false();
  });
});
