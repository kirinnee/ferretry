import { afterEach, describe, it } from 'bun:test';
import { appendFile, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
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
  SqliteHomeLockFactory,
  StateFileSystem,
  StateHomeLayout,
  SystemClock,
} from '../../src/adapters/index.ts';
import {
  createSessionEvent,
  createSessionPaths,
  encodeSessionEvent,
  type FileSystemFactory,
  type FileSystemPort,
  type FoundationPaths,
  parseSessionId,
} from '../../src/lib/index.ts';

interface ChunkRead {
  readonly path: string;
  readonly offset: number;
  bytes: number;
}

interface SliceRead {
  readonly path: string;
  readonly offset: number;
  readonly bytes: number;
}

class CountingStateFileSystem extends StateFileSystem {
  readonly chunkReads: ChunkRead[] = [];
  readonly sliceReads: SliceRead[] = [];
  failChunkPath: string | undefined;

  resetJournalReads(): void {
    this.chunkReads.length = 0;
    this.sliceReads.length = 0;
    this.failChunkPath = undefined;
  }

  override async *readChunks(path: string, chunkSize: number, offset = 0): AsyncIterable<Uint8Array> {
    const journalRead = path.endsWith('/events.jsonl');
    const read: ChunkRead = { path, offset, bytes: 0 };
    if (journalRead) this.chunkReads.push(read);
    if (path === this.failChunkPath) throw new Error('injected journal read failure');
    for await (const chunk of super.readChunks(path, chunkSize, offset)) {
      if (journalRead) read.bytes += chunk.byteLength;
      yield chunk;
    }
  }

  override async readSlice(path: string, offset: number, length: number): Promise<Uint8Array | undefined> {
    const bytes = await super.readSlice(path, offset, length);
    if (path.endsWith('/events.jsonl') && bytes !== undefined) {
      this.sliceReads.push({ path, offset, bytes: bytes.byteLength });
    }
    return bytes;
  }
}

class CountingFileSystemFactory implements FileSystemFactory {
  instance: CountingStateFileSystem | undefined;

  create(paths: FoundationPaths): FileSystemPort {
    const fileSystem = new CountingStateFileSystem(paths);
    this.instance = fileSystem;
    return fileSystem;
  }
}

const homes = new Set<string>();
const stores = new Set<DaemonStorage>();

async function createTemporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-reconcile-test-'));
  homes.add(home);
  return home;
}

