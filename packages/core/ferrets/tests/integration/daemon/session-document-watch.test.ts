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
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { unrefFileEventTimers } from '../../src/adapters/file-events/bun-file-event-source.ts';
import { platformFileEventSource } from '../../src/adapters/file-events/platform.ts';
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
import { StorageCredentialedSessions } from '../../src/adapters/agent-tools/storage-credentialed-sessions.ts';
import { secretsMatch } from '../../src/lib/api/authentication.ts';
import { CredentialAgentIdentities, CredentialDigestLocations } from '../../src/lib/agent-tools/policy.ts';
import { FileEventHub } from '../../src/lib/file-events/hub.ts';
import { createSessionPaths, type FileSystemPort, type FoundationPaths, parseSessionId } from '../../src/lib/index.ts';
import { waitFor, waitForValue } from './support/wait-for.ts';

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
  /** While set, an atomic write renames and THEN throws — the chmod or directory fsync failing after the swap. */
  failAfterRename = false;
  /** While set, a read of `path` waits for the gate AFTER it has read the file — holding what it found. */
  holding: { readonly path: string; readonly entered: () => void; readonly gate: Promise<void> } | undefined;

  override async identity(path: string): Promise<string | undefined> {
    this.identities.push(path);
    return await super.identity(path);
  }

  override async readTextIdentified(path: string) {
    const read = await super.readTextIdentified(path);
    const holding = this.holding;
    if (holding !== undefined && holding.path === path) {
      this.holding = undefined;
      holding.entered();
      await holding.gate;
    }
    return read;
  }

  override async writeTextAtomic(path: string, text: string): Promise<void> {
    const writing = this.writing;
    if (writing !== undefined) {
      writing.entered();
      await writing.gate;
    }
    await super.writeTextAtomic(path, text);
    if (this.failAfterRename) throw new Error('fsync failed after the rename');
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

/** Sessions written straight into the home, beside `watched-1`, ready to be read. */
async function otherSessions(home: FoundationPaths, count: number) {
  const ids = Array.from({ length: count }, (_, index) => parseSessionId(`other-${String(index).padStart(5, '0')}`));
  for (const id of ids) {
    const session = createSessionPaths(home, id);
    await mkdir(session.directory, { recursive: true, mode: 0o700 });
    await writeFile(session.marker, '2\n', { mode: 0o600 });
    await writeFile(session.config, JSON.stringify({ id }), { mode: 0o600 });
  }
  return ids;
}

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
  return { storage: opened.storage as DaemonStorage, fileSystem, paths, home: opened.paths };
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

  it('should count every config it writes, and nothing else, for a reader that derives from every config', async () => {
    // Arrange
    const { storage } = await seeded(scriptedChanges().changes);
    const seededWrites = storage.configWrites();

    // Act
    await storage.writeConfig(ID, { id: 'watched-1', status: 'running', turn: 2 });
    await storage.updateConfig(ID, current => ({ ...(current as Record<string, unknown>), turn: 3 }));
    await storage.writeState(ID, { id: 'watched-1', status: 'running', turn: 3 });
    await storage.updateState(ID, current => ({ ...(current as Record<string, unknown>), turn: 4 }));

    // Assert — the seed's one config write, then one per config write; a state write is not a config.
    should(seededWrites).equal(1);
    should(storage.configWrites()).equal(3);
  });

  it('should count a config write that renamed and then threw, so a remembered credential location is discarded', async () => {
    // Arrange — 'later' holds h2 and is warmed as its holder; 'earlier' holds another credential.
    const { storage, fileSystem } = await seeded(scriptedChanges().changes);
    const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
    const earlier = parseSessionId('earlier');
    const later = parseSessionId('later');
    const config = (id: string, capability: string) => ({
      id,
      incarnation: `${id}-1`,
      runtimeGeneration: 1,
      name: id,
      agent: 'claude-auto',
      harness: 'claude',
      modelHint: 'opus',
      mode: 'interactive',
      remoteControl: false,
      harnessFlags: [],
      cwd: '/work/ferretry',
      createdAt: '2026-07-31T09:00:00.000Z',
      updatedAt: '2026-07-31T09:00:00.000Z',
      turn: 1,
      intervalSeconds: 30,
      timeoutSeconds: 0,
      nudgeAfterSeconds: 0,
      killAfterSeconds: 0,
      directSendMaxChars: 4_096,
      resumeMenuChoice: 'full',
      maxSnapshots: 10,
      retry: { transientAttempts: 0, stalledAttempts: 0, waitForQuotaReset: false, allowAccountFailover: false },
      command: ['/usr/bin/claude-auto'],
      tmuxSession: `fy-${id}`,
      sessionCapabilityHash: digest(capability),
    });
    for (const [id, capability] of [
      [earlier, 'h1'],
      [later, 'h2'],
    ] as const) {
      await storage.writeConfig(id, config(id, capability));
      await storage.writeState(id, { id, status: 'running', turn: 1 });
    }
    const source = new StorageCredentialedSessions({
      sessionIds: () => storage.listSessions().map(session => session.id),
      readConfig: async id => await storage.readConfig(parseSessionId(id)),
      readState: async id => await storage.readState(parseSessionId(id)),
    });
    const resolver = (stamp: () => string) =>
      new CredentialAgentIdentities(source, digest, secretsMatch, new CredentialDigestLocations(), stamp);
    const warmed = resolver(() => String(storage.configWrites()));
    should((await warmed.resolve('h2'))?.sessionId).equal('later');
    const before = storage.configWrites();

    // Act — 'earlier' is rewritten to h2, but the write throws after its rename already replaced the document.
    fileSystem.failAfterRename = true;
    const failure = await storage.writeConfig(earlier, config('earlier', 'h2')).then(
      () => undefined,
      (error: Error) => error,
    );
    fileSystem.failAfterRename = false;
    should(failure?.message).equal('fsync failed after the rename');

    // Assert — the failed write moved the stamp, so the warmed resolver agrees with a fresh scan.
    should(storage.configWrites()).be.above(before);
    const fresh = await resolver(() => '').resolve('h2');
    should(fresh?.sessionId).equal('earlier');
    should(await warmed.resolve('h2')).deepEqual(fresh);
  });

  it('should count an updateConfig whose write renamed and then threw', async () => {
    // Arrange
    const { storage, fileSystem } = await seeded(scriptedChanges().changes);
    const before = storage.configWrites();

    // Act
    fileSystem.failAfterRename = true;
    const failure = await storage
      .updateConfig(ID, current => ({ ...(current as Record<string, unknown>), turn: 9 }))
      .then(
        () => undefined,
        (error: Error) => error,
      );
    fileSystem.failAfterRename = false;

    // Assert — the document changed under the failed call, and the stamp says so.
    should(failure?.message).equal('fsync failed after the rename');
    should(storage.configWrites()).equal(before + 1);
    should((await storage.readConfig(ID)) as Record<string, unknown>).have.property('turn', 9);
  });

  it('should move the config count only once a new session is listed, so a scan that raced the write is never trusted', async () => {
    // Arrange
    const { storage } = await seeded(scriptedChanges().changes);
    const added = parseSessionId('watched-2');
    const before = storage.configWrites();
    const observed: Array<{ readonly moved: boolean; readonly listed: boolean }> = [];

    // Act — sample the count and the roster between every step of the write.
    let settled = false;
    const writing = storage.writeConfig(added, { id: 'watched-2', status: 'running', turn: 1 }).finally(() => {
      settled = true;
    });
    while (!settled) {
      observed.push({
        moved: storage.configWrites() > before,
        listed: storage.listSessions().some(session => session.id === added),
      });
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    await writing;

    // Assert — whenever the count had moved, the member was already published to the roster.
    should(observed.some(sample => !sample.moved && !sample.listed)).be.true();
    should(observed.filter(sample => sample.moved && !sample.listed)).deepEqual([]);
    should(storage.configWrites()).equal(before + 1);
    should(storage.listSessions().some(session => session.id === added)).be.true();
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

  it('should not let a reopened watch vouch for a copy read through an older one, however many changes that one heard', async () => {
    // Arrange — the config is watched and quiet. Its watch then hears more changes than any count range
    // given to a watch could hold, so a scheme of ranges would run into the range of the next watch.
    const watch = scriptedChanges();
    const { storage, fileSystem, paths, home } = await seeded(watch.changes);
    await storage.readConfig(ID, 'heard');
    await storage.readConfig(ID, 'heard');
    for (let change = 0; change < 2 ** 24; change += 1) watch.report(paths.config);
    const edit = async (turn: number): Promise<void> => {
      const staged = `${paths.config}.staged-${String(turn)}`;
      await writeFile(staged, JSON.stringify({ id: 'watched-1', status: 'running', turn }));
      await rename(staged, paths.config);
    };

    // Act — a person saves version 2, and a read finds it but is held before it caches it. Meanwhile
    // other sessions fill the cache, so the oldest documents — this config, and its watch — are evicted,
    // and version 3 lands while nothing is listening.
    await edit(2);
    let entered: () => void = () => undefined;
    const holding = new Promise<void>(resolve => {
      entered = resolve;
    });
    let release: () => void = () => undefined;
    fileSystem.holding = { path: paths.config, entered, gate: new Promise<void>(resolve => (release = resolve)) };
    const held = storage.readConfig(ID, 'heard');
    await holding;
    for (const other of await otherSessions(home, 2_100)) await storage.readConfig(other);
    await edit(3);
    release();
    const found = (await held) as Record<string, unknown>;
    const reopened = (await storage.readConfig(ID, 'heard')) as Record<string, unknown>;

    // Assert — the held read really saw version 2, the eviction really closed the watch it read through,
    // and the reopened watch had heard nothing of version 3 and so could not vouch for version 2.
    should(found.turn).equal(2);
    should(watch.closed()).be.above(0);
    should(reopened.turn).equal(3);
  }, 60_000);

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
    let heard = 0;
    const { storage, fileSystem, paths } = await seeded({
      subscribe: (path, listener) =>
        hub.subscribe(path, () => {
          heard += 1;
          listener();
        }),
    });
    await storage.readConfig(ID, 'heard');
    await storage.readConfig(ID, 'heard');
    // The hub's first check reports a new subscription once; let it, so the quiet reads below are quiet.
    await writeFile(join(paths.directory, 'nudge'), 'x');
    await waitFor(() => heard > 0, 'the hub to report the new subscription');
    await storage.readConfig(ID, 'heard');
    fileSystem.identities = [];
    for (let read = 0; read < 5; read += 1) await storage.readConfig(ID, 'heard');
    const quiet = statsOf(fileSystem, paths.config);

    // Act — an editor saves the file atomically, as most do.
    const temporary = join(paths.directory, 'config.json.edit');
    await writeFile(temporary, JSON.stringify({ id: 'watched-1', status: 'stopped', turn: 1 }));
    await rename(temporary, paths.config);
    const seen = await waitForValue(async () => {
      const status = ((await storage.readConfig(ID, 'heard')) as Record<string, unknown>).status;
      return status === 'stopped' ? status : undefined;
    }, 'the hub to report the edit made from outside');

    // Assert
    should(quiet).equal(0);
    should(seen).equal('stopped');
  });
});
