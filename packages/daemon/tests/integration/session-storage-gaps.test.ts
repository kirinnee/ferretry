import { afterEach, describe, it } from 'bun:test';
import { rmSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  BunSqliteIndexFactory,
  DaemonStorage,
  DaemonStorageFactory,
  KeyedSerialExecutor,
  type OpenedDaemonStorage,
  RuntimeEnvironment,
  SessionLayoutError,
  SqliteHomeLockFactory,
  StateFileSystem,
  StateHomeLayout,
  SystemClock,
} from '../../src/adapters/index.ts';
import {
  createSessionPaths,
  encodeSessionEvent,
  type FileSystemFactory,
  type FileSystemPort,
  type FoundationPaths,
  parseSessionId,
  type SessionIndex,
  type SessionIndexFactory,
} from '../../src/lib/index.ts';

const homes = new Set<string>();
const stores = new Set<DaemonStorage>();

/** Misbehaves on cue, at the exact read where a concurrent writer would land. */
class DisturbedStateFileSystem extends StateFileSystem {
  /** Appends foreign bytes before the next N journal scans, so each scan sees the file move under it. */
  churnOnJournalScans = 0;
  /** Runs once, instead of the next read of a session marker's text, then reports the marker gone. */
  vanishOnMarkerRead: (() => Promise<void>) | undefined;
  /** Makes every byte-range read answer nothing, as a journal truncated beneath its pointers would. */
  blindSlices = false;

  override async *readChunks(path: string, chunkSize: number, offset = 0): AsyncIterable<Uint8Array> {
    if (this.churnOnJournalScans > 0 && path.endsWith('/events.jsonl')) {
      this.churnOnJournalScans -= 1;
      await appendFile(path, 'foreign\n');
    }
    yield* super.readChunks(path, chunkSize, offset);
  }

  override async readText(path: string): Promise<string | undefined> {
    const vanish = this.vanishOnMarkerRead;
    if (vanish !== undefined && path.endsWith('/session-version')) {
      this.vanishOnMarkerRead = undefined;
      await vanish();
      return undefined;
    }
    return await super.readText(path);
  }

  override async readSlice(path: string, offset: number, length: number): Promise<Uint8Array | undefined> {
    return this.blindSlices ? undefined : await super.readSlice(path, offset, length);
  }
}

class DisturbedFileSystemFactory implements FileSystemFactory {
  instance: DisturbedStateFileSystem | undefined;

  create(paths: FoundationPaths): FileSystemPort {
    const fileSystem = new DisturbedStateFileSystem(paths);
    this.instance = fileSystem;
    return fileSystem;
  }
}

/** An index that, on cue, lets the disk change under a fleet listing or drops everything it lists. */
class DisturbedIndexFactory implements SessionIndexFactory {
  private readonly real = new BunSqliteIndexFactory();
  forgetAfterListings = Number.POSITIVE_INFINITY;
  /** Runs once, synchronously, as the next fleet listing is taken. */
  beforeNextListing: (() => void) | undefined;