async function openStorage(home: string, fileSystems: CountingFileSystemFactory): Promise<OpenedDaemonStorage> {
  const clock = new SystemClock(() => new Date('2026-07-30T12:00:00.000Z'));
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

afterEach(async () => {
  for (const storage of stores) await storage.close().catch(() => undefined);
  stores.clear();
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

describe('incremental reconciliation', () => {
  it('should refresh metadata without streaming unchanged journal chunks or replacing pointers', async () => {
    // Arrange
    const home = await createTemporaryHome();
    const fileSystems = new CountingFileSystemFactory();
    const opened = await openStorage(home, fileSystems);
    const fileSystem = fileSystems.instance;
    should(fileSystem).not.be.undefined();
    const id = parseSessionId('unchanged-journal');
    await opened.storage.writeState(id, { status: 'running' });
    await opened.storage.append(id, 'started', { retained: true });
    await writeFile(createSessionPaths(opened.paths, id).state, '{"status":"finished"}\n');
    fileSystem?.resetJournalReads();

    // Act
    const result = await opened.storage.reconcile();
    const chunkReads = fileSystem?.chunkReads.slice();
    const sliceReads = fileSystem?.sliceReads.slice();

    // Assert
    should(chunkReads).deepEqual([]);
    should(sliceReads).have.length(1);
    should(result).deepEqual({ sessionCount: 1, eventCount: 1, problems: [] });
    should(opened.storage.findSession(id)?.status).equal('finished');
    should((await opened.storage.replay(id)).events.map(event => event.type)).deepEqual(['started']);
    await closeStorage(opened.storage);
  });

  it('should verify the prior pointer then stream only a grown journal suffix with absolute problems', async () => {
    // Arrange
    const home = await createTemporaryHome();
    const fileSystems = new CountingFileSystemFactory();
    const opened = await openStorage(home, fileSystems);
    const fileSystem = fileSystems.instance;
    should(fileSystem).not.be.undefined();
    const id = parseSessionId('grown-journal');
    const first = await opened.storage.append(id, 'first', { value: 1 });
    const journal = createSessionPaths(opened.paths, id).events;
    await writeFile(journal, `\nold-malformed-record\n${encodeSessionEvent(first)}\n`);
    await opened.storage.syncSession(id);
    const fromOffset = (await stat(journal)).size;
    const duplicate = createSessionEvent(id, 0, '2026-07-30T12:00:01.000Z', 'duplicate', {});
    const second = createSessionEvent(id, 1, '2026-07-30T12:00:02.000Z', 'second', { value: 2 });
    const malformed = 'not-json\n';
    const duplicateLine = `${encodeSessionEvent(duplicate)}\n`;
    const secondLine = `${encodeSessionEvent(second)}\n`;
    const suffix = `${malformed}${duplicateLine}${secondLine}`;
    await appendFile(journal, suffix);
    fileSystem?.resetJournalReads();

    // Act
    const result = await opened.storage.reconcile();
    const chunkReads = fileSystem?.chunkReads.map(read => ({ offset: read.offset, bytes: read.bytes }));
    const sliceReads = fileSystem?.sliceReads.slice();

    // Assert
    should(chunkReads).deepEqual([{ offset: fromOffset, bytes: Buffer.byteLength(suffix) }]);
    should(sliceReads).have.length(2);
    should(result.sessionCount).equal(1);
    should(result.eventCount).equal(2);
    should(result.problems).deepEqual([
      { file: journal, line: 4, byteOffset: fromOffset, message: 'invalid JSON event record' },
      {
        file: journal,
        line: 5,
        byteOffset: fromOffset + Buffer.byteLength(malformed),
        message: 'event sequence 1 is not greater than 1',
      },
    ]);
    should((await opened.storage.replay(id)).events.map(event => event.type)).deepEqual(['first', 'second']);
    await closeStorage(opened.storage);
  });

  it('should rescan when growth continues a newline-free final record', async () => {
    // Arrange
    const home = await createTemporaryHome();
    const fileSystems = new CountingFileSystemFactory();
    const opened = await openStorage(home, fileSystems);
    const fileSystem = fileSystems.instance;
    should(fileSystem).not.be.undefined();
    const id = parseSessionId('continued-final-record');
    const first = await opened.storage.append(id, 'first', { value: 1 });
    const journal = createSessionPaths(opened.paths, id).events;
    const unterminated = encodeSessionEvent(first);
    await writeFile(journal, unterminated);
    await opened.storage.syncSession(id);
    const continuation = 'continued-on-the-same-line';
    await appendFile(journal, continuation);
    fileSystem?.resetJournalReads();

    // Act
    const result = await opened.storage.reconcile();
    const chunkReads = fileSystem?.chunkReads.map(read => ({ offset: read.offset, bytes: read.bytes }));
    const sliceReads = fileSystem?.sliceReads.slice();

    // Assert
    should(chunkReads).deepEqual([{ offset: 0, bytes: Buffer.byteLength(unterminated + continuation) }]);
    should(sliceReads).have.length(3);
    should(result.sessionCount).equal(1);
    should(result.eventCount).equal(0);
    should(result.problems).deepEqual([
      { file: journal, line: 1, byteOffset: 0, message: 'invalid JSON event record' },
    ]);
    should((await opened.storage.replay(id)).events).deepEqual([]);
    await closeStorage(opened.storage);
  });

  it('should rescan a replaced journal from byte zero and replace stale pointers', async () => {
    // Arrange
    const home = await createTemporaryHome();
    const fileSystems = new CountingFileSystemFactory();
    const opened = await openStorage(home, fileSystems);
    const fileSystem = fileSystems.instance;
    should(fileSystem).not.be.undefined();
    const id = parseSessionId('replaced-journal');
    await opened.storage.append(id, 'old', { value: 1 });
    const journal = createSessionPaths(opened.paths, id).events;
    const replacement = createSessionEvent(id, 0, '2026-07-30T13:00:00.000Z', 'replacement', { value: 2 });
    const replacementText = `${encodeSessionEvent(replacement)}\n`;
    const temporary = join(opened.paths.temporary, 'replacement-events.jsonl');
    await writeFile(temporary, replacementText);
    await rename(temporary, journal);
    fileSystem?.resetJournalReads();

    // Act
    const result = await opened.storage.reconcile();
    const chunkReads = fileSystem?.chunkReads.map(read => ({ offset: read.offset, bytes: read.bytes }));
    const sliceReads = fileSystem?.sliceReads.slice();

    // Assert
    should(chunkReads).deepEqual([{ offset: 0, bytes: Buffer.byteLength(replacementText) }]);
    should(sliceReads).deepEqual([]);
    should(result).deepEqual({ sessionCount: 1, eventCount: 1, problems: [] });
    should((await opened.storage.replay(id)).events.map(event => event.type)).deepEqual(['replacement']);
    await closeStorage(opened.storage);
  });

  it('should isolate a failed rescan and still reconcile healthy sessions', async () => {
    // Arrange
    const home = await createTemporaryHome();
    const fileSystems = new CountingFileSystemFactory();
    const opened = await openStorage(home, fileSystems);
    const fileSystem = fileSystems.instance;
    should(fileSystem).not.be.undefined();
    const failed = parseSessionId('failed-session');
    const healthy = parseSessionId('healthy-session');
    await opened.storage.append(failed, 'preserved', {});
    await opened.storage.append(healthy, 'healthy', {});
    const failedPaths = createSessionPaths(opened.paths, failed);
    const failedBefore = opened.storage.findSession(failed);
    await writeFile(
      failedPaths.events,
      `${encodeSessionEvent(createSessionEvent(failed, 0, '2026-07-30T14:00:00.000Z', 'changed', {}))}\n`,
    );
    await writeFile(createSessionPaths(opened.paths, healthy).state, '{"status":"updated"}\n');
    fileSystem?.resetJournalReads();
    if (fileSystem) fileSystem.failChunkPath = failedPaths.events;

    // Act
    const result = await opened.storage.reconcile();

    // Assert
    should(result.sessionCount).equal(1);
    should(result.eventCount).equal(1);
    should(result.failedSessionIds).deepEqual([failed]);
    should(result.problems.map(problem => problem.message)).deepEqual([
      'session failed-session failed to reconcile and was skipped: injected journal read failure',
    ]);
    should(opened.storage.findSession(failed)).deepEqual(failedBefore);
    should(opened.storage.findSession(healthy)?.status).equal('updated');
    await closeStorage(opened.storage);
  });
});
