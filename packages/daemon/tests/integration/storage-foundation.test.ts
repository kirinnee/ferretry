import { Database } from 'bun:sqlite';
import { afterEach, describe, it } from 'bun:test';
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  BunSqliteIndexFactory,
  DaemonStorage,
  DaemonStorageFactory,
  DurableEventIndexError,
  InvalidStateDocumentError,
  KeyedSerialExecutor,
  MissingSessionJournalError,
  type OpenedDaemonStorage,
  RuntimeEnvironment,
  SessionLayoutError,
  SqliteHomeLockFactory,
  StateFileSystem,
  StateFileSystemFactory,
  StateHomeLayout,
  StateHomeLockedError,
  SystemClock,
} from '../../src/adapters/index.ts';
import {
  createSessionPaths,
  encodeSessionEvent,
  indexFiles,
  type JsonValue,
  jsonObject,
  parseSessionId,
  requiredLayoutDirectories,
  type SessionIndex,
  StateHomeLayoutError,
} from '../../src/lib/index.ts';

const homes = new Set<string>();
const stores = new Set<DaemonStorage>();

class MarkerFailingStateFileSystem extends StateFileSystem {
  override async writeTextAtomic(path: string, text: string): Promise<void> {
    if (path.endsWith('/layout-version')) throw new Error('injected marker write failure');
    await super.writeTextAtomic(path, text);
  }
}

async function createTemporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-daemon-test-'));
  homes.add(home);
  return home;
}

function clockStartingAt(instant = '2026-07-30T12:00:00.000Z'): SystemClock {
  const start = Date.parse(instant);
  let tick = 0;
  return new SystemClock(() => new Date(start + tick++ * 1_000));
}

async function openStorage(home: string, clock = clockStartingAt()): Promise<OpenedDaemonStorage> {
  const factory = new DaemonStorageFactory(
    new RuntimeEnvironment({ FY_HOME: home }, () => '/home-must-not-be-used'),
    new StateFileSystemFactory(),
    new StateHomeLayout(),
    new SqliteHomeLockFactory(),
    new BunSqliteIndexFactory(),
    clock,
    () => new KeyedSerialExecutor(),
  );
  const opened = await factory.open();
  stores.add(opened.storage);
  return opened;
}

