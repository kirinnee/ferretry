/**
 * A WATCHED SESSION DOCUMENT THAT HAS NOT CHANGED COSTS NO SYSTEM CALL — AND ONE THAT HAS IS STILL SEEN.
 *
 * The identity cache answers an unchanged document with one `stat` per read. A document a background
 * reader asks for (`heard` freshness) more than once is now also watched, and while its watch is live and
 * has reported nothing since its identity was taken, even that `stat` is skipped. These pin the saving,
 * every case where the `stat` must stay (a read that must be proved, a watch that cannot vouch, a change
 * it reported), read-your-own-write against a read running alongside a write, and — on the real file-event
 * hub — an edit from outside the daemon seen within the hub's settle.
 */
import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  BunSqliteIndexFactory,
  type DaemonStorage,
  DaemonStorageFactory,
  type DocumentChanges,
  KeyedSerialExecutor,
  RuntimeEnvironment,
  SqliteHomeLockFactory,
  StateFileSystem,
  StateHomeLayout,
  SystemClock,
} from '../../src/adapters/index.ts';
import { unrefFileEventTimers } from '../../src/adapters/file-events/bun-file-event-source.ts';
import { platformFileEventSource } from '../../src/adapters/file-events/platform.ts';
import { FileEventHub } from '../../src/lib/file-events/hub.ts';
import { createSessionPaths, type FileSystemPort, type FoundationPaths, parseSessionId } from '../../src/lib/index.ts';

const homes: string[] = [];
const closers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

/** The real state filesystem, counting the identity `stat`s the watch exists to save. */
class CountingStateFileSystem extends StateFileSystem {
  identities: string[] = [];
  /** While set, an atomic write waits for it before it renames — so a test can read alongside it. */
  writing: { readonly entered: () => void; readonly gate: Promise<void> } | undefined;

  override async identity(path: string): Promise<string | undefined> {
    this.identities.push(path);
    return await super.identity(path);
  }

  override async writeTextAtomic(path: string, text: string): Promise<void> {
    const writing = this.writing;
    if (writing !== undefined) {
      writing.entered();
      await writing.gate;
    }
    await super.writeTextAtomic(path, text);
  }
}

/** A watch the test drives: each path's listeners, and whether the watch is live. */
const scriptedChanges = () => {
  const listeners = new Map<string, Array<() => void>>();
  let live = true;
  let closed = 0;
  const changes: DocumentChanges = {
    subscribe: (path, listener) => {
      listeners.set(path, [...(listeners.get(path) ?? []), listener]);
      return {
        live: () => live,
        close: () => {
          closed += 1;
        },
      };
    },
  };
  return {
    changes,
    watched: () => [...listeners.keys()],
    report: (path: string) => {
      for (const listener of listeners.get(path) ?? []) listener();
    },
    polled: () => {
      live = false;
    },
    closed: () => closed,
  };
};

const ID = parseSessionId('watched-1');

async function seeded(changes: DocumentChanges | undefined) {
  const home = await mkdtemp(join(tmpdir(), 'fy-document-watch-'));
  homes.push(home);
  let fileSystem: CountingStateFileSystem | undefined;
  const factory = new DaemonStorageFactory(
    new RuntimeEnvironment({ FY_HOME: home }, () => '/home-must-not-be-used'),
    {
      create: (paths: FoundationPaths): FileSystemPort => {
        fileSystem = new CountingStateFileSystem(paths);
        return fileSystem;
      },
    },
    new StateHomeLayout(),
    new SqliteHomeLockFactory(),
    new BunSqliteIndexFactory(),
    new SystemClock(),
    () => new KeyedSerialExecutor(),
    changes,
  );
  const opened = await factory.open();
  closers.push(async () => await opened.storage.close().catch(() => undefined));
  if (fileSystem === undefined) throw new Error('the storage built no filesystem');
  await opened.storage.writeConfig(ID, { id: 'watched-1', status: 'running', turn: 1 });
  await opened.storage.writeState(ID, { id: 'watched-1', status: 'running', turn: 1 });
  await opened.storage.append(ID, 'session.created', {});
  fileSystem.identities = [];
  const paths = createSessionPaths(opened.paths, ID);
  return { storage: opened.storage as DaemonStorage, fileSystem, paths };
}

