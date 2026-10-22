/**
 * A SESSION DOCUMENT THAT HAS NOT CHANGED IS NOT READ AGAIN — AND ONE THAT HAS, ALWAYS IS.
 *
 * Every watcher reads every session's documents every few seconds. Each read used to walk the state
 * home, open the marker and the document, and parse the JSON; the storage now answers an unchanged
 * document from the identity of the file it last proved and read. These pin both halves: the reads it
 * saves, and every way a document can change that must still be seen.
 */
import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  BunSqliteIndexFactory,
  type DaemonStorage,
  DaemonStorageFactory,
  InvalidStateDocumentError,
  KeyedSerialExecutor,
  RuntimeEnvironment,
  SqliteHomeLockFactory,
  StateFileSystem,
  StateHomeLayout,
  SystemClock,
} from '../../src/adapters/index.ts';
import {
  createSessionPaths,
  type FileSystemPort,
  type FoundationPaths,
  type IdentifiedText,
  parseSessionId,
} from '../../src/lib/index.ts';

const homes: string[] = [];
const stores: DaemonStorage[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close().catch(() => undefined);
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

/** The real state filesystem, counting the reads a cache exists to save. */
class CountingStateFileSystem extends StateFileSystem {
  identifiedReads: string[] = [];
  plainReads: string[] = [];

  override async readTextIdentified(path: string): Promise<IdentifiedText | undefined> {
    this.identifiedReads.push(path);
    return await super.readTextIdentified(path);
  }

  override async readText(path: string): Promise<string | undefined> {
    this.plainReads.push(path);
    return await super.readText(path);
  }
}

/** A filesystem without the optional identity methods — every fake in the suite looks like this. */
class PlainStateFileSystem extends CountingStateFileSystem {
  constructor(paths: FoundationPaths) {
    super(paths);
    Object.defineProperty(this, 'identity', { value: undefined });
    Object.defineProperty(this, 'readTextIdentified', { value: undefined });
  }
}

async function openStorage(make: (paths: FoundationPaths) => CountingStateFileSystem) {
  const home = await mkdtemp(join(tmpdir(), 'fy-document-cache-'));
  homes.push(home);
  let fileSystem: CountingStateFileSystem | undefined;
  const factory = new DaemonStorageFactory(
    new RuntimeEnvironment({ FY_HOME: home }, () => '/home-must-not-be-used'),
    {
      create: (paths: FoundationPaths): FileSystemPort => {
        fileSystem = make(paths);
        return fileSystem;
      },
    },
    new StateHomeLayout(),
    new SqliteHomeLockFactory(),
    new BunSqliteIndexFactory(),
    new SystemClock(),
    () => new KeyedSerialExecutor(),
  );
  const opened = await factory.open();
  stores.push(opened.storage);
  if (fileSystem === undefined) throw new Error('the storage built no filesystem');
  return { storage: opened.storage, paths: opened.paths, fileSystem };
}

const ID = parseSessionId('cached-1');

async function seeded(
  make: (paths: FoundationPaths) => CountingStateFileSystem = paths => new CountingStateFileSystem(paths),
) {
  const opened = await openStorage(make);
  await opened.storage.writeState(ID, { id: 'cached-1', status: 'running', turn: 1 });
  await opened.storage.append(ID, 'session.created', {});
  opened.fileSystem.identifiedReads = [];
  opened.fileSystem.plainReads = [];
  return opened;
}

/** A seeded storage whose state carries a nested array, so freezing is checked all the way down. */
async function seededNested() {
  const opened = await openStorage(paths => new CountingStateFileSystem(paths));
  await opened.storage.writeState(ID, { id: 'cached-1', status: 'running', turn: 1, openTools: ['bash'] });
  await opened.storage.append(ID, 'session.created', {});
  return opened;
}

describe('the session document cache', () => {
  it('should answer an unchanged document from the cache, reading it once', async () => {
    // Arrange
    const { storage, paths, fileSystem } = await seeded();
    const state = createSessionPaths(paths, ID).state;

    // Act
    const first = await storage.readState(ID);
    const second = await storage.readState(ID);
    const third = await storage.readState(ID);

    // Assert
    should(second).deepEqual(first);
    should(third).deepEqual(first);
    should(fileSystem.identifiedReads.filter(path => path === state).length).be.belowOrEqual(1);
  });

  it('should hand out ONE frozen document, so no caller can change what the next one reads', async () => {
    // Arrange
    const { storage } = await seededNested();
    const first = (await storage.readState(ID)) as Record<string, unknown>;

    // Act — this module is strict, so a write to a frozen object throws rather than failing silently.
    const tamper = () => {
      first.status = 'tampered';
    };
    const tamperNested = () => {
      (first.openTools as unknown[]).push('tampered');
    };
    const second = (await storage.readState(ID)) as Record<string, unknown>;

    // Assert — the same instance every time, frozen all the way down: nothing is cloned per read.
    should(tamper).throw(TypeError);
    should(tamperNested).throw(TypeError);
    should(second).equal(first);
    should(Object.isFrozen(first.openTools)).be.true();
    should(second.status).equal('running');
  });

  it('should hand out a new instance after a write, and leave the one already handed out as it was', async () => {
    // Arrange
    const { storage } = await seededNested();
    const before = (await storage.readState(ID)) as Record<string, unknown>;

    // Act
    await storage.updateState(ID, raw => ({ ...(raw as Record<string, unknown>), status: 'stopped' }));
    const after = (await storage.readState(ID)) as Record<string, unknown>;

    // Assert
    should(after).not.equal(before);
    should(after.status).equal('stopped');
    should(before.status).equal('running');
    should(Object.isFrozen(after)).be.true();
  });

  it('should freeze what it reads on a filesystem without identities too, so a mutation fails the same way', async () => {
    // Arrange
    const { storage } = await seeded(paths => new PlainStateFileSystem(paths));
    const read = (await storage.readState(ID)) as Record<string, unknown>;

    // Act + Assert
    should(() => {
      read.status = 'tampered';
    }).throw(TypeError);
  });

  it('should see its own writes at once', async () => {
    // Arrange
    const { storage } = await seeded();
    await storage.readState(ID);

    // Act
    await storage.updateState(ID, current => ({ ...(current as Record<string, unknown>), turn: 2 }));
    await storage.writeConfig(ID, { id: 'cached-1', name: 'Written' });

    // Assert
    should(((await storage.readState(ID)) as Record<string, unknown>).turn).equal(2);
    should(((await storage.readConfig(ID)) as Record<string, unknown>).name).equal('Written');
  });

  it('should see its own upserts at once, and hand the next one what the last one wrote', async () => {
    // Arrange: both documents are in the cache before the locked writes replace them.
    const { storage } = await seeded();
    await storage.upsertConfig(ID, () => ({ id: 'cached-1', name: 'Created' }));
    await storage.readState(ID);
    await storage.readConfig(ID);
    const handed: unknown[] = [];

    // Act
    await storage.upsertState(ID, current => {
      handed.push(current);
      return { ...(current as Record<string, unknown>), turn: 2 };
    });
    await storage.upsertState(ID, current => {
      handed.push(current);
      return { ...(current as Record<string, unknown>), turnState: 'working' };
    });
    await storage.upsertConfig(ID, current => ({ ...(current as Record<string, unknown>), name: 'Renamed' }));

    // Assert: no upsert merged over the copy the cache held before it.
    should(handed).deepEqual([
      { id: 'cached-1', status: 'running', turn: 1 },
      { id: 'cached-1', status: 'running', turn: 2 },
    ]);
    should(await storage.readState(ID)).deepEqual({ id: 'cached-1', status: 'running', turn: 2, turnState: 'working' });
    should(await storage.readConfig(ID)).deepEqual({ id: 'cached-1', name: 'Renamed' });
  });

  it('should see another writer replace the file, and edit it in place at the same size', async () => {
    // Arrange
    const { storage, paths } = await seeded();
    const state = createSessionPaths(paths, ID).state;
    await storage.readState(ID);

    // Act — a replacement, then an in-place edit that keeps the size and only moves the times.
    await writeFile(state, JSON.stringify({ id: 'cached-1', status: 'stopped', turn: 1 }));
    const replaced = (await storage.readState(ID)) as Record<string, unknown>;
    await Bun.sleep(5);
    await writeFile(state, JSON.stringify({ id: 'cached-1', status: 'stopper', turn: 1 }));
    const edited = (await storage.readState(ID)) as Record<string, unknown>;

    // Assert
    should(replaced.status).equal('stopped');
    should(edited.status).equal('stopper');
  });

  it('should refuse a damaged document every time it is read, never cache the refusal away', async () => {
    // Arrange
    const { storage, paths } = await seeded();
    await writeFile(createSessionPaths(paths, ID).state, '{ not json');

    // Act / Assert
    for (let attempt = 0; attempt < 2; attempt += 1)
      should(await storage.readState(ID).catch((error: unknown) => error)).be.instanceof(InvalidStateDocumentError);
  });

  it('should forget a document that is gone, and answer that it is', async () => {
    // Arrange
    const { storage, paths } = await seeded();
    await storage.readConfig(ID);
    await writeFile(createSessionPaths(paths, ID).config, JSON.stringify({ id: 'cached-1' }));
    await storage.readConfig(ID);

    // Act
    await rm(createSessionPaths(paths, ID).config);

    // Assert
    should(await storage.readConfig(ID)).be.undefined();
  });

  it('should read in full every time on a filesystem without identities, as before', async () => {
    // Arrange
    const { storage, paths, fileSystem } = await seeded(paths => new PlainStateFileSystem(paths));
    const state = createSessionPaths(paths, ID).state;

    // Act
    await storage.readState(ID);
    await storage.readState(ID);
    const surveyed = await storage.surveySessionDirectories();

    // Assert
    should(fileSystem.plainReads.filter(path => path === state)).have.length(2);
    should(fileSystem.identifiedReads).deepEqual([]);
    should(surveyed.map(session => session.id)).deepEqual([ID]);
  });
});

describe('StateFileSystem identities', () => {
  it('should name the file a read came from, change when the file does, and be absent for nothing', async () => {
    // Arrange
    const { paths, fileSystem } = await seeded();
    const state = createSessionPaths(paths, ID).state;

    // Act
    const read = await fileSystem.readTextIdentified(state);
    const same = await fileSystem.identity(state);
    await writeFile(state, '{}');
    const changed = await fileSystem.identity(state);

    // Assert
    should(read?.identity).equal(same);
    should(changed).not.equal(same);
    should(await fileSystem.identity(join(paths.sessions, 'nobody', 'state.json'))).be.undefined();
    should(await fileSystem.readTextIdentified(join(paths.sessions, 'nobody', 'state.json'))).be.undefined();
  });
});
