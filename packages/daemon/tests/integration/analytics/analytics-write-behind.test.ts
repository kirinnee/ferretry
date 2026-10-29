import { Database } from 'bun:sqlite';
import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  type AnalyticsWriterRequest,
  type AnalyticsWriterResponse,
  type AnalyticsWriterScope,
  serveAnalyticsWriter,
} from '../../../src/adapters/analytics/analytics-writer-program.ts';
import {
  BunSqliteAnalyticsStoreFactory,
  InlineAnalyticsPersister,
  WorkerAnalyticsPersister,
  WriteBehindAnalyticsStore,
} from '../../../src/adapters/analytics/index.ts';
import { StateFileSystem } from '../../../src/adapters/index.ts';
import type { HostedWorker } from '../../../src/adapters/runtime/bundled-worker-host.ts';
import { WriteBehindQueue } from '../../../src/adapters/storage/write-behind-queue.ts';
import {
  type AnalyticsIndexStore,
  type AnalyticsStorePersister,
  type AnalyticsStoreWrites,
  createFoundationPaths,
  type FoundationPaths,
  mergeAnalyticsWrites,
  NO_ANALYTICS_WRITES,
  resolveStateHome,
} from '../../../src/lib/index.ts';
import { refusedSession, storedSession } from '../support/analytics-fixtures.ts';

const directories = new Set<string>();

afterEach(async () => {
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
  directories.clear();
});

async function temporaryPaths(): Promise<FoundationPaths> {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-analytics-write-behind-'));
  directories.add(home);
  return createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: '/home-must-not-be-used' }));
}

/** The analytics file as the factory leaves it, closed, so a test can open its own connection. */
async function analyticsFile(): Promise<FoundationPaths> {
  const paths = await temporaryPaths();
  await (await new BunSqliteAnalyticsStoreFactory().open(paths, new StateFileSystem(paths))).store.close();
  return paths;
}

const idsIn = (database: Database): readonly string[] =>
  database
    .query<{ id: string }, []>('SELECT id FROM analytics_sessions ORDER BY id')
    .all()
    .map(row => row.id);

async function idsOnDisk(paths: FoundationPaths): Promise<readonly string[]> {
  const database = new Database(paths.analyticsIndex, { readonly: true, strict: true });
  try {
    return idsIn(database);
  } finally {
    database.close();
  }
}

const writes = (overrides: Partial<AnalyticsStoreWrites>): AnalyticsStoreWrites => ({
  ...NO_ANALYTICS_WRITES,
  ...overrides,
});

/** Records every batch; fails the next `failures` of them, with whatever `failure` is. */
class RecordingPersister implements AnalyticsStorePersister {
  readonly batches: AnalyticsStoreWrites[] = [];
  closed = 0;
  failures = 0;
  failure: unknown = new Error('disk said no');
  hold = false;
  #release: (() => void) | undefined;

  async persist(batch: AnalyticsStoreWrites): Promise<void> {
    if (this.hold) await new Promise<void>(resolve => (this.#release = resolve));
    if (this.failures > 0) {
      this.failures -= 1;
      throw this.failure;
    }
    this.batches.push(batch);
  }

  release(): void {
    this.hold = false;
    this.#release?.();
  }

  async close(): Promise<void> {
    this.closed += 1;
  }
}

/** An analytics store that is only a memory, for what sits in front of it. */
async function memoryStore(): Promise<AnalyticsIndexStore> {
  const paths = await temporaryPaths();
  const opened = await new BunSqliteAnalyticsStoreFactory().open(paths, new StateFileSystem(paths));
  return opened.store;
}

const settle = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));

const queueOf = (persister: RecordingPersister, options: ConstructorParameters<typeof WriteBehindQueue>[1]) =>
  new WriteBehindQueue<AnalyticsStoreWrites>(
    {
      merge: mergeAnalyticsWrites,
      empty: NO_ANALYTICS_WRITES,
      isEmpty: batch => batch.upserts.length === 0 && batch.forgets.length === 0 && !batch.drop,
      persist: batch => persister.persist(batch),
    },
    options,
  );