async function closeStorage(storage: DaemonStorage): Promise<void> {
  await storage.close();
  stores.delete(storage);
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

function counter(value: JsonValue): number {
  const result = jsonObject(value)?.count;
  if (typeof result !== 'number') throw new TypeError('test state has no numeric count');
  return result;
}

afterEach(async () => {
  for (const storage of stores) await storage.close().catch(() => undefined);
  stores.clear();
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

describe('state-home lifecycle', () => {
  it('should refuse a symbolic link used as the state-home root', async () => {
    // Arrange
    const parent = await createTemporaryHome();
    const target = await createTemporaryHome();
    const home = join(parent, 'linked-home');
    await symlink(target, home, 'dir');

    // Act
    const error = await capturedError(async () => await openStorage(home));

    // Assert
    should(error instanceof Error).be.true();
    should(String(error)).containEql('symbolic links are not allowed');
    should(await readdir(target)).deepEqual([]);
  });

  it('should initialize a fresh layout and reopen it idempotently', async () => {
    // Arrange
    const home = await createTemporaryHome();

    // Act
    const first = await openStorage(home);
    const firstEntries = (await readdir(home)).sort();
    await closeStorage(first.storage);
    const second = await openStorage(home);

    // Assert
    should(first.layout.created).be.true();
    should(firstEntries).deepEqual(['config', 'daemon.lock', 'fleet', 'layout-version', 'state']);
    should(await readFile(second.paths.layoutVersion, 'utf8')).equal('1\n');
    should(second.layout.created).be.false();
  });

  it('should recover an empty bootstrap scaffold after the layout marker write fails', async () => {
    // Arrange
    const home = await createTemporaryHome();
    const failingFactory = new DaemonStorageFactory(
      new RuntimeEnvironment({ FY_HOME: home }, () => '/home-must-not-be-used'),
      { create: paths => new MarkerFailingStateFileSystem(paths) },
      new StateHomeLayout(),
      new SqliteHomeLockFactory(),
      new BunSqliteIndexFactory(),
      clockStartingAt(),
      () => new KeyedSerialExecutor(),
    );

    // Act
    const failure = await capturedError(async () => await failingFactory.open());
    const recovered = await openStorage(home);

    // Assert
    should(String(failure)).containEql('injected marker write failure');
    should(recovered.layout.created).be.true();
    should(await readFile(recovered.paths.layoutVersion, 'utf8')).equal('1\n');
  });

  it.each(['0', '2', 'invalid'])('should refuse layout version %s before mutating the home', async marker => {
    // Arrange
    const home = await createTemporaryHome();
    const markerPath = join(home, 'layout-version');
    await writeFile(markerPath, `${marker}\n`, { mode: 0o640 });
    const before = await readdir(home);

    // Act
    const error = await capturedError(async () => await openStorage(home));

    // Assert
    should(error instanceof StateHomeLayoutError).be.true();
    should(await readdir(home)).deepEqual(before);
    should((await stat(markerPath)).mode & 0o777).equal(0o640);
    should(await exists(join(home, 'state'))).be.false();
    should(await exists(join(home, 'daemon.lock'))).be.false();
  });

  it('should repair layout permissions and keep files private', async () => {
    // Arrange
    const home = await createTemporaryHome();
    await chmod(home, 0o755);
    const opened = await openStorage(home);
    const id = parseSessionId('permission-session');
    await opened.storage.writeConfig(id, { name: 'private' });
    await opened.storage.writeState(id, { status: 'running' });
    await opened.storage.append(id, 'session.started', { token: 'private' });
    const session = createSessionPaths(opened.paths, id);

    // Act
    const directoryModes = await Promise.all(
      [...requiredLayoutDirectories(opened.paths), session.directory].map(
        async path => (await stat(path)).mode & 0o777,
      ),
    );
    const privateFiles = [
      opened.paths.layoutVersion,
      opened.paths.daemonLock,
      opened.paths.sessionIndex,
      session.marker,
      session.config,
      session.state,
      session.events,
    ];
    const fileModes = await Promise.all(privateFiles.map(async path => (await stat(path)).mode & 0o777));
    const sidecarModes = await Promise.all(
      indexFiles(opened.paths)
        .slice(1)
        .map(async path => (await stat(path)).mode & 0o777),
    );

    // Assert
    should(directoryModes).deepEqual(directoryModes.map(() => 0o700));
    should(fileModes).deepEqual(fileModes.map(() => 0o600));
    should(sidecarModes).deepEqual(sidecarModes.map(() => 0o600));
  });

  it('should repair permissive session modes when reopening', async () => {
    // Arrange
    const home = await createTemporaryHome();
    const first = await openStorage(home);
    const id = parseSessionId('repaired-session');
    await first.storage.writeConfig(id, { private: true });
    await first.storage.writeState(id, { status: 'private' });
    await first.storage.append(id, 'private', {});
    const paths = createSessionPaths(first.paths, id);
    await closeStorage(first.storage);
    await chmod(paths.directory, 0o755);
    for (const file of [paths.marker, paths.config, paths.state, paths.events]) await chmod(file, 0o644);

    // Act
    await openStorage(home);
    const directoryMode = (await stat(paths.directory)).mode & 0o777;
    const fileModes = await Promise.all(
      [paths.marker, paths.config, paths.state, paths.events].map(async file => (await stat(file)).mode & 0o777),
    );

    // Assert
    should(directoryMode).equal(0o700);
    should(fileModes).deepEqual([0o600, 0o600, 0o600, 0o600]);
  });

  it('should sweep stale atomic-write files when reopening', async () => {
    // Arrange
    const home = await createTemporaryHome();
    const first = await openStorage(home);
    const stale = join(first.paths.temporary, 'state.json.stale.tmp');
    await closeStorage(first.storage);
    await writeFile(stale, 'stale');

    // Act
    const second = await openStorage(home);

    // Assert
    should(await exists(stale)).be.false();
    should(second.layout.created).be.false();
  });

  it('should reject a second writer while leaving the first store usable', async () => {
    // Arrange
    const home = await createTemporaryHome();
    const first = await openStorage(home);
    const id = parseSessionId('locked-session');

    // Act
    const error = await capturedError(async () => await openStorage(home));
    await first.storage.writeState(id, { status: 'still-running' });

    // Assert
    should(error instanceof StateHomeLockedError).be.true();
    should(await first.storage.readState(id)).deepEqual({ status: 'still-running' });
  });
});

describe('session documents', () => {
  it('should atomically replace documents and serialize concurrent updates', async () => {
    // Arrange
    const home = await createTemporaryHome();
    const opened = await openStorage(home);
    const id = parseSessionId('update-session');
    await opened.storage.writeConfig(id, { generation: 1 });
    await opened.storage.writeConfig(id, { generation: 2 });
    await opened.storage.writeState(id, { count: 0 });

    // Act
    await opened.storage.updateConfig(id, current => ({
      generation: Number(jsonObject(current)?.generation ?? 0) + 1,
    }));
    await Promise.all(
      Array.from(
        { length: 25 },
        async () =>
          await opened.storage.updateState(id, async current => {
            await Promise.resolve();
            return { count: counter(current) + 1 };
          }),
      ),
    );
    const paths = createSessionPaths(opened.paths, id);

    // Assert
    should(await opened.storage.readConfig(id)).deepEqual({ generation: 3 });
    should(counter((await opened.storage.readState(id)) ?? null)).equal(25);
    should(await readFile(paths.config, 'utf8')).equal('{\n  "generation": 3\n}\n');
    should(await readdir(opened.paths.temporary)).deepEqual([]);
  });

  it('should report malformed documents with their file boundary', async () => {
    // Arrange
    const home = await createTemporaryHome();
    const opened = await openStorage(home);
    const id = parseSessionId('invalid-document');
    await opened.storage.writeState(id, { valid: true });
    const paths = createSessionPaths(opened.paths, id);
    await writeFile(paths.state, '{broken');

    // Act
    const error = await capturedError(async () => await opened.storage.readState(id));
    const sync = await opened.storage.syncSession(id);

    // Assert
    should(error instanceof InvalidStateDocumentError).be.true();
    should(sync.problems).have.length(1);
    should(sync.problems[0]?.file).equal(paths.state);
    should(sync.problems[0]?.message).equal('invalid JSON');
  });

  it('should refuse to adopt a non-empty session directory without a marker', async () => {
    // Arrange
    const home = await createTemporaryHome();
    const opened = await openStorage(home);
    const id = parseSessionId('unmarked-session');
    const paths = createSessionPaths(opened.paths, id);
    await mkdir(paths.directory, { recursive: true });
    await writeFile(paths.state, '{"foreign":true}\n');

    // Act
    const error = await capturedError(async () => await opened.storage.writeState(id, { claimed: true }));

    // Assert
    should(error instanceof SessionLayoutError).be.true();
    should(await readFile(paths.state, 'utf8')).equal('{"foreign":true}\n');
    should(await exists(paths.marker)).be.false();
  });

  it('should refuse direct reads when a non-empty session loses its marker', async () => {
    // Arrange
    const home = await createTemporaryHome();
    const opened = await openStorage(home);
    const id = parseSessionId('lost-marker');
    await opened.storage.writeState(id, { status: 'preserved' });
    await opened.storage.append(id, 'preserved', {});
    const paths = createSessionPaths(opened.paths, id);
    const indexedBefore = opened.storage.findSession(id);
    await rm(paths.marker);

    // Act
    const readError = await capturedError(async () => await opened.storage.readState(id));
    const syncError = await capturedError(async () => await opened.storage.syncSession(id));
    const replayError = await capturedError(async () => await opened.storage.replay(id));

    // Assert
    should(readError instanceof SessionLayoutError).be.true();
    should(syncError instanceof SessionLayoutError).be.true();
    should(replayError instanceof SessionLayoutError).be.true();
    should(opened.storage.findSession(id)).deepEqual(indexedBefore);
    should(await readFile(paths.state, 'utf8')).containEql('preserved');
  });

  it('should enumerate only marked session directories and restore a forgotten index row', async () => {
    // Arrange
    const home = await createTemporaryHome();
    const opened = await openStorage(home);
    const id = parseSessionId('discoverable-session');
    await opened.storage.writeState(id, { status: 'ready' });
    await mkdir(join(opened.paths.sessions, 'invalid name'), { recursive: true });
    await writeFile(join(opened.paths.sessions, 'not-a-directory'), 'ignored');

    // Act
    const ids = await opened.storage.sessionIdsOnDisk();
    opened.storage.forgetFromIndex(id);
    const forgotten = opened.storage.findSession(id);
    await opened.storage.syncSession(id);

    // Assert
    should(ids).deepEqual([id]);
    should(forgotten).be.undefined();
    should(opened.storage.findSession(id)?.status).equal('ready');
  });

  it('should order mixed-offset metadata by the represented instant', async () => {
    // Arrange
    const home = await createTemporaryHome();
    const opened = await openStorage(home);
    const earlier = parseSessionId('earlier-session');
    const later = parseSessionId('later-session');

    // Act
    await opened.storage.writeConfig(earlier, { updatedAt: '2026-07-30T10:00:00+02:00' });
    await opened.storage.writeConfig(later, { updatedAt: '2026-07-30T09:00:00Z' });
    const sessions = opened.storage.listSessions();

    // Assert
    should(sessions.map(session => session.id)).deepEqual([later, earlier]);
    should(sessions.map(session => session.updatedAt)).deepEqual([
      '2026-07-30T09:00:00.000Z',
      '2026-07-30T08:00:00.000Z',
    ]);
  });
});

describe('journal storage', () => {
  it('should reject invalid event input before creating a session', async () => {
    // Arrange
    const home = await createTemporaryHome();
    const opened = await openStorage(home);
    const id = parseSessionId('invalid-event');
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    // Act
    const error = await capturedError(async () => await opened.storage.append(id, 'event', circular));

    // Assert
    should(error instanceof Error).be.true();
    should(await exists(createSessionPaths(opened.paths, id).directory)).be.false();
    should(opened.storage.findSession(id)).be.undefined();
  });

  it('should append concurrently with monotonic sequences and explicit pagination', async () => {
    // Arrange
    const home = await createTemporaryHome();
    const opened = await openStorage(home);
    const id = parseSessionId('concurrent-events');

    // Act
    const appended = await Promise.all(
      Array.from(
        { length: 20 },
        async (_, index) =>
          await opened.storage.append(id, 'message', { index, text: index === 0 ? '你好 👋' : `message-${index}` }),
      ),
    );
    const first = await opened.storage.replay(id, 0, 7);
    const second = await opened.storage.replay(id, first.nextSequence, 20);

    // Assert
    should(appended.map(event => event.sequence)).deepEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    should(first.rows).equal(7);
    should(first.nextSequence).equal(7);
    should(first.hasMore).be.true();
    should(second.rows).equal(13);
    should(second.nextSequence).equal(20);
    should(second.hasMore).be.false();
    should(first.events[0]?.data).deepEqual({ index: 0, text: '你好 👋' });
  });

  it('should preserve a torn trailing record while separating the next durable event', async () => {
    // Arrange
    const home = await createTemporaryHome();
    const opened = await openStorage(home);
    const id = parseSessionId('torn-journal');
    await opened.storage.append(id, 'first', { value: 1 });
    const paths = createSessionPaths(opened.paths, id);
    await appendFile(paths.events, '{"partial":');

    // Act
    const appended = await opened.storage.append(id, 'second', { value: 2 });
    const replay = await opened.storage.replay(id);
    const sync = await opened.storage.syncSession(id);
    const bytes = await readFile(paths.events, 'utf8');

    // Assert
    should(appended.sequence).equal(2);
    should(replay.events.map(event => event.sequence)).deepEqual([1, 2]);
    should(sync.eventCount).equal(2);
    should(sync.problems.map(problem => problem.message)).deepEqual(['invalid JSON event record']);
    should(bytes).containEql('{"partial":\n{');
  });

  it('should detect a same-size same-mtime journal rewrite before assigning a sequence', async () => {
    // Arrange
    const home = await createTemporaryHome();
    const opened = await openStorage(home);
    const id = parseSessionId('rewritten-journal');
    const first = await opened.storage.append(id, 'original', { value: 1 });
    const eventsFile = createSessionPaths(opened.paths, id).events;
    const before = await stat(eventsFile);
    const rewritten = { ...first, sequence: 7 };
    await writeFile(eventsFile, `${encodeSessionEvent(rewritten)}\n`);
    await utimes(eventsFile, before.atime, before.mtime);
    const after = await stat(eventsFile);

    // Act
    const next = await opened.storage.append(id, 'next', { value: 2 });
    const replay = await opened.storage.replay(id);

    // Assert
    should(after.ino).equal(before.ino);
    should(after.size).equal(before.size);
    should(Math.trunc(after.mtimeMs)).equal(Math.trunc(before.mtimeMs));
    should(next.sequence).equal(8);
    should(replay.events.map(event => event.sequence)).deepEqual([7, 8]);
  });

  it('should discard stale pointers after a journal shrinks', async () => {
    // Arrange
    const home = await createTemporaryHome();
    const opened = await openStorage(home);
    const id = parseSessionId('shrunk-journal');
    const first = await opened.storage.append(id, 'first', {});
    await opened.storage.append(id, 'second', {});
    await opened.storage.append(id, 'third', {});
    const eventsFile = createSessionPaths(opened.paths, id).events;
    await writeFile(eventsFile, `${encodeSessionEvent(first)}\n`);

    // Act
    const replayAfterShrink = await opened.storage.replay(id);
    const appended = await opened.storage.append(id, 'replacement-second', {});
    const finalReplay = await opened.storage.replay(id);

    // Assert
    should(replayAfterShrink.events.map(event => event.sequence)).deepEqual([1]);
    should(appended.sequence).equal(2);
    should(finalReplay.events.map(event => event.type)).deepEqual(['first', 'replacement-second']);
  });

  it('should preserve indexed evidence and refuse every empty fallback when a journal disappears', async () => {
    // Arrange
    const home = await createTemporaryHome();
    const opened = await openStorage(home);
    const id = parseSessionId('missing-journal');
    await opened.storage.append(id, 'preserved', { value: true });
    const eventsFile = createSessionPaths(opened.paths, id).events;
    await rm(eventsFile);

    // Act — each path used to accept the missing file as a legitimate zero-event journal.
    const syncError = await capturedError(async () => await opened.storage.syncSession(id));
    const rebuildError = await capturedError(async () => await opened.storage.rebuildIndex());
    const reconciliation = await opened.storage.reconcile();
    const replayError = await capturedError(async () => await opened.storage.replay(id));
    const appendError = await capturedError(async () => await opened.storage.append(id, 'replacement', {}));

    // Assert — the disposable pointer remains as evidence; no operation recreates the journal or
    // reports an empty replay after durable data has vanished.
    should(syncError instanceof MissingSessionJournalError).be.true();
    should(rebuildError instanceof MissingSessionJournalError).be.true();
    should(replayError instanceof MissingSessionJournalError).be.true();
    should(appendError instanceof MissingSessionJournalError).be.true();
    should(reconciliation.failedSessionIds).deepEqual([id]);
    should(reconciliation.problems[0]?.message).containEql('has lost its durable journal');
    should(opened.storage.findSession(id)?.lastSequence).equal(1);
    should(await exists(eventsFile)).be.false();
  });

  it('should report that a journaled event is durable when both index attempts fail', async () => {
    // Arrange
    const home = await createTemporaryHome();
    const initialized = await openStorage(home);
    const paths = initialized.paths;
    await closeStorage(initialized.storage);
    const failReplacement = (): void => {
      throw new Error('replacement failed');
    };
    const failingIndex: SessionIndex = {
      replaceAll: () => undefined,
      replaceSession: failReplacement,
      refreshSession: failReplacement,
      appendEvent: () => {
        throw new Error('append failed');
      },
      appendEvents: () => {
        throw new Error('append failed');
      },
      findSession: () => undefined,
      listSessions: () => [],
      eventPointers: () => [],
      countEvents: () => 0,
      removeSession: () => undefined,
      close: () => undefined,
    };
    const storage = new DaemonStorage(
      paths,
      new StateFileSystem(paths),
      failingIndex,
      clockStartingAt(),
      new KeyedSerialExecutor(),
      { release: async () => undefined },
    );
    stores.add(storage);
    const id = parseSessionId('durable-failure');

    // Act
    const error = await capturedError(async () => await storage.append(id, 'durable', { saved: true }));
    const journal = await readFile(createSessionPaths(paths, id).events, 'utf8');

    // Assert
    should(error instanceof DurableEventIndexError).be.true();
    should((error as DurableEventIndexError).durable).be.true();
    should(journal).containEql('"saved":true');
  });

  it('should rebuild an event record that spans multiple bounded read chunks', async () => {
    // Arrange
    const home = await createTemporaryHome();
    const first = await openStorage(home);
    const id = parseSessionId('large-event');
    const text = 'x'.repeat(150_000);
    await first.storage.append(id, 'large', { text });
    const paths = first.paths;
    await closeStorage(first.storage);
    for (const file of indexFiles(paths)) await rm(file, { force: true });

    // Act
    const second = await openStorage(home);
    const rebuild = await second.storage.rebuildIndex();
    const replay = await second.storage.replay(id);

    // Assert
    should(rebuild).deepEqual({ sessionCount: 1, eventCount: 1, problems: [] });
    should(jsonObject(replay.events[0]?.data)?.text).equal(text);
  });
});

describe('disposable session index', () => {
  it('should reconstruct identical logical state after every index file is deleted', async () => {
    // Arrange
    const home = await createTemporaryHome();
    const first = await openStorage(home);
    const alpha = parseSessionId('alpha-session');
    const beta = parseSessionId('beta-session');
    await first.storage.writeConfig(alpha, { createdAt: '2026-07-30T10:00:00.000Z', label: 'alpha' });
    await first.storage.writeState(alpha, { status: 'running', count: 1 });
    await first.storage.append(alpha, 'started', { value: 'a' });
    await first.storage.append(alpha, 'updated', { value: 'b' });
    await first.storage.writeState(beta, { status: 'done', finishedAt: '2026-07-30T11:00:00.000Z' });
    await first.storage.append(beta, 'finished', { value: 'c' });
    const before = {
      sessions: first.storage.listSessions(),
      alphaConfig: await first.storage.readConfig(alpha),
      alphaState: await first.storage.readState(alpha),
      alphaEvents: (await first.storage.replay(alpha)).events,
      betaState: await first.storage.readState(beta),
      betaEvents: (await first.storage.replay(beta)).events,
    };
    const paths = first.paths;
    await closeStorage(first.storage);
    for (const file of indexFiles(paths)) await rm(file, { force: true });

    // Act
    const second = await openStorage(home);
    const rebuild = await second.storage.rebuildIndex();
    const after = {
      sessions: second.storage.listSessions(),
      alphaConfig: await second.storage.readConfig(alpha),
      alphaState: await second.storage.readState(alpha),
      alphaEvents: (await second.storage.replay(alpha)).events,
      betaState: await second.storage.readState(beta),
      betaEvents: (await second.storage.replay(beta)).events,
    };

    // Assert
    should(rebuild).deepEqual({ sessionCount: 2, eventCount: 3, problems: [] });
    should(after).deepEqual(before);
  });

  it('should drop an unknown index generation and rebuild from files when requested', async () => {
    // Arrange
    const home = await createTemporaryHome();
    const first = await openStorage(home);
    const id = parseSessionId('schema-session');
    await first.storage.writeState(id, { status: 'preserved' });
    await first.storage.append(id, 'event', { preserved: true });
    const indexPath = first.paths.sessionIndex;
    await closeStorage(first.storage);
    const oldIndex = new Database(indexPath, { strict: true });
    oldIndex.exec('PRAGMA user_version = 99');
    oldIndex.close();

    // Act
    const second = await openStorage(home);
    const rebuild = await second.storage.rebuildIndex();
    const generation = new Database(indexPath, { readonly: true, strict: true })
      .query<{ user_version: number }, []>('PRAGMA user_version')
      .get()?.user_version;

    // Assert
    should(generation).equal(1);
    should(rebuild).deepEqual({ sessionCount: 1, eventCount: 1, problems: [] });
    should(second.storage.findSession(id)?.lastSequence).equal(1);
    should((await second.storage.replay(id)).events[0]?.data).deepEqual({ preserved: true });
  });

  it('should drop a structurally stale index that claims the current generation', async () => {
    // Arrange
    const home = await createTemporaryHome();
    const first = await openStorage(home);
    const id = parseSessionId('stale-shape-session');
    await first.storage.append(id, 'preserved', { value: true });
    const paths = first.paths;
    await closeStorage(first.storage);
    for (const file of indexFiles(paths)) await rm(file, { force: true });
    const stale = new Database(paths.sessionIndex, { create: true, strict: true });
    stale.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        status TEXT,
        created_at TEXT,
        updated_at TEXT,
        last_sequence INTEGER NOT NULL,
        journal_device TEXT,
        journal_inode TEXT,
        journal_size INTEGER,
        journal_mtime_ms INTEGER
      );
      CREATE TABLE events (
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        time TEXT NOT NULL,
        type TEXT NOT NULL,
        byte_offset INTEGER NOT NULL,
        byte_length INTEGER NOT NULL,
        PRIMARY KEY (session_id, sequence)
      );
      PRAGMA user_version = 1;
    `);
    stale.close();

    // Act
    const second = await openStorage(home);
    const rebuild = await second.storage.rebuildIndex();
    const database = new Database(paths.sessionIndex, { readonly: true, strict: true });
    const columns = database
      .query<{ name: string }, []>('PRAGMA table_info(sessions)')
      .all()
      .map(row => row.name);
    database.close();

    // Assert
    should(columns).containEql('journal_line');
    should(rebuild).deepEqual({ sessionCount: 1, eventCount: 1, problems: [] });
    should((await second.storage.replay(id)).events[0]?.data).deepEqual({ value: true });
  });

  it('should reconcile stale index rows against the session namespace', async () => {
    // Arrange
    const home = await createTemporaryHome();
    const opened = await openStorage(home);
    const kept = parseSessionId('kept-session');
    const removed = parseSessionId('removed-session');
    await opened.storage.writeState(kept, { status: 'running' });
    await opened.storage.writeState(removed, { status: 'done' });
    await rm(createSessionPaths(opened.paths, removed).directory, { recursive: true });

    // Act
    const result = await opened.storage.reconcile();

    // Assert
    should(result.sessionCount).equal(1);
    should(opened.storage.listSessions().map(session => session.id)).deepEqual([kept]);
    should(opened.storage.findSession(removed)).be.undefined();
  });

  it('should keep document and event payloads and absolute homes out of SQLite', async () => {
    // Arrange
    const home = await createTemporaryHome();
    const opened = await openStorage(home);
    const id = parseSessionId('lean-index');
    const secret = 'payload-must-stay-in-authoritative-files';
    await opened.storage.writeConfig(id, { secret });
    await opened.storage.writeState(id, { status: 'running', secret });
    await opened.storage.append(id, 'secret-event', { secret });
    const database = new Database(opened.paths.sessionIndex, { readonly: true, strict: true });

    // Act
    const columns = {
      sessions: database
        .query<{ name: string }, []>('PRAGMA table_info(sessions)')
        .all()
        .map(row => row.name),
      events: database
        .query<{ name: string }, []>('PRAGMA table_info(events)')
        .all()
        .map(row => row.name),
    };
    const rows = {
      sessions: database.query<Record<string, unknown>, []>('SELECT * FROM sessions').all(),
      events: database.query<Record<string, unknown>, []>('SELECT * FROM events').all(),
    };
    database.close();
    const indexedText = JSON.stringify({ columns, rows });

    // Assert
    should(columns.sessions).not.containEql('config_json');
    should(columns.sessions).not.containEql('state_json');
    should(columns.events).not.containEql('data');
    should(indexedText).not.containEql(secret);
    should(indexedText).not.containEql(home);
  });

  it('should reject destructive filesystem operations outside the parsed home', async () => {
    // Arrange
    const home = await createTemporaryHome();
    const outsideDirectory = await createTemporaryHome();
    const opened = await openStorage(home);
    const fileSystem = new StateFileSystem(opened.paths);
    const outside = join(outsideDirectory, 'outside-index.sqlite');
    await writeFile(outside, 'must survive');

    // Act
    const error = await capturedError(async () => await fileSystem.removeFile(outside));

    // Assert
    should(error instanceof Error).be.true();
    should(await readFile(outside, 'utf8')).equal('must survive');
    should(indexFiles(opened.paths).every(path => path.startsWith(`${home}/`))).be.true();
  });

  it('should refuse a symlinked index directory without touching its target', async () => {
    // Arrange
    const home = await createTemporaryHome();
    const outside = await createTemporaryHome();
    const first = await openStorage(home);
    const paths = first.paths;
    await closeStorage(first.storage);
    await rm(paths.index, { recursive: true });
    await writeFile(join(outside, 'sentinel'), 'must survive');
    await symlink(outside, paths.index, 'dir');

    // Act
    const error = await capturedError(async () => await openStorage(home));

    // Assert
    should(error instanceof Error).be.true();
    should(String(error)).containEql('symbolic links are not allowed');
    should(await readFile(join(outside, 'sentinel'), 'utf8')).equal('must survive');
    should(await exists(join(outside, 'sessions.sqlite'))).be.false();
  });
});