const statsOf = (fileSystem: CountingStateFileSystem, path: string): number =>
  fileSystem.identities.filter(stat => stat === path).length;

describe('a watched session document', () => {
  it('should be answered with no stat while its watch is live and has heard nothing', async () => {
    // Arrange
    const watch = scriptedChanges();
    const { storage, fileSystem, paths } = await seeded(watch.changes);
    await storage.readConfig(ID, 'heard');
    await storage.readConfig(ID, 'heard');
    const proving = [statsOf(fileSystem, paths.marker), statsOf(fileSystem, paths.config)];
    fileSystem.identities = [];

    // Act
    for (let read = 0; read < 10; read += 1) await storage.readConfig(ID, 'heard');

    // Assert: the second read watched both and proved them with a stat; ten more cost nothing.
    should(watch.watched().sort()).deepEqual([paths.config, paths.marker].sort());
    should(proving).deepEqual([1, 1]);
    should(fileSystem.identities).deepEqual([]);
  });

  it('should still prove every read that does not ask for heard freshness, and see an unheard edit at once', async () => {
    // Arrange: the config is watched and quiet for the background readers.
    const watch = scriptedChanges();
    const { storage, fileSystem, paths } = await seeded(watch.changes);
    await storage.readConfig(ID, 'heard');
    await storage.readConfig(ID, 'heard');
    fileSystem.identities = [];

    // Act — a person edits the file, and a request reads it before the hub has said anything.
    await storage.readConfig(ID);
    await writeFile(paths.config, JSON.stringify({ id: 'watched-1', status: 'stopped', turn: 1 }));
    const requested = (await storage.readConfig(ID)) as Record<string, unknown>;

    // Assert
    should(statsOf(fileSystem, paths.config)).equal(2);
    should(requested.status).equal('stopped');
  });

  it('should open no watch for reads that must be proved', async () => {
    // Arrange
    const watch = scriptedChanges();
    const { storage } = await seeded(watch.changes);

    // Act
    for (let read = 0; read < 3; read += 1) {
      await storage.readConfig(ID);
      await storage.readState(ID);
    }

    // Assert
    should(watch.watched()).deepEqual([]);
  });

  it('should stat again once its watch reports a change, and read what changed', async () => {
    // Arrange
    const watch = scriptedChanges();
    const { storage, fileSystem, paths } = await seeded(watch.changes);
    await storage.readConfig(ID, 'heard');
    await storage.readConfig(ID, 'heard');

    // Act — another writer replaces the file, and the hub hears it.
    await writeFile(paths.config, JSON.stringify({ id: 'watched-1', status: 'stopped', turn: 1 }));
    watch.report(paths.config);
    fileSystem.identities = [];
    const changed = (await storage.readConfig(ID, 'heard')) as Record<string, unknown>;
    const again = (await storage.readConfig(ID, 'heard')) as Record<string, unknown>;

    // Assert: one stat proved the change, and the new file is trusted from then on.
    should(changed.status).equal('stopped');
    should(again.status).equal('stopped');
    should(statsOf(fileSystem, paths.config)).equal(1);
  });

  it('should keep the stat on every read while its watch cannot vouch for the directory', async () => {
    // Arrange: the hub falls back to polling the session directory.
    const watch = scriptedChanges();
    const { storage, fileSystem, paths } = await seeded(watch.changes);
    await storage.readConfig(ID, 'heard');
    await storage.readConfig(ID, 'heard');
    watch.polled();
    fileSystem.identities = [];

    // Act
    for (let read = 0; read < 3; read += 1) await storage.readConfig(ID, 'heard');
    await writeFile(paths.config, JSON.stringify({ id: 'watched-1', status: 'stopped', turn: 1 }));
    const edited = (await storage.readConfig(ID, 'heard')) as Record<string, unknown>;

    // Assert: a stat per read, and an unheard edit seen at once, as before the watch.
    should(statsOf(fileSystem, paths.config)).equal(4);
    should(edited.status).equal('stopped');
  });

  it('should stat on every read with no watch wired, as before', async () => {
    // Arrange
    const { storage, fileSystem, paths } = await seeded(undefined);

    // Act
    for (let read = 0; read < 4; read += 1) await storage.readConfig(ID, 'heard');

    // Assert: the seeding's own sync already cached the config, so every read is one stat.
    should(statsOf(fileSystem, paths.config)).equal(4);
  });

  it('should see its own write at once, even when a read alongside cached the old file', async () => {
    // Arrange: the config is watched and quiet.
    const watch = scriptedChanges();
    const { storage, fileSystem } = await seeded(watch.changes);
    await storage.readConfig(ID, 'heard');
    await storage.readConfig(ID, 'heard');
    let entered: () => void = () => undefined;
    const blocked = new Promise<void>(resolve => {
      entered = resolve;
    });
    let release: () => void = () => undefined;
    fileSystem.writing = { entered, gate: new Promise<void>(resolve => (release = resolve)) };

    // Act — a write stops just before its rename; a read runs meanwhile and caches the old file; the
    // rename lands, and the hub has not heard it yet.
    const write = storage.writeConfig(ID, { id: 'watched-1', status: 'running', turn: 2 });
    await blocked;
    const during = (await storage.readConfig(ID, 'heard')) as Record<string, unknown>;
    fileSystem.writing = undefined;
    release();
    await write;
    const after = (await storage.readConfig(ID, 'heard')) as Record<string, unknown>;

    // Assert
    should(during.turn).equal(1);
    should(after.turn).equal(2);
  });

  it('should close every watch when the storage closes', async () => {
    // Arrange
    const watch = scriptedChanges();
    const { storage } = await seeded(watch.changes);
    await storage.readConfig(ID, 'heard');
    await storage.readConfig(ID, 'heard');

    // Act
    await storage.close();

    // Assert: the marker's and the config's.
    should(watch.closed()).equal(2);
  });

  it('should see an edit from outside the daemon within the real hub’s settle, after reads that cost nothing', async () => {
    // Arrange — the real file-event hub, on this platform's watcher.
    const hub = new FileEventHub(platformFileEventSource(), unrefFileEventTimers);
    closers.push(() => hub.close());
    const { storage, fileSystem, paths } = await seeded({
      subscribe: (path, listener) => hub.subscribe(path, () => listener()),
    });
    await storage.readConfig(ID, 'heard');
    await storage.readConfig(ID, 'heard');
    // The hub's first check reports a new subscription once; let it, so the quiet reads below are quiet.
    await writeFile(join(paths.directory, 'nudge'), 'x');
    await Bun.sleep(200);
    await storage.readConfig(ID, 'heard');
    fileSystem.identities = [];
    for (let read = 0; read < 5; read += 1) await storage.readConfig(ID, 'heard');
    const quiet = statsOf(fileSystem, paths.config);

    // Act — an editor saves the file atomically, as most do.
    const temporary = join(paths.directory, 'config.json.edit');
    await writeFile(temporary, JSON.stringify({ id: 'watched-1', status: 'stopped', turn: 1 }));
    await rename(temporary, paths.config);
    const started = Date.now();
    let seen: unknown;
    while (Date.now() - started < 2_000) {
      seen = ((await storage.readConfig(ID, 'heard')) as Record<string, unknown>).status;
      if (seen === 'stopped') break;
      await Bun.sleep(5);
    }

    // Assert
    should(quiet).equal(0);
    should(seen).equal('stopped');
  });
});