describe('WriteBehindQueue', () => {
  it('should send what queued in one window as one batch, and report what is still queued', async () => {
    // Arrange
    const persister = new RecordingPersister();
    const queue = queueOf(persister, { batchMs: 5 });

    // Act
    queue.push(writes({ upserts: [refusedSession('a')] }));
    queue.push(writes({ forgets: ['b'] }));
    const queued = queue.pending;
    await settle(40);

    // Assert
    should(queued).deepEqual(writes({ upserts: [refusedSession('a')], forgets: ['b'] }));
    should(persister.batches).deepEqual([queued]);
    should(queue.pending).equal(NO_ANALYTICS_WRITES);
    await queue.drain();
  });

  it('should keep a batch that failed, report it, and send it again with what queued behind it', async () => {
    // Arrange
    const persister = new RecordingPersister();
    persister.failures = 1;
    const failures: string[] = [];
    const queue = queueOf(persister, { batchMs: 5, retryMs: 20, persistFailed: error => failures.push(error.message) });

    // Act
    queue.push(writes({ upserts: [refusedSession('a')] }));
    await settle(12);
    queue.push(writes({ forgets: ['b'] }));
    await settle(60);

    // Assert
    should(failures).deepEqual(['disk said no']);
    should(persister.batches).deepEqual([writes({ upserts: [refusedSession('a')], forgets: ['b'] })]);
    await queue.drain();
  });

  it('should send the writes that queued during a batch once it lands', async () => {
    // Arrange
    const persister = new RecordingPersister();
    persister.hold = true;
    const queue = queueOf(persister, { batchMs: 5 });
    queue.push(writes({ upserts: [refusedSession('a')] }));
    await settle(15);

    // Act
    queue.push(writes({ forgets: ['b'] }));
    persister.release();
    await settle(40);

    // Assert
    should(persister.batches).deepEqual([writes({ upserts: [refusedSession('a')] }), writes({ forgets: ['b'] })]);
    await queue.drain();
  });

  it('should persist everything queued on drain, waiting for the batch in flight, and drain only once', async () => {
    // Arrange
    const persister = new RecordingPersister();
    persister.hold = true;
    const queue = queueOf(persister, { batchMs: 1 });
    queue.push(writes({ upserts: [refusedSession('a')] }));
    await settle(10);
    queue.push(writes({ forgets: ['b'] }));

    // Act
    const draining = queue.drain();
    persister.release();
    await draining;
    await queue.drain();
    queue.push(writes({ forgets: ['late'] }));

    // Assert — a write after drain is kept but never scheduled.
    should(persister.batches).deepEqual([writes({ upserts: [refusedSession('a')] }), writes({ forgets: ['b'] })]);
    should(queue.pending).deepEqual(writes({ forgets: ['late'] }));
  });

  it('should give up on drain after a second failure, and report a rejection that is not an Error', async () => {
    // Arrange
    const persister = new RecordingPersister();
    persister.failures = 5;
    persister.failure = 'no disk';
    const failures: string[] = [];
    const queue = queueOf(persister, { batchMs: 60_000, persistFailed: error => failures.push(error.message) });
    queue.push(writes({ forgets: ['a'] }));

    // Act
    await queue.drain();

    // Assert
    should(failures).deepEqual(['no disk', 'no disk']);
    should(queue.pending).deepEqual(writes({ forgets: ['a'] }));
  });

  it('should not need a failure callback', async () => {
    // Arrange
    const persister = new RecordingPersister();
    persister.failures = 1;
    const queue = queueOf(persister, { batchMs: 60_000 });
    queue.push(writes({ forgets: ['a'] }));

    // Act
    await queue.drain();

    // Assert — the retry inside drain landed it.
    should(persister.batches).deepEqual([writes({ forgets: ['a'] })]);
  });
});

