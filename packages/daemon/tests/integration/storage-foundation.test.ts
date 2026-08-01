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
  type DurableAppendOutcome,
  encodeSessionEvent,
  type FileInformation,
  type FileSystemFactory,
  type FileSystemPort,
  type FoundationPaths,
  indexFiles,
  type JournalFingerprint,
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

/**
 * Disturbs a journal exactly once, on the next `information` call.
 *
 * The durable append verifies the pathname after its bytes are on disk, and that verification is
 * its only `information` call — so this is where a swap or a foreign write has to land to be
 * observed at all.
 */
class RepointingStateFileSystem extends StateFileSystem {
  disturbOnNextInformation: 'delete' | 'replace' | 'foreign-append' | undefined;

  override async information(path: string): Promise<FileInformation | undefined> {
    const disturb = this.disturbOnNextInformation;
    if (disturb !== undefined && path.endsWith('/events.jsonl')) {
      this.disturbOnNextInformation = undefined;
      if (disturb === 'foreign-append') await appendFile(path, 'foreign\n');
      else {
        await rm(path, { force: true });
        if (disturb === 'replace') await writeFile(path, '');
      }
    }
    return await super.information(path);
  }
}

/** Deletes or swaps a journal in the instant between the caller's check and the real append. */
class TearingStateFileSystem extends StateFileSystem {
  tearOnNextAppend: 'delete' | 'replace' | undefined;

  override async appendLineToExisting(
    path: string,
    line: string,
    expect: JournalFingerprint,
  ): Promise<DurableAppendOutcome> {
    const tear = this.tearOnNextAppend;
    if (tear !== undefined && path.endsWith('/events.jsonl')) {
      this.tearOnNextAppend = undefined;
      await rm(path, { force: true });
      if (tear === 'replace') await writeFile(path, '');
    }
    return await super.appendLineToExisting(path, line, expect);
  }
}

class TearingFileSystemFactory implements FileSystemFactory {
  instance: TearingStateFileSystem | undefined;

