import { Database } from 'bun:sqlite';
import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  BunSqliteIndex,
  BunSqliteIndexFactory,
  InlineIndexPersister,
  StateFileSystem,
  WorkerIndexPersister,
  WriteBehindSessionIndex,
} from '../../src/adapters/index.ts';
import type { HostedWorker } from '../../src/adapters/runtime/bundled-worker-host.ts';
import {
  type IndexWriterRequest,
  type IndexWriterResponse,
  type IndexWriterScope,
  serveIndexWriter,
} from '../../src/adapters/storage/index-writer-program.ts';
import { applyIndexWrite, replaceSessionRows } from '../../src/adapters/storage/sqlite-index-statements.ts';
import {
  createFoundationPaths,
  type EventPointer,
  type FoundationPaths,
  type IndexedSession,
  type IndexPersister,
  type IndexWrite,
  parseSessionId,
  resolveStateHome,
} from '../../src/lib/index.ts';

const directories = new Set<string>();

afterEach(async () => {
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
  directories.clear();
});

async function temporaryPaths(): Promise<FoundationPaths> {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-write-behind-'));
  directories.add(home);
  return createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: '/home-must-not-be-used' }));
}

const A = parseSessionId('session-a');
const B = parseSessionId('session-b');

function session(id = A, lastSequence = 1): IndexedSession {
  return { id, status: 'running', lastSequence, journalLine: lastSequence + 1, journal: null };
}

function pointer(sequence: number, id = A, byteLength = 10): EventPointer {
  return {
    sessionId: id,
    sequence,
    time: `2026-10-29T06:00:0${String(sequence)}.000Z`,
    type: 'session.output',
    byteOffset: sequence * 10,
    byteLength,
  };
}

const pointers = (count: number, id = A): readonly EventPointer[] =>
  Array.from({ length: count }, (_, index) => pointer(index + 1, id));

/** A file-backed index's tables, opened once, as the open would leave them. */
async function indexFile(): Promise<{ readonly paths: FoundationPaths; readonly database: Database }> {
  const paths = await temporaryPaths();
  const fileSystem = new StateFileSystem(paths);
  await fileSystem.ensureDirectory(paths.home, 0o700);
  await (await new BunSqliteIndexFactory().open(paths, fileSystem)).close();
  const database = new Database(paths.sessionIndex, { strict: true });
  database.exec('PRAGMA foreign_keys = ON');
  return { paths, database };
}

function sequencesIn(database: Database, id = A): readonly number[] {
  return database
    .query<{ sequence: number }, [string]>('SELECT sequence FROM events WHERE session_id = ? ORDER BY sequence')
    .all(id)
    .map(row => row.sequence);
}

/** Records every batch; fails the next `failures` of them. */
class RecordingPersister implements IndexPersister {
  readonly batches: (readonly IndexWrite[])[] = [];
  closed = 0;
  failures = 0;
  #release: (() => void) | undefined;
  hold = false;