describe('WriteBehindAnalyticsStore', () => {
  it('should answer reads from memory at once and persist the writes behind them as one batch', async () => {
    // Arrange
    const persister = new RecordingPersister();
    const subject = new WriteBehindAnalyticsStore(await memoryStore(), persister, { batchMs: 5 });

    // Act
    subject.upsert([refusedSession('a'), refusedSession('b')]);
    subject.upsert([refusedSession('a')]);
    subject.forget(['b']);
    const read = {
      ids: subject.rows().map(row => row.raw.id),
      ingested: [...subject.ingested().keys()],
      sessions: subject.status().sessions,
      pending: subject.pendingWrites,
      persisted: persister.batches.length,
    };
    await settle(40);

    // Assert
    should(read).deepEqual({
      ids: ['a'],
      ingested: ['a'],
      sessions: 1,
      pending: writes({ upserts: [refusedSession('a')], forgets: ['b'] }),
      persisted: 0,
    });
    should(persister.batches).deepEqual([writes({ upserts: [refusedSession('a')], forgets: ['b'] })]);
    await subject.close();
  });

  it('should queue a drop, persist what is queued on close, and close both copies once', async () => {
    // Arrange
    const persister = new RecordingPersister();
    const subject = new WriteBehindAnalyticsStore(await memoryStore(), persister, { batchMs: 60_000 });
    subject.upsert([refusedSession('a')]);
    subject.drop();
    subject.upsert([refusedSession('b')]);

    // Act
    const held = subject.rows().map(row => row.raw.id);
    await subject.close();
    await subject.close();

    // Assert
    should(held).deepEqual(['b']);
    should(persister.batches).deepEqual([writes({ drop: true, upserts: [refusedSession('b')] })]);
    should(persister.closed).equal(1);
  });

  it('should close both copies even when the last batch could not be persisted', async () => {
    // Arrange
    const persister = new RecordingPersister();
    persister.failures = 5;
    const failures: string[] = [];
    const subject = new WriteBehindAnalyticsStore(await memoryStore(), persister, {
      batchMs: 60_000,
      persistFailed: error => failures.push(error.message),
    });
    subject.upsert([refusedSession('a')]);

    // Act
    await subject.close();

    // Assert — the row is left to the next boot's sweep.
    should(failures).deepEqual(['disk said no', 'disk said no']);
    should(persister.closed).equal(1);
    should(subject.pendingWrites).deepEqual(writes({ upserts: [refusedSession('a')] }));
  });

  it('should still close the memory copy when the persister cannot close', async () => {
    // Arrange
    const memory = await memoryStore();
    let memoryClosed = 0;
    const persister: AnalyticsStorePersister = {
      persist: async () => undefined,
      close: () => Promise.reject(new Error('close refused')),
    };
    const subject = new WriteBehindAnalyticsStore(
      {
        ...memory,
        close: async () => {
          memoryClosed += 1;
          await memory.close();
        },
      } as AnalyticsIndexStore,
      persister,
    );

    // Act
    let refused: unknown;
    try {
      await subject.close();
    } catch (error) {
      refused = error;
    }

    // Assert
    should(String(refused)).containEql('close refused');
    should(memoryClosed).equal(1);
  });
});

describe('the analytics SQL', () => {
  it('should empty the table, delete, then write, in that order, as one transaction', async () => {
    // Arrange
    const paths = await analyticsFile();
    const database = new Database(paths.analyticsIndex, { strict: true });
    const persister = new InlineAnalyticsPersister(database);
    await persister.persist(writes({ upserts: [refusedSession('a'), refusedSession('b'), refusedSession('c')] }));

    // Act
    await persister.persist(writes({ forgets: ['a'], upserts: [storedSession()] }));
    const afterForget = idsIn(database);
    await persister.persist(writes({ drop: true, upserts: [refusedSession('z')] }));
    const afterDrop = idsIn(database);
    await persister.close();

    // Assert
    should(afterForget).deepEqual(['b', 'c', 's1']);
    should(afterDrop).deepEqual(['z']);
  });

  it('should leave the table as it was when a batch fails half way', async () => {
    // Arrange
    const paths = await analyticsFile();
    const database = new Database(paths.analyticsIndex, { strict: true });
    const persister = new InlineAnalyticsPersister(database);
    await persister.persist(writes({ upserts: [refusedSession('a')] }));
    const poisoned = { ...refusedSession('b'), signature: null };

    // Act
    let refused: unknown;
    try {
      await persister.persist(writes({ drop: true, upserts: [refusedSession('c'), poisoned as never] }));
    } catch (error) {
      refused = error;
    }
    const ids = idsIn(database);
    await persister.close();

    // Assert — the drop and the first upsert were rolled back with the rest.
    should(refused).be.instanceOf(Error);
    should(ids).deepEqual(['a']);
  });
});

describe('InlineAnalyticsPersister', () => {
  it('should checkpoint and close once, and refuse batches once closed', async () => {
    // Arrange
    const paths = await analyticsFile();
    const subject = new InlineAnalyticsPersister(new Database(paths.analyticsIndex, { strict: true }));

    // Act
    await subject.persist(writes({ upserts: [refusedSession('a')] }));
    await subject.close();
    await subject.close();
    let refused: unknown;
    try {
      await subject.persist(writes({ forgets: ['a'] }));
    } catch (error) {
      refused = error;
    }

    // Assert
    should(String(refused)).containEql('closed');
    should(await idsOnDisk(paths)).deepEqual(['a']);
  });
});

