import type { Database } from 'bun:sqlite';
import type { IndexPersister, IndexWrite } from '../../lib/index.ts';
import { bundledWorkerUrl } from '../runtime/bundled-worker.ts';
import {
  BundledWorkerHost,
  type HostedAnswer,
  type HostedWorker,
  type WorkerRestartPolicy,
} from '../runtime/bundled-worker-host.ts';
import { LoadSafeWorker } from '../runtime/load-safe-worker.ts';
import type { IndexWriterRequest, IndexWriterResponse } from './index-writer-program.ts';
import { applyIndexWrites } from './sqlite-index-statements.ts';

/**
 * Each batch applied on the calling thread, through a connection it was given.
 *
 * The fallback, and what tests use: under a saturated disk it blocks the event loop for as long as the
 * commit takes, which is exactly what {@link WorkerIndexPersister} exists to prevent.
 */
export class InlineIndexPersister implements IndexPersister {
  #closed = false;

  constructor(private readonly database: Database) {}

  async persist(writes: readonly IndexWrite[]): Promise<void> {
    if (this.#closed) throw new Error('the session index was closed');
    applyIndexWrites(this.database, writes);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      this.database.close();
    }
  }
}

/** What the index writer answers, as a request's answer; a probe reply answers nothing. */
function indexWriterAnswer(message: IndexWriterResponse): HostedAnswer<undefined> | undefined {
  if ('probe' in message) return undefined;
  return message.ok
    ? { id: message.id, ok: true, value: undefined }
    : { id: message.id, ok: false, error: new Error(`the session index could not be written: ${message.error}`) };
}

/**
 * Five minutes, because a slow disk is not a stuck thread: a checkpoint measured 38 s on the owner's
 * saturated disk, and a thread replaced mid-commit only makes the next one wait for its lock.
 */
const PERSIST_TIMEOUT_MS = 5 * 60_000;
/** The thread holds one connection; keeping it for the daemon's life costs a few megabytes. */
const IDLE_MS = 24 * 60 * 60_000;
const INDEX_WRITER_RESTART: WorkerRestartPolicy = {
  backoffMs: 1_000,
  maxBackoffMs: 30_000,
  maxFailures: 5,
  windowMs: 10 * 60_000,
};

export interface WorkerIndexPersisterOptions {
  readonly spawn?: () => HostedWorker<IndexWriterRequest, IndexWriterResponse>;
  readonly timeoutMs?: number;
  readonly restart?: WorkerRestartPolicy;
  /** Told once, when the thread is retired and every batch is written on the main thread. */
  readonly retired?: () => void;
}

const spawnBundled = (): HostedWorker<IndexWriterRequest, IndexWriterResponse> =>
  new LoadSafeWorker(bundledWorkerUrl('session-index'), { type: 'module' });

/**
 * Each batch applied on the index-writer thread, which owns its own connection to the file.
 *
 * A thread that fails is replaced after a back-off, and the batch it held is refused: the write-behind
 * index keeps it and sends it again, so a failure delays the file and loses nothing. Only once the
 * thread is RETIRED — too many failures in a window — do batches go to the main thread's connection
 * (`fallback`), because correctness never depends on a worker. While it is merely backing off they do
 * not: a thread replaced mid-commit may still hold the file's write lock, and a main-thread write
 * waiting on that lock would be the very stall this exists to remove.
 */
export class WorkerIndexPersister implements IndexPersister {
  readonly #host: BundledWorkerHost<IndexWriterRequest, IndexWriterResponse, undefined>;

  constructor(
    file: string,
    private readonly fallback: IndexPersister,
    options: WorkerIndexPersisterOptions = {},
  ) {
    this.#host = new BundledWorkerHost({
      label: 'the session index writer',
      spawn: options.spawn ?? spawnBundled,
      answer: indexWriterAnswer,
      greeting: () => ({ kind: 'open', file }),
      timeoutMs: options.timeoutMs ?? PERSIST_TIMEOUT_MS,
      idleMs: () => IDLE_MS,
      restart: options.restart ?? INDEX_WRITER_RESTART,
      ...(options.retired === undefined ? {} : { retired: options.retired }),
    });
  }

  /** Whether the thread was retired, and every batch is now written on the main thread. */
  get retired(): boolean {
    return this.#host.retired;
  }

  async persist(writes: readonly IndexWrite[]): Promise<void> {
    if (this.#host.retired) return await this.fallback.persist(writes);
    const id = this.#host.nextId();
    await this.#host.request(id, { kind: 'persist', id, writes }, 'persist a batch of index writes');
  }

  /** The thread checkpoints and closes its connection, then the main thread's is closed. */
  async close(): Promise<void> {
    try {
      if (this.#host.available) {
        const id = this.#host.nextId();
        await this.#host.request(id, { kind: 'close', id }, 'close the session index');
      }
    } catch {
      // A thread that cannot close leaves a log the main thread's checkpoint below folds in anyway.
    } finally {
      this.#host.close();
      await this.fallback.close();
    }
  }
}