  async open(paths: FoundationPaths, fileSystem: FileSystemPort): Promise<SessionIndex> {
    const index = await this.real.open(paths, fileSystem);
    let listings = 0;
    return new Proxy(index, {
      get: (target, property) => {
        if (property === 'listSessions') {
          return () => {
            const disturb = this.beforeNextListing;
            this.beforeNextListing = undefined;
            disturb?.();
            return ++listings > this.forgetAfterListings ? [] : target.listSessions();
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
}

async function createTemporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-session-storage-gaps-'));
  homes.add(home);
  return home;
}

async function openStorage(
  home: string,
  fileSystems: FileSystemFactory = new DisturbedFileSystemFactory(),
  indexes: SessionIndexFactory = new BunSqliteIndexFactory(),
): Promise<OpenedDaemonStorage> {
  const start = Date.parse('2026-07-30T12:00:00.000Z');
  let tick = 0;
  const factory = new DaemonStorageFactory(
    new RuntimeEnvironment({ FY_HOME: home }, () => '/home-must-not-be-used'),
    fileSystems,
    new StateHomeLayout(),
    new SqliteHomeLockFactory(),
    indexes,
    new SystemClock(() => new Date(start + tick++ * 1_000)),
    () => new KeyedSerialExecutor(),
  );
  const opened = await factory.open();
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

/** Rewrites a journal's bytes in place, then restores its mtime so only the content differs. */
async function rewriteJournalInPlace(file: string, transform: (text: string) => string): Promise<void> {
  const before = await stat(file);
  const text = await readFile(file, 'utf8');
  const rewritten = transform(text);
  if (Buffer.byteLength(rewritten) !== Buffer.byteLength(text)) throw new Error('rewrite must keep the byte length');
  await writeFile(file, rewritten);
  await utimes(file, before.atime, before.mtime);
}

afterEach(async () => {
  for (const storage of stores) await storage.close().catch(() => undefined);
  stores.clear();
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

describe('session storage — directories that are not sessions', () => {
  it('should word a refused marker by its trimmed text', () => {
    // Arrange
    const id = parseSessionId('marked');

    // Act
    const unmarked = new SessionLayoutError(id, undefined);
    const unsupported = new SessionLayoutError(id, ' 9\n');

    // Assert
    should(unmarked.message).equal('session marked is non-empty but has no session-version marker');
    should(unsupported.message).equal('session marked has unsupported session-version marker "9"');
  });

  it('should refuse to replay a session whose marker names a version this daemon does not know', async () => {
    // Arrange
    const home = await createTemporaryHome();
    const opened = await openStorage(home);
    const id = parseSessionId('from-the-future');
    const paths = createSessionPaths(opened.paths, id);
    await mkdir(paths.directory, { recursive: true, mode: 0o700 });
    await writeFile(paths.marker, '9\n', { mode: 0o600 });
    await writeFile(paths.events, '', { mode: 0o600 });
    await writeFile(paths.state, '{"status":"running"}\n', { mode: 0o600 });

    // Act
    const error = await capturedError(async () => await opened.storage.replay(id));

    // Assert
    should(error instanceof SessionLayoutError).be.true();
    should(String(error)).containEql('unsupported session-version marker "9"');
  });

  it('should leave an unsupported-marker session out of the index when it is synchronized directly', async () => {
    // Arrange
    const home = await createTemporaryHome();
    const opened = await openStorage(home);
    const id = parseSessionId('from-the-future');
    const paths = createSessionPaths(opened.paths, id);
    await mkdir(paths.directory, { recursive: true, mode: 0o700 });
    await writeFile(paths.marker, '9\n', { mode: 0o600 });
    await writeFile(paths.events, '', { mode: 0o600 });
    await writeFile(paths.state, '{"status":"running"}\n', { mode: 0o600 });

    // Act
    const result = await opened.storage.syncSession(id);

    // Assert
    should(result.sessionCount).equal(0);
    should(result.eventCount).equal(0);
    should(result.problems.map(problem => problem.message)).deepEqual(['unsupported session marker']);
    should(opened.storage.findSession(id)).be.undefined();
  });

  it('should treat an empty session directory as nothing to index', async () => {
    // Arrange
    const home = await createTemporaryHome();
    const opened = await openStorage(home);
    const id = parseSessionId('bare-directory');
    await mkdir(createSessionPaths(opened.paths, id).directory, { recursive: true, mode: 0o700 });

    // Act
    const result = await opened.storage.syncSession(id);

    // Assert
    should(result).deepEqual({ sessionCount: 0, eventCount: 0, problems: [] });
    should(opened.storage.findSession(id)).be.undefined();
  });

  it('should report a directory whose name is not a session id, in a rebuild and in a reconcile', async () => {
    // Arrange
    const home = await createTemporaryHome();
    const opened = await openStorage(home);
    const kept = parseSessionId('kept-session');
    await opened.storage.writeState(kept, { status: 'running' });
    await mkdir(join(opened.paths.sessions, 'Not A Session!'), { mode: 0o700 });
    const expected = [{ line: 0, byteOffset: 0, message: 'invalid session directory "Not A Session!"' }];

    // Act
    const rebuild = await opened.storage.rebuildIndex();
    const reconcile = await opened.storage.reconcile();

    // Assert
    for (const result of [rebuild, reconcile]) {
      should(result.sessionCount).equal(1);
      should(result.problems.map(({ line, byteOffset, message }) => ({ line, byteOffset, message }))).deepEqual(
        expected,
      );
      should(result.problems[0]?.file).equal(join(opened.paths.sessions, 'Not A Session!'));
    }
  });

  it('should skip a session whose marker cannot be read, and keep reconciling the others', async () => {
    // Arrange
    const home = await createTemporaryHome();
    const opened = await openStorage(home);
    const kept = parseSessionId('kept-session');
    const broken = parseSessionId('broken-marker');
    await opened.storage.writeState(kept, { status: 'running' });
    const brokenPaths = createSessionPaths(opened.paths, broken);
    await mkdir(brokenPaths.marker, { recursive: true, mode: 0o700 });

    // Act
    const result = await opened.storage.reconcile();

    // Assert
    should(result.sessionCount).equal(1);
    should(result.failedSessionIds).deepEqual([broken]);
    should(result.problems).have.length(1);
    should(result.problems[0]?.file).equal(brokenPaths.directory);
    should(result.problems[0]?.message).startWith(`session ${broken} failed to read and was skipped: `);
    should(opened.storage.findSession(kept)?.id).equal(kept);
  });

  it('should forget a session whose config and state are gone and keep serving an empty replay', async () => {
    // Arrange — only the marker and an empty journal are left, which is a reservation, not a session.
    const home = await createTemporaryHome();
    const opened = await openStorage(home);
    const id = parseSessionId('reduced-to-reservation');
    await opened.storage.writeConfig(id, { name: 'gone soon' });
    await rm(createSessionPaths(opened.paths, id).config);

    // Act
    const replay = await opened.storage.replay(id);

    // Assert
    should(replay.events).deepEqual([]);
    should(opened.storage.findSession(id)).be.undefined();
  });
});

describe('session storage — a journal that moves while it is read', () => {
  it('should refuse a journal that keeps changing under every scan', async () => {
    // Arrange — one event is indexed, a second line arrives unindexed, then every rescan sees yet more.
    const home = await createTemporaryHome();
    const fileSystems = new DisturbedFileSystemFactory();
    const opened = await openStorage(home, fileSystems);
    const id = parseSessionId('restless-journal');
    const first = await opened.storage.append(id, 'first', {});
    const paths = createSessionPaths(opened.paths, id);
    await appendFile(paths.events, `${encodeSessionEvent({ ...first, sequence: 2, type: 'second' })}\n`);
    fileSystems.instance!.churnOnJournalScans = 3;

    // Act
    const result = await opened.storage.reconcile();

    // Assert
    should(result.failedSessionIds).deepEqual([id]);
    should(result.problems.map(problem => problem.message)).deepEqual([
      `session ${id} failed to reconcile and was skipped: journal changed repeatedly while reading ${paths.events}`,
    ]);
  });

  it('should fall back to a full rescan when the journal moves again during a tail scan', async () => {
    // Arrange — the index knows one event; a second landed on disk and a third lands mid-scan.
    const home = await createTemporaryHome();
    const fileSystems = new DisturbedFileSystemFactory();
    const opened = await openStorage(home, fileSystems);
    const id = parseSessionId('moving-tail');
    const first = await opened.storage.append(id, 'first', {});
    const paths = createSessionPaths(opened.paths, id);
    const second = { ...first, sequence: 2, type: 'second' };
    await appendFile(paths.events, `${encodeSessionEvent(second)}\n`);
    fileSystems.instance!.churnOnJournalScans = 1;

    // Act
    const result = await opened.storage.reconcile();

    // Assert — the foreign line is reported, and both real events are indexed from the full scan.
    should(result.sessionCount).equal(1);
    should(result.eventCount).equal(2);
    should(result.problems.map(problem => problem.message)).deepEqual(['invalid JSON event record']);
    should(opened.storage.findSession(id)?.lastSequence).equal(2);
  });

  it('should drop a session whose marker and documents vanish between observing it and rescanning it', async () => {
    // Arrange — observed as a real session, then reduced to a bare reservation before the rescan reads it.
    const home = await createTemporaryHome();
    const fileSystems = new DisturbedFileSystemFactory();
    const opened = await openStorage(home, fileSystems);
    const id = parseSessionId('vanishing-session');
    await opened.storage.writeConfig(id, { name: 'vanishing' });
    opened.storage.forgetFromIndex(id);
    const paths = createSessionPaths(opened.paths, id);
    fileSystems.instance!.vanishOnMarkerRead = async () => {
      await rm(paths.config);
      await rm(paths.marker);
    };

    // Act
    const result = await opened.storage.reconcile();

    // Assert
    should(result.sessionCount).equal(0);
    should(result.problems).deepEqual([]);
    should(opened.storage.findSession(id)).be.undefined();
  });

  it('should rescan when the last indexed event was overwritten with bytes that are not JSON', async () => {
    // Arrange — the file grew past what the index knows AND its last known record no longer parses.
    const home = await createTemporaryHome();
    const opened = await openStorage(home);
    const id = parseSessionId('overwritten-record');
    const first = await opened.storage.append(id, 'first', {});
    const paths = createSessionPaths(opened.paths, id);
    const line = encodeSessionEvent(first);
    await rewriteJournalInPlace(paths.events, () => `${'x'.repeat(line.length)}\n`);
    await appendFile(paths.events, `${encodeSessionEvent({ ...first, sequence: 2, type: 'second' })}\n`);

    // Act
    const result = await opened.storage.reconcile();

    // Assert — a full rescan, not a trusting tail scan from the stale pointer.
    should(result.sessionCount).equal(1);
    should(result.problems.map(problem => problem.message)).containEql('invalid JSON event record');
    should(opened.storage.findSession(id)?.lastSequence).equal(2);
  });
});

describe('session storage — a version-1 session that never had a journal', () => {
  it('should keep it indexed without a journal across a reconcile, and replay it as empty', async () => {
    // Arrange
    const home = await createTemporaryHome();
    const opened = await openStorage(home);
    const id = parseSessionId('legacy-eventless');
    const paths = createSessionPaths(opened.paths, id);
    await mkdir(paths.directory, { recursive: true, mode: 0o700 });
    await writeFile(paths.marker, '1\n', { mode: 0o600 });
    await writeFile(paths.state, '{"status":"running"}\n', { mode: 0o600 });
    await opened.storage.rebuildIndex();

    // Act
    const reconcile = await opened.storage.reconcile();
    const replay = await opened.storage.replay(id);

    // Assert
    should(reconcile).deepEqual({ sessionCount: 1, eventCount: 0, problems: [] });
    should(opened.storage.findSession(id)?.journal).be.null();
    should(replay.events).deepEqual([]);
  });
});

describe('session storage — replay and fleet tail', () => {
  it('should refuse replay arguments that are not whole, bounded numbers', async () => {
    // Arrange
    const home = await createTemporaryHome();
    const opened = await openStorage(home);
    const id = parseSessionId('bounded-replay');

    // Act
    const negative = await capturedError(async () => await opened.storage.replay(id, -1));
    const fractional = await capturedError(async () => await opened.storage.replay(id, 0.5));
    const empty = await capturedError(async () => await opened.storage.replay(id, 0, 0));
    const huge = await capturedError(async () => await opened.storage.replay(id, 0, 10_001));

    // Assert
    should(String(negative)).containEql('afterSequence must be a non-negative integer');
    should(String(fractional)).containEql('afterSequence must be a non-negative integer');
    should(String(empty)).containEql('limit must be an integer between 1 and 10000');
    should(String(huge)).containEql('limit must be an integer between 1 and 10000');
  });

  it('should re-index and serve a replay whose indexed record changed type under the same bytes', async () => {
    // Arrange — same length, same mtime, so only a byte-for-byte proof of the pointer can notice.
    const home = await createTemporaryHome();
    const opened = await openStorage(home);
    const id = parseSessionId('retyped-record');
    await opened.storage.append(id, 'aaaa', {});
    await opened.storage.append(id, 'last', {});
    const paths = createSessionPaths(opened.paths, id);
    await rewriteJournalInPlace(paths.events, text => text.replace('"type":"aaaa"', '"type":"bbbb"'));

    // Act
    const replay = await opened.storage.replay(id);

    // Assert
    should(replay.events.map(event => event.type)).deepEqual(['bbbb', 'last']);
  });

  it('should re-index and serve a replay whose indexed record is no longer JSON', async () => {
    // Arrange
    const home = await createTemporaryHome();
    const opened = await openStorage(home);
    const id = parseSessionId('garbled-record');
    const first = await opened.storage.append(id, 'first', {});
    await opened.storage.append(id, 'last', {});
    const paths = createSessionPaths(opened.paths, id);
    const length = encodeSessionEvent(first).length;
    await rewriteJournalInPlace(paths.events, text => `${'x'.repeat(length)}${text.slice(length)}`);

    // Act
    const replay = await opened.storage.replay(id);

    // Assert
    should(replay.events.map(event => event.type)).deepEqual(['last']);
  });

  it('should refuse a replay that stays unprovable after re-indexing', async () => {
    // Arrange
    const home = await createTemporaryHome();
    const fileSystems = new DisturbedFileSystemFactory();
    const opened = await openStorage(home, fileSystems);
    const id = parseSessionId('unprovable-replay');
    await opened.storage.append(id, 'first', {});
    fileSystems.instance!.blindSlices = true;

    // Act
    const error = await capturedError(async () => await opened.storage.replay(id));

    // Assert
    should(String(error)).containEql(`event index for ${id} is inconsistent after re-indexing`);
  });

  it('should re-index only the tail sessions when a tail record changed type, then serve the fleet tail', async () => {
    // Arrange
    const home = await createTemporaryHome();
    const opened = await openStorage(home);
    const id = parseSessionId('retyped-tail');
    await opened.storage.append(id, 'aaaa', {});
    await opened.storage.append(id, 'last', {});
    await rewriteJournalInPlace(createSessionPaths(opened.paths, id).events, text =>
      text.replace('"type":"aaaa"', '"type":"bbbb"'),
    );

    // Act
    const tail = await opened.storage.tailEvents();

    // Assert
    should(tail.map(event => event.type)).deepEqual(['bbbb', 'last']);
  });

  it('should refuse a fleet tail that stays unprovable after re-indexing', async () => {
    // Arrange
    const home = await createTemporaryHome();
    const fileSystems = new DisturbedFileSystemFactory();
    const opened = await openStorage(home, fileSystems);
    await opened.storage.append(parseSessionId('unprovable-tail'), 'first', {});
    fileSystems.instance!.blindSlices = true;

    // Act
    const error = await capturedError(async () => await opened.storage.tailEvents());

    // Assert
    should(String(error)).containEql('fleet event index is inconsistent after re-indexing');
  });

  it('should refuse a fleet whose index no longer matches the durable directories it just synchronized', async () => {
    // Arrange
    const home = await createTemporaryHome();
    const indexes = new DisturbedIndexFactory();
    const opened = await openStorage(home, new DisturbedFileSystemFactory(), indexes);
    await opened.storage.append(parseSessionId('forgotten-session'), 'first', {});
    indexes.forgetAfterListings = 0;

    // Act
    const error = await capturedError(async () => await opened.storage.fleetSessionIds());

    // Assert
    should(String(error)).containEql('the fleet index does not exactly match its durable session directories');
  });

  it('should name a session that stopped being one between the survey and its synchronization', async () => {
    // Arrange — surveyed with a config, then reduced to a bare reservation as the survey is read back.
    const home = await createTemporaryHome();
    const indexes = new DisturbedIndexFactory();
    const opened = await openStorage(home, new DisturbedFileSystemFactory(), indexes);
    const id = parseSessionId('stopped-being-a-session');
    await opened.storage.writeConfig(id, { name: 'fleeting' });
    indexes.beforeNextListing = () => rmSync(createSessionPaths(opened.paths, id).config);

    // Act
    const error = await capturedError(async () => await opened.storage.fleetSessionIds());

    // Assert
    should(String(error)).containEql(`session ${id} has durable directory evidence but could not be indexed`);
  });
});