  async persist(writes: readonly IndexWrite[]): Promise<void> {
    if (this.hold) await new Promise<void>(resolve => (this.#release = resolve));
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('disk said no');
    }
    this.batches.push(writes);
  }

  release(): void {
    this.hold = false;
    this.#release?.();
  }

  async close(): Promise<void> {
    this.closed += 1;
  }
}

function memoryIndex(): BunSqliteIndex {
  const database = new Database(':memory:', { strict: true });
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT, created_at TEXT, updated_at TEXT,
      last_sequence INTEGER NOT NULL, journal_line INTEGER NOT NULL, journal_device TEXT, journal_inode TEXT,
      journal_size INTEGER, journal_mtime_ms INTEGER);
    CREATE TABLE events (session_id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK (sequence > 0), time TEXT NOT NULL,
      type TEXT NOT NULL, byte_offset INTEGER NOT NULL, byte_length INTEGER NOT NULL CHECK (byte_length > 0),
      PRIMARY KEY (session_id, sequence), FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE);
  `);
  return new BunSqliteIndex(database);
}

const settle = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));

describe('WriteBehindSessionIndex', () => {
  it('should answer reads from memory at once and persist the writes behind them in one batch', async () => {
    // Arrange
    const persister = new RecordingPersister();
    const subject = new WriteBehindSessionIndex(memoryIndex(), persister, { batchMs: 5 });

    // Act
    subject.replaceSession(session(A, 2), pointers(2));
    subject.appendEvent(session(A, 3), pointer(3));
    subject.refreshSession(session(B, 0));
    const before = persister.batches.length;
    const read = {
      found: subject.findSession(A)?.lastSequence,
      listed: subject.listSessions().map(row => row.id),
      tail: subject.eventPointers(A, 1, 10).map(row => row.sequence),
      fleet: subject.fleetEventPointers(2).map(row => row.sequence),
      count: subject.countEvents(A),
      pending: subject.pendingWrites,
    };
    await settle(40);

    // Assert — the session's two writes became one; the other session's stayed its own.
    should(before).equal(0);
    should(read).deepEqual({ found: 3, listed: [B, A], tail: [2, 3], fleet: [2, 3], count: 3, pending: 2 });
    should(persister.batches).deepEqual([
      [
        { kind: 'replace-session', session: session(A, 3), events: pointers(3) },
        { kind: 'refresh-session', session: session(B, 0) },
      ],
    ]);
    should(subject.pendingWrites).equal(0);
    await subject.close();
  });

  it('should never queue a write the copy in memory refused', async () => {
    // Arrange
    const persister = new RecordingPersister();
    const subject = new WriteBehindSessionIndex(memoryIndex(), persister, { batchMs: 5 });
    subject.appendEvents(session(A, 1), [pointer(1)]);

    // Act — the same pointer again is a conflict.
    let refused = false;
    try {
      subject.appendEvents(session(A, 1), [pointer(1)]);
    } catch {
      refused = true;
    }
    await subject.close();

    // Assert
    should(refused).be.true();
    should(persister.batches).deepEqual([[{ kind: 'append-events', session: session(A, 1), events: [pointer(1)] }]]);
  });

  it('should keep a batch that failed, report it, and send it again with what queued behind it', async () => {
    // Arrange
    const persister = new RecordingPersister();
    persister.failures = 1;
    const failures: string[] = [];
    const subject = new WriteBehindSessionIndex(memoryIndex(), persister, {
      batchMs: 5,
      retryMs: 20,
      persistFailed: error => failures.push(error.message),
    });

    // Act
    subject.replaceSession(session(A, 1), pointers(1));
    await settle(12);
    subject.removeSession(B);
    await settle(60);

    // Assert
    should(failures).deepEqual(['disk said no']);
    should(persister.batches).deepEqual([
      [
        { kind: 'replace-session', session: session(A, 1), events: pointers(1) },
        { kind: 'remove-session', id: B },
      ],
    ]);
    await subject.close();
  });

  it('should send the writes that queued during a batch once it lands', async () => {
    // Arrange
    const persister = new RecordingPersister();
    persister.hold = true;
    const subject = new WriteBehindSessionIndex(memoryIndex(), persister, { batchMs: 5 });
    subject.replaceSession(session(A, 1), pointers(1));
    await settle(15);

    // Act
    subject.replaceAll({ sessions: [session(B, 0)], events: [], problems: [] });
    persister.release();
    await settle(40);

    // Assert
    should(persister.batches).deepEqual([
      [{ kind: 'replace-session', session: session(A, 1), events: pointers(1) }],
      [{ kind: 'replace-all', sessions: [session(B, 0)], events: [] }],
    ]);
    await subject.close();
  });

  it('should persist everything queued on close, waiting for the batch in flight', async () => {
    // Arrange
    const persister = new RecordingPersister();
    persister.hold = true;
    const subject = new WriteBehindSessionIndex(memoryIndex(), persister, { batchMs: 1 });
    subject.replaceSession(session(A, 1), pointers(1));
    await settle(10);
    subject.refreshSession(session(B, 0));

    // Act
    const closing = subject.close();
    persister.release();
    await closing;
    await subject.close();

    // Assert
    should(persister.batches).deepEqual([
      [{ kind: 'replace-session', session: session(A, 1), events: pointers(1) }],
      [{ kind: 'refresh-session', session: session(B, 0) }],
    ]);
    should(persister.closed).equal(1);
  });

  it('should give up on close after a second failure and still close both copies', async () => {
    // Arrange
    const persister = new RecordingPersister();
    persister.failures = 5;
    const failures: string[] = [];
    const subject = new WriteBehindSessionIndex(memoryIndex(), persister, {
      batchMs: 60_000,
      persistFailed: error => failures.push(error.message),
    });
    subject.replaceSession(session(A, 1), pointers(1));

    // Act
    await subject.close();

    // Assert — the write is left to the next boot's reconcile.
    should(failures).deepEqual(['disk said no', 'disk said no']);
    should(persister.closed).equal(1);
    should(subject.pendingWrites).equal(1);
  });

  it('should report a persister that rejects with something other than an Error', async () => {
    // Arrange
    const failures: string[] = [];
    const persister: IndexPersister = {
      persist: () => Promise.reject('no disk'),
      close: async () => undefined,
    };
    const subject = new WriteBehindSessionIndex(memoryIndex(), persister, {
      batchMs: 60_000,
      persistFailed: error => failures.push(error.message),
    });
    subject.removeSession(A);

    // Act
    await subject.close();

    // Assert
    should(failures).deepEqual(['no disk', 'no disk']);
  });
});

describe('the index SQL', () => {
  it('should replace a session by difference, rewriting only the pointers that changed', async () => {
    // Arrange
    const { database } = await indexFile();
    replaceSessionRows(database, session(A, 4), pointers(4), 'strict');
    const before = database.query<{ changes: number }, []>('SELECT total_changes() AS changes').get()?.changes ?? 0;

    // Act — 1 and 2 unchanged, 3 changed, 4 gone, 5 new.
    replaceSessionRows(database, session(A, 5), [pointer(1), pointer(2), pointer(3, A, 99), pointer(5)], 'strict');
    const after = database.query<{ changes: number }, []>('SELECT total_changes() AS changes').get()?.changes ?? 0;
    const third = database
      .query<
        { byte_length: number },
        []
      >("SELECT byte_length FROM events WHERE session_id = 'session-a' AND sequence = 3")
      .get()?.byte_length;

    // Assert — the session row, two deletions (3 and 4) and two insertions (3 and 5).
    should(sequencesIn(database)).deepEqual([1, 2, 3, 5]);
    should(third).equal(99);
    should(after - before).equal(5);
    database.close();
  });

  it('should refuse a repeated pointer in strict mode and overwrite it when idempotent', async () => {
    // Arrange
    const { database } = await indexFile();
    const write: IndexWrite = { kind: 'append-events', session: session(A, 1), events: [pointer(1)] };
    applyIndexWrite(database, write, 'strict');

    // Act
    let strict: unknown;
    try {
      applyIndexWrite(database, write, 'strict');
    } catch (error) {
      strict = error;
    }
    applyIndexWrite(database, write, 'idempotent');
    replaceSessionRows(database, session(A, 1), [pointer(1), pointer(1, A, 7)], 'idempotent');

    // Assert
    should(strict).be.instanceOf(Error);
    should(sequencesIn(database)).deepEqual([1]);
    database.close();
  });

  it('should write a pointer another session owns as it is given', async () => {
    // Arrange
    const { database } = await indexFile();
    applyIndexWrite(database, { kind: 'refresh-session', session: session(B, 1) }, 'strict');

    // Act
    replaceSessionRows(database, session(A, 1), [pointer(1), pointer(1, B)], 'strict');

    // Assert
    should(sequencesIn(database, A)).deepEqual([1]);
    should(sequencesIn(database, B)).deepEqual([1]);
    database.close();
  });
});

describe('InlineIndexPersister', () => {
  it('should apply each batch in one transaction and refuse batches once closed', async () => {
    // Arrange
    const { database } = await indexFile();
    const subject = new InlineIndexPersister(database);

    // Act
    await subject.persist([
      { kind: 'replace-all', sessions: [session(A, 2)], events: pointers(2) },
      { kind: 'remove-session', id: B },
    ]);
    const persisted = sequencesIn(database);
    await subject.close();
    await subject.close();
    let refused: unknown;
    try {
      await subject.persist([]);
    } catch (error) {
      refused = error;
    }

    // Assert
    should(persisted).deepEqual([1, 2]);
    should(String(refused)).containEql('closed');
  });
});

/** The index writer's program served in this thread, behind the part of a Worker a host uses. */
function inProcessWriter(
  open: (file: string) => Database,
): HostedWorker<IndexWriterRequest, IndexWriterResponse> & { terminated: boolean } {
  const scope: IndexWriterScope = { onmessage: null, postMessage: () => undefined };
  const worker = {
    onmessage: null as ((event: MessageEvent<IndexWriterResponse>) => void) | null,
    onerror: null as ((event: ErrorEvent) => void) | null,
    terminated: false,
    postMessage: (message: IndexWriterRequest) => {
      queueMicrotask(() => scope.onmessage?.({ data: message } as unknown as MessageEvent<IndexWriterRequest>));
    },
    terminate: () => {
      worker.terminated = true;
    },
  };
  scope.postMessage = message => worker.onmessage?.({ data: message } as unknown as MessageEvent<IndexWriterResponse>);
  serveIndexWriter(scope, open);
  return worker;
}

describe('the index writer program', () => {
  it('should answer a probe, refuse a write before it is opened, and say why a batch failed', async () => {
    // Arrange
    const answers: IndexWriterResponse[] = [];
    const scope: IndexWriterScope = { onmessage: null, postMessage: message => answers.push(message) };
    const { paths, database } = await indexFile();
    database.close();
    serveIndexWriter(scope, file => new Database(file, { strict: true }));
    const send = (data: IndexWriterRequest): void =>
      scope.onmessage?.({ data } as unknown as MessageEvent<IndexWriterRequest>);

    // Act
    send({ probe: true });
    send({ kind: 'persist', id: 1, writes: [] });
    send({ kind: 'open', file: paths.sessionIndex });
    send({
      kind: 'persist',
      id: 2,
      writes: [{ kind: 'append-events', session: session(A, 1), events: [pointer(1, A, 0)] }],
    });
    send({ kind: 'close', id: 3 });

    // Assert
    should(answers[0]).deepEqual({ probe: true });
    should(answers[1]).match({ id: 1, ok: false, error: /before it was opened/ });
    should(answers[2]).match({ id: 2, ok: false, error: /CHECK constraint failed/ });
    should(answers[3]).deepEqual({ id: 3, ok: true });
  });

  it('should quote a failure that is not an Error as it was thrown', () => {
    // Arrange
    const answers: IndexWriterResponse[] = [];
    const scope: IndexWriterScope = { onmessage: null, postMessage: message => answers.push(message) };
    const throwing = {
      exec: () => undefined,
      transaction: () => () => {
        throw 'the disk is gone';
      },
    } as unknown as Database;
    serveIndexWriter(scope, () => throwing);

    // Act
    scope.onmessage?.({ data: { kind: 'open', file: 'unused' } } as unknown as MessageEvent<IndexWriterRequest>);
    scope.onmessage?.({ data: { kind: 'persist', id: 1, writes: [] } } as unknown as MessageEvent<IndexWriterRequest>);

    // Assert
    should(answers).deepEqual([{ id: 1, ok: false, error: 'the disk is gone' }]);
  });
});

describe('WorkerIndexPersister', () => {
  it('should persist each batch on the writer and close it before the fallback connection', async () => {
    // Arrange
    const { paths, database } = await indexFile();
    const fallback = new RecordingPersister();
    const worker = inProcessWriter(file => new Database(file, { strict: true }));
    const subject = new WorkerIndexPersister(paths.sessionIndex, fallback, { spawn: () => worker });

    // Act
    await subject.persist([{ kind: 'replace-session', session: session(A, 2), events: pointers(2) }]);
    const persisted = sequencesIn(database);
    await subject.close();

    // Assert
    should(persisted).deepEqual([1, 2]);
    should(fallback.batches).deepEqual([]);
    should(fallback.closed).equal(1);
    should(subject.retired).be.false();
    should(worker.terminated).be.true();
    database.close();
  });

  it('should refuse a batch the writer could not apply, and retire to the fallback after repeated failures', async () => {
    // Arrange
    const { paths, database } = await indexFile();
    const fallback = new RecordingPersister();
    let retired = 0;
    const subject = new WorkerIndexPersister(paths.sessionIndex, fallback, {
      // A thread that never answers: stuck on a disk that never returns.
      spawn: () => ({ onmessage: null, onerror: null, postMessage: () => undefined, terminate: () => undefined }),
      timeoutMs: 20,
      restart: { backoffMs: 0, maxBackoffMs: 0, maxFailures: 1, windowMs: 60_000 },
      retired: () => (retired += 1),
    });
    const bad: IndexWrite = { kind: 'append-events', session: session(A, 1), events: [pointer(1, A, 0)] };
    const good: IndexWrite = { kind: 'remove-session', id: A };

    // Act
    let refused: unknown;
    try {
      await subject.persist([bad]);
    } catch (error) {
      refused = error;
    }
    await subject.persist([good]);
    await subject.close();

    // Assert
    should(String(refused)).containEql('did not persist a batch of index writes within 20 ms');
    should(retired).equal(1);
    should(subject.retired).be.true();
    should(fallback.batches).deepEqual([[good]]);
    should(fallback.closed).equal(1);
    database.close();
  });

  it('should say why the writer refused a batch, and close the fallback even when the writer cannot close', async () => {
    // Arrange
    const { paths, database } = await indexFile();
    database.close();
    const fallback = new RecordingPersister();
    let opened: Database | undefined;
    const subject = new WorkerIndexPersister(paths.sessionIndex, fallback, {
      spawn: () =>
        inProcessWriter(file => {
          opened = new Database(file, { strict: true });
          return opened;
        }),
    });

    // Act
    let refused: unknown;
    try {
      await subject.persist([{ kind: 'append-events', session: session(A, 1), events: [pointer(1, A, 0)] }]);
    } catch (error) {
      refused = error;
    }
    opened?.close();
    await subject.close();

    // Assert
    should(String(refused)).containEql('the session index could not be written: CHECK constraint failed');
    should(fallback.closed).equal(1);
  });

  it('should write the file through the real bundled writer thread', async () => {
    // Arrange
    const { paths, database } = await indexFile();
    const subject = new WorkerIndexPersister(paths.sessionIndex, new InlineIndexPersister(database));

    // Act
    await subject.persist([{ kind: 'replace-session', session: session(A, 3), events: pointers(3) }]);
    await subject.close();
    const reopened = new Database(paths.sessionIndex, { readonly: true, strict: true });
    const persisted = sequencesIn(reopened);
    reopened.close();

    // Assert
    should(persisted).deepEqual([1, 2, 3]);
  });
});

describe('BunSqliteIndexFactory', () => {
  it('should load a WAL file into memory and persist what changed through its persister', async () => {
    // Arrange — a file left in WAL mode by an earlier daemon, with rows only in its log.
    const { paths, database } = await indexFile();
    database.exec('PRAGMA journal_mode = WAL');
    database.exec('PRAGMA wal_autocheckpoint = 0');
    applyIndexWrite(database, { kind: 'append-events', session: session(A, 1), events: [pointer(1)] }, 'strict');
    const fileSystem = new StateFileSystem(paths);

    // Act
    const index = await new BunSqliteIndexFactory(undefined, { batchMs: 5 }).open(paths, fileSystem);
    database.close();
    const loaded = index.countEvents(A);
    index.appendEvents(session(A, 2), [pointer(2)]);
    await index.close();
    const reopened = new Database(paths.sessionIndex, { readonly: true, strict: true });
    const persisted = sequencesIn(reopened);
    reopened.close();

    // Assert
    should(loaded).equal(1);
    should(persisted).deepEqual([1, 2]);
  });
});