describe('the analytics writer program', () => {
  it('should answer a probe, refuse a write before it is opened, and say why a batch failed', async () => {
    // Arrange
    const answers: AnalyticsWriterResponse[] = [];
    const scope: AnalyticsWriterScope = { onmessage: null, postMessage: message => answers.push(message) };
    const paths = await analyticsFile();
    serveAnalyticsWriter(scope, file => new Database(file, { strict: true }));
    const send = (data: AnalyticsWriterRequest): void =>
      scope.onmessage?.({ data } as unknown as MessageEvent<AnalyticsWriterRequest>);
    const poisoned = { ...refusedSession('b'), signature: null } as never;

    // Act
    send({ probe: true });
    send({ kind: 'persist', id: 1, writes: NO_ANALYTICS_WRITES });
    send({ kind: 'open', file: paths.analyticsIndex });
    send({ kind: 'persist', id: 2, writes: writes({ upserts: [refusedSession('a')] }) });
    send({ kind: 'persist', id: 3, writes: writes({ upserts: [poisoned] }) });
    send({ kind: 'close', id: 4 });

    // Assert — a connection per batch: nothing is held open between them.
    should(answers[0]).deepEqual({ probe: true });
    should(answers[1]).match({ id: 1, ok: false, error: /before it was opened/ });
    should(answers[2]).deepEqual({ id: 2, ok: true });
    should(answers[3]).match({ id: 3, ok: false, error: /NOT NULL|constraint|null/i });
    should(answers[4]).deepEqual({ id: 4, ok: true });
    should(await idsOnDisk(paths)).deepEqual(['a']);
  });

  it('should quote a failure that is not an Error as it was thrown', () => {
    // Arrange
    const answers: AnalyticsWriterResponse[] = [];
    const scope: AnalyticsWriterScope = { onmessage: null, postMessage: message => answers.push(message) };
    serveAnalyticsWriter(scope, () => {
      throw 'the disk is gone';
    });

    // Act
    scope.onmessage?.({ data: { kind: 'open', file: 'unused' } } as unknown as MessageEvent<AnalyticsWriterRequest>);
    scope.onmessage?.({
      data: { kind: 'persist', id: 1, writes: NO_ANALYTICS_WRITES },
    } as unknown as MessageEvent<AnalyticsWriterRequest>);

    // Assert
    should(answers).deepEqual([{ id: 1, ok: false, error: 'the disk is gone' }]);
  });
});

/** The analytics writer's program served in this thread, behind the part of a Worker a host uses. */
function inProcessWriter(
  open: (file: string) => Database,
): HostedWorker<AnalyticsWriterRequest, AnalyticsWriterResponse> & { terminated: boolean } {
  const scope: AnalyticsWriterScope = { onmessage: null, postMessage: () => undefined };
  const worker = {
    onmessage: null as ((event: MessageEvent<AnalyticsWriterResponse>) => void) | null,
    onerror: null as ((event: ErrorEvent) => void) | null,
    terminated: false,
    postMessage: (message: AnalyticsWriterRequest) => {
      queueMicrotask(() => scope.onmessage?.({ data: message } as unknown as MessageEvent<AnalyticsWriterRequest>));
    },
    terminate: () => {
      worker.terminated = true;
    },
  };
  scope.postMessage = message =>
    worker.onmessage?.({ data: message } as unknown as MessageEvent<AnalyticsWriterResponse>);
  serveAnalyticsWriter(scope, open);
  return worker;
}