  create(paths: FoundationPaths): FileSystemPort {
    const fileSystem = new TearingStateFileSystem(paths);
    this.instance = fileSystem;
    return fileSystem;
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

async function openStorage(
  home: string,
  clock = clockStartingAt(),
  fileSystems: FileSystemFactory = new StateFileSystemFactory(),
): Promise<OpenedDaemonStorage> {
  const factory = new DaemonStorageFactory(
    new RuntimeEnvironment({ FY_HOME: home }, () => '/home-must-not-be-used'),
    fileSystems,
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

  it('should leave every document byte-for-byte unchanged when the journal is missing', async () => {
    // Arrange — the observed repro persisted config version 2 and then failed on the journal
    // append, leaving the documents a transition ahead of the history that justifies them.
    const home = await createTemporaryHome();
    const opened = await openStorage(home);
    const id = parseSessionId('gated-documents');
    await opened.storage.writeConfig(id, { generation: 1 });
    await opened.storage.writeState(id, { status: 'running' });
    await opened.storage.append(id, 'durable', {});
    const paths = createSessionPaths(opened.paths, id);
    const before = { config: await readFile(paths.config, 'utf8'), state: await readFile(paths.state, 'utf8') };
    await rm(paths.events);
    let transforms = 0;
    const bump = (): JsonValue => {
      transforms += 1;
      return { generation: 2 };
    };

    // Act
    const failures = [
      await capturedError(async () => await opened.storage.writeConfig(id, { generation: 2 })),
      await capturedError(async () => await opened.storage.writeState(id, { status: 'claimed' })),
      await capturedError(async () => await opened.storage.updateConfig(id, bump)),
      await capturedError(async () => await opened.storage.updateState(id, bump)),
    ];

    // Assert — the refusal lands before the transform, so nothing was even computed to write.
    should(failures.map(failure => (failure as Error).name)).deepEqual([
      'MissingSessionJournalError',
      'MissingSessionJournalError',
      'MissingSessionJournalError',
      'MissingSessionJournalError',
    ]);
    should(transforms).equal(0);
    should(await readFile(paths.config, 'utf8')).equal(before.config);
    should(await readFile(paths.state, 'utf8')).equal(before.state);
    should(await exists(paths.events)).be.false();
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

  it('should quarantine a session whose journal disappeared and refuse every empty fallback', async () => {
    // Arrange
    const home = await createTemporaryHome();
    const opened = await openStorage(home);
    const id = parseSessionId('missing-journal');
    await opened.storage.append(id, 'preserved', { value: true });
    const eventsFile = createSessionPaths(opened.paths, id).events;
    await rm(eventsFile);

    // Act — each path used to accept the missing file as a legitimate zero-event journal.
    const syncError = await capturedError(async () => await opened.storage.syncSession(id));
    const rebuild = await opened.storage.rebuildIndex();
    const reconciliation = await opened.storage.reconcile();
    const replayError = await capturedError(async () => await opened.storage.replay(id));
    const appendError = await capturedError(async () => await opened.storage.append(id, 'replacement', {}));

    // Assert — the durable marker, not the index row, is what still refuses: the rebuild has
    // already dropped the row, and every read path keeps refusing anyway.
    should(syncError instanceof MissingSessionJournalError).be.true();
    should(replayError instanceof MissingSessionJournalError).be.true();
    should(appendError instanceof MissingSessionJournalError).be.true();
    should(rebuild.lostJournalSessionIds).deepEqual([id]);
    should(rebuild.sessionCount).equal(0);
    should(reconciliation.lostJournalSessionIds).deepEqual([id]);
    should(reconciliation.failedSessionIds).deepEqual([id]);
    should(reconciliation.problems[0]?.message).containEql('has lost its durable journal');
    should(opened.storage.findSession(id)).be.undefined();
    should(await exists(eventsFile)).be.false();
  });

  it('should survive losing a journal and every index file without fabricating an empty session', async () => {
    // Arrange — the disposable index is deleted along with the journal, so nothing but the durable
    // session marker is left to say the lost session ever had events.
    const home = await createTemporaryHome();
    const first = await openStorage(home);
    const lost = parseSessionId('lost-session');
    const healthy = parseSessionId('healthy-session');
    await first.storage.append(lost, 'durable', { value: true });
    await first.storage.append(healthy, 'durable', { value: true });
    const paths = first.paths;
    await closeStorage(first.storage);
    await rm(createSessionPaths(paths, lost).events);
    for (const file of indexFiles(paths)) await rm(file, { force: true });

    // Act
    const second = await openStorage(home);
    const rebuild = await second.storage.rebuildIndex();
    const replayError = await capturedError(async () => await second.storage.replay(lost));
    const appendError = await capturedError(async () => await second.storage.append(lost, 'replacement', {}));

    // Assert — one lost journal quarantines one session; it does not brick the whole home.
    should(rebuild.lostJournalSessionIds).deepEqual([lost]);
    should(rebuild.sessionCount).equal(1);
    should(second.storage.listSessions().map(session => session.id)).deepEqual([healthy]);
    should((await second.storage.replay(healthy)).events.map(event => event.type)).deepEqual(['durable']);
    should(replayError instanceof MissingSessionJournalError).be.true();
    should(appendError instanceof MissingSessionJournalError).be.true();
    should(await exists(createSessionPaths(paths, lost).events)).be.false();
  });

  it('should create a real empty journal for a session that has recorded no events', async () => {
    // Arrange
    const home = await createTemporaryHome();
    const opened = await openStorage(home);
    const id = parseSessionId('eventless-session');

    // Act
    await opened.storage.writeConfig(id, { label: 'quiet' });
    const paths = createSessionPaths(opened.paths, id);
    const replay = await opened.storage.replay(id);

    // Assert — emptiness is a real zero-length file, so a later absence can only mean loss.
    should(await readFile(paths.marker, 'utf8')).equal('2\n');
    should((await stat(paths.events)).size).equal(0);
    should(replay.events).deepEqual([]);
    should(opened.storage.findSession(id)?.journal?.size).equal(0);
  });

  it('should complete a creation torn before its marker, and still refuse a foreign directory', async () => {
    // Arrange — creation writes the marker last, so a zero-length journal is its only tear.
    const home = await createTemporaryHome();
    const opened = await openStorage(home);
    const torn = parseSessionId('torn-creation');
    const foreign = parseSessionId('foreign-creation');
    const tornPaths = createSessionPaths(opened.paths, torn);
    const foreignPaths = createSessionPaths(opened.paths, foreign);
    await mkdir(tornPaths.directory, { recursive: true });
    await writeFile(tornPaths.events, '');
    await mkdir(foreignPaths.directory, { recursive: true });
    await writeFile(foreignPaths.events, '{"foreign":true}\n');

    // Act
    await opened.storage.writeConfig(torn, { adopted: true });
    const error = await capturedError(async () => await opened.storage.writeConfig(foreign, { adopted: true }));

    // Assert
    should(await readFile(tornPaths.marker, 'utf8')).equal('2\n');
    should(await opened.storage.readConfig(torn)).deepEqual({ adopted: true });
    should(error instanceof SessionLayoutError).be.true();
    should(await exists(foreignPaths.marker)).be.false();
    should(await readFile(foreignPaths.events, 'utf8')).equal('{"foreign":true}\n');
  });

  it('should migrate a legacy session with a journal and one without, then detect a later loss', async () => {
    // Arrange — hand-built version-1 directories, exactly as an older daemon left them.
    const home = await createTemporaryHome();
    const first = await openStorage(home);
    const withJournal = parseSessionId('legacy-with-journal');
    const withoutJournal = parseSessionId('legacy-without-journal');
    const paths = first.paths;
    await closeStorage(first.storage);
    const journaled = createSessionPaths(paths, withJournal);
    const eventless = createSessionPaths(paths, withoutJournal);
    for (const session of [journaled, eventless]) {
      await mkdir(session.directory, { recursive: true, mode: 0o700 });
      await writeFile(session.marker, '1\n', { mode: 0o600 });
      await writeFile(session.state, '{"status":"running"}\n', { mode: 0o600 });
    }
    const legacyEvent = {
      schemaVersion: 1,
      sequence: 1,
      sessionId: withJournal,
      time: '2026-07-30T10:00:00.000Z',
      type: 'legacy',
      data: {},
    };
    await writeFile(journaled.events, `${JSON.stringify(legacyEvent)}\n`, { mode: 0o600 });

    // Act
    const second = await openStorage(home);
    const rebuild = await second.storage.rebuildIndex();
    const migrated = await stat(eventless.events);
    await rm(eventless.events);
    const lossError = await capturedError(async () => await second.storage.replay(withoutJournal));

    // Assert — both are now version 2, and the one that was legitimately empty has acquired the
    // ability to tell emptiness from loss.
    should(await readFile(journaled.marker, 'utf8')).equal('2\n');
    should(await readFile(eventless.marker, 'utf8')).equal('2\n');
    should(migrated.size).equal(0);
    should(rebuild.sessionCount).equal(2);
    should(second.storage.findSession(withJournal)?.lastSequence).equal(1);
    should(second.storage.findSession(withoutJournal)?.lastSequence).equal(0);
    should(lossError instanceof MissingSessionJournalError).be.true();
  });

  it('should refuse to fabricate a journal for a legacy session the index still witnesses', async () => {
    // Arrange — a version-1 marker with no journal but a live index fingerprint is lost history,
    // not emptiness; migrating it would destroy the last evidence of that.
    const home = await createTemporaryHome();
    const first = await openStorage(home);
    const id = parseSessionId('legacy-witnessed');
    await first.storage.append(id, 'durable', { value: true });
    const paths = createSessionPaths(first.paths, id);
    await closeStorage(first.storage);
    await writeFile(paths.marker, '1\n', { mode: 0o600 });
    await rm(paths.events);

    // Act — opening the home must still succeed; the refusal belongs to the mutation.
    const second = await openStorage(home);
    const writeError = await capturedError(async () => await second.storage.writeState(id, { status: 'claimed' }));

    // Assert
    should(await readFile(paths.marker, 'utf8')).equal('1\n');
    should(await exists(paths.events)).be.false();
    should(writeError instanceof MissingSessionJournalError).be.true();
    should(await exists(paths.state)).be.false();
  });

  it.each([
    { tear: 'delete' as const, error: 'MissingSessionJournalError' },
    { tear: 'replace' as const, error: 'JournalReplacedError' },
  ])('should refuse the second append when the journal is $tear-d just before it', async ({ tear, error }) => {
    // Arrange — the exact repro: append #1, deletion, append #2 silently succeeding into a file the
    // daemon had just recreated, and a replay that then contained only event #2.
    const home = await createTemporaryHome();
    const fileSystems = new TearingFileSystemFactory();
    const opened = await openStorage(home, clockStartingAt(), fileSystems);
    const id = parseSessionId('torn-append');
    await opened.storage.append(id, 'first', { value: 1 });
    const eventsFile = createSessionPaths(opened.paths, id).events;
    const indexedBefore = opened.storage.findSession(id);
    if (fileSystems.instance === undefined) throw new Error('test filesystem must be created');
    fileSystems.instance.tearOnNextAppend = tear;

    // Act
    const failure = await capturedError(async () => await opened.storage.append(id, 'second', { value: 2 }));

    // Assert — nothing recreates the journal, nothing is written into an impostor, and the index
    // still holds the pre-deletion evidence.
    should((failure as Error).name).equal(error);
    should(await exists(eventsFile)).equal(tear === 'replace');
    should(tear === 'delete' ? '' : await readFile(eventsFile, 'utf8')).equal('');
    should(opened.storage.findSession(id)).deepEqual(indexedBefore);
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

describe('durable journal append', () => {
  async function journalFor(id: string): Promise<{ fileSystem: RepointingStateFileSystem; file: string }> {
    const home = await createTemporaryHome();
    const opened = await openStorage(home);
    const session = parseSessionId(id);
    await opened.storage.append(session, 'first', { value: 1 });
    return {
      fileSystem: new RepointingStateFileSystem(opened.paths),
      file: createSessionPaths(opened.paths, session).events,
    };
  }

  it('should append to the exact file the caller named', async () => {
    // Arrange
    const { fileSystem, file } = await journalFor('exact-append');
    const expected = await fileSystem.information(file);
    if (expected === undefined) throw new Error('test journal must exist');

    // Act
    const outcome = await fileSystem.appendLineToExisting(file, '{"second":true}', expected);

    // Assert
    should(outcome.kind).equal('appended');
    should(outcome.kind === 'appended' && outcome.append.byteOffset).equal(expected.size);
    should(await readFile(file, 'utf8')).containEql('{"second":true}\n');
  });

  it('should report an absent journal rather than creating one', async () => {
    // Arrange
    const { fileSystem, file } = await journalFor('absent-append');
    const expected = await fileSystem.information(file);
    if (expected === undefined) throw new Error('test journal must exist');
    await rm(file);

    // Act
    const outcome = await fileSystem.appendLineToExisting(file, '{"second":true}', expected);

    // Assert
    should(outcome).deepEqual({ kind: 'absent' });
    should(await exists(file)).be.false();
  });

  it('should report a replacement when the pathname names a different file', async () => {
    // Arrange
    const { fileSystem, file } = await journalFor('swapped-append');
    const expected = await fileSystem.information(file);
    if (expected === undefined) throw new Error('test journal must exist');
    await rm(file);
    await writeFile(file, '');

    // Act
    const outcome = await fileSystem.appendLineToExisting(file, '{"second":true}', expected);

    // Assert — the impostor must not receive the record.
    should(outcome).deepEqual({ kind: 'replaced' });
    should(await readFile(file, 'utf8')).equal('');
  });

  it('should report a replacement when the file changed size under the caller', async () => {
    // Arrange — a foreign appender, which the caller must re-inspect before trusting an offset.
    const { fileSystem, file } = await journalFor('resized-append');
    const expected = await fileSystem.information(file);
    if (expected === undefined) throw new Error('test journal must exist');
    await appendFile(file, 'foreign\n');

    // Act
    const outcome = await fileSystem.appendLineToExisting(file, '{"second":true}', expected);

    // Assert
    should(outcome).deepEqual({ kind: 'replaced' });
    should(await readFile(file, 'utf8')).not.containEql('second');
  });

  it.each(['delete', 'replace', 'foreign-append'] as const)(
    'should report a replacement when a %s disturbs the journal after the bytes land',
    async disturb => {
      // Arrange — the record is durable in some inode, but if the path no longer names it, or the
      // file grew by more than this record, the byte offset the caller would index is a lie.
      const { fileSystem, file } = await journalFor(`disturbed-${disturb}`);
      const expected = await fileSystem.information(file);
      if (expected === undefined) throw new Error('test journal must exist');
      fileSystem.disturbOnNextInformation = disturb;

      // Act
      const outcome = await fileSystem.appendLineToExisting(file, '{"second":true}', expected);

      // Assert
      should(outcome).deepEqual({ kind: 'replaced' });
      should(await exists(file)).equal(disturb !== 'delete');
    },
  );
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