describe('WorkerAnalyticsPersister', () => {
  it('should persist each batch on the writer and close it before the fallback connection', async () => {
    // Arrange
    const paths = await analyticsFile();
    const fallback = new RecordingPersister();
    const worker = inProcessWriter(file => new Database(file, { strict: true }));
    const subject = new WorkerAnalyticsPersister(paths.analyticsIndex, fallback, { spawn: () => worker });

    // Act
    await subject.persist(writes({ upserts: [refusedSession('a'), refusedSession('b')] }));
    const persisted = await idsOnDisk(paths);
    await subject.close();

    // Assert
    should(persisted).deepEqual(['a', 'b']);
    should(fallback.batches).deepEqual([]);
    should(fallback.closed).equal(1);
    should(subject.retired).be.false();
    should(worker.terminated).be.true();
  });

  it('should retire to the fallback after the thread stops answering', async () => {
    // Arrange
    const fallback = new RecordingPersister();
    let retired = 0;
    const subject = new WorkerAnalyticsPersister('unused', fallback, {
      // A thread that never answers: stuck on a disk that never returns.
      spawn: () => ({ onmessage: null, onerror: null, postMessage: () => undefined, terminate: () => undefined }),
      timeoutMs: 20,
      restart: { backoffMs: 0, maxBackoffMs: 0, maxFailures: 1, windowMs: 60_000 },
      retired: () => (retired += 1),
    });
    const batch = writes({ forgets: ['a'] });

    // Act
    let refused: unknown;
    try {
      await subject.persist(batch);
    } catch (error) {
      refused = error;
    }
    await subject.persist(batch);
    await subject.close();

    // Assert
    should(String(refused)).containEql('did not persist a batch of analytics writes within 20 ms');
    should(retired).equal(1);
    should(subject.retired).be.true();
    should(fallback.batches).deepEqual([batch]);
    should(fallback.closed).equal(1);
  });

  it('should say why the writer refused a batch, and close the fallback even when the writer cannot close', async () => {
    // Arrange
    const paths = await analyticsFile();
    const fallback = new RecordingPersister();
    const subject = new WorkerAnalyticsPersister(paths.analyticsIndex, fallback, {
      spawn: () => inProcessWriter(file => new Database(file, { strict: true })),
    });
    const poisoned = { ...refusedSession('b'), signature: null } as never;

    // Act
    let refused: unknown;
    try {
      await subject.persist(writes({ upserts: [poisoned] }));
    } catch (error) {
      refused = error;
    }
    await subject.close();

    // Assert
    should(String(refused)).containEql('the analytics store could not be written:');
    should(fallback.closed).equal(1);
  });

  it('should close the fallback when the writer fails to close', async () => {
    // Arrange
    const paths = await analyticsFile();
    const fallback = new RecordingPersister();
    let opens = 0;
    const subject = new WorkerAnalyticsPersister(paths.analyticsIndex, fallback, {
      spawn: () =>
        inProcessWriter(file => {
          opens += 1;
          if (opens > 1) throw new Error('cannot open for close');
          return new Database(file, { strict: true });
        }),
    });
    await subject.persist(writes({ upserts: [refusedSession('a')] }));

    // Act
    await subject.close();

    // Assert
    should(fallback.closed).equal(1);
  });

  it('should write the file through the real bundled writer thread', async () => {
    // Arrange
    const paths = await analyticsFile();
    const subject = new WorkerAnalyticsPersister(
      paths.analyticsIndex,
      new InlineAnalyticsPersister(new Database(paths.analyticsIndex, { strict: true })),
    );

    // Act
    await subject.persist(writes({ upserts: [refusedSession('a'), refusedSession('b')] }));
    await subject.close();

    // Assert
    should(await idsOnDisk(paths)).deepEqual(['a', 'b']);
  });
});

describe('BunSqliteAnalyticsStoreFactory', () => {
  it('should load a WAL file into memory and persist what changed through its persister', async () => {
    // Arrange — a file left in WAL mode by an earlier daemon, with rows only in its log.
    const paths = await analyticsFile();
    const database = new Database(paths.analyticsIndex, { strict: true });
    database.exec('PRAGMA wal_autocheckpoint = 0');
    new InlineAnalyticsPersister(database);
    const seed = new BunSqliteAnalyticsStoreFactory();
    const first = await seed.open(paths, new StateFileSystem(paths));
    first.store.upsert([refusedSession('a')]);
    await first.store.close();
    database.close();

    // Act
    const factory = new BunSqliteAnalyticsStoreFactory(undefined, { batchMs: 5 });
    const second = await factory.open(paths, new StateFileSystem(paths));
    const loaded = second.store.rows().map(row => row.raw.id);
    second.store.upsert([refusedSession('b')]);
    await second.store.close();

    // Assert
    should(second.rebuildRequired).be.false();
    should(loaded).deepEqual(['a']);
    should(await idsOnDisk(paths)).deepEqual(['a', 'b']);
  });
});
