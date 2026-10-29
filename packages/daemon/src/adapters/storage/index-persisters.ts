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
import { type IndexLoad, loadIndexFile, openIndexFile } from './sqlite-index-schema.ts';
import { applyIndexWrites, configureIndexConnection } from './sqlite-index-statements.ts';

/** The session index file: loaded once at boot, then written behind the copy in memory. */
export interface IndexFile extends IndexPersister {
  /** Checks, creates or migrates the file and returns it whole — or `drop` when it must be deleted first. */
  load(): Promise<IndexLoad>;
}

/** Who owns the index file at `file`. */
export interface IndexFileFactory {
  create(file: string): IndexFile;
}

/**
 * The file loaded and written on the calling thread, through a connection opened when first needed.
 *
 * The fallback, and what tests use: under a saturated disk it blocks the event loop for as long as each
 * commit takes, which is exactly what {@link WorkerIndexFile} exists to prevent.
 */
export class InlineIndexFile implements IndexFile {
  #database: Database | undefined;
  #closed = false;

  constructor(
    private readonly file: string,
    private readonly open: (file: string) => Database = openIndexFile,
  ) {}

  async load(): Promise<IndexLoad> {
    this.#release();
    const load = loadIndexFile(this.#connection());
    if (load.kind === 'drop') this.#release();
    return load;
  }

  async persist(writes: readonly IndexWrite[]): Promise<void> {
    applyIndexWrites(this.#connection(), writes);
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#database === undefined) return;
    try {
      this.#database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      this.#release();
    }
  }

  #connection(): Database {
    if (this.#closed) throw new Error('the session index was closed');
    if (this.#database === undefined) {
      this.#database = this.open(this.file);
      configureIndexConnection(this.#database);
    }
    return this.#database;
  }

  #release(): void {
    this.#database?.close();
    this.#database = undefined;
  }
}

/** The main thread's own connection to the file: the fallback, and what tests use. */
export const INLINE_INDEX_FILES: IndexFileFactory = { create: file => new InlineIndexFile(file) };

type IndexWriterValue = IndexLoad | undefined;

/** What the index writer answers, as a request's answer; a probe reply answers nothing. */
function indexWriterAnswer(message: IndexWriterResponse): HostedAnswer<IndexWriterValue> | undefined {
  if ('probe' in message) return undefined;
  return message.ok
    ? { id: message.id, ok: true, value: message.load }
    : { id: message.id, ok: false, error: new Error(`the session index could not be written: ${message.error}`) };
}

/**
 * Five minutes, because a slow disk is not a stuck thread: a checkpoint measured 38 s on the owner's
 * saturated disk, and a thread replaced mid-commit only makes the next one wait for its lock.
 */
const REQUEST_TIMEOUT_MS = 5 * 60_000;
/** The thread holds one connection; keeping it for the daemon's life costs a few megabytes. */
const IDLE_MS = 24 * 60 * 60_000;
const INDEX_WRITER_RESTART: WorkerRestartPolicy = {
  backoffMs: 1_000,
  maxBackoffMs: 30_000,
  maxFailures: 5,
  windowMs: 10 * 60_000,
};

export interface WorkerIndexFileOptions {
  readonly spawn?: () => HostedWorker<IndexWriterRequest, IndexWriterResponse>;
  readonly timeoutMs?: number;
  readonly restart?: WorkerRestartPolicy;
  /** Told once, when the thread is retired and the file is written on the main thread. */
  readonly retired?: () => void;
}

const spawnBundled = (): HostedWorker<IndexWriterRequest, IndexWriterResponse> =>
  new LoadSafeWorker(bundledWorkerUrl('session-index'), { type: 'module' });

/**
 * The file loaded and written on the index-writer thread, which owns its own connection to it.
 *
 * A thread that fails is replaced after a back-off, and the batch it held is refused: the write-behind
 * index keeps it and sends it again, so a failure delays the file and loses nothing. Only once the
 * thread is RETIRED — too many failures in a window — do batches go to the main thread's connection
 * (`fallback`), because correctness never depends on a worker. While it is merely backing off they do
 * not: a thread replaced mid-commit may still hold the file's write lock, and a main-thread write
 * waiting on that lock would be the very stall this exists to remove. A boot whose thread cannot load
 * the file loads it on the main thread instead: a daemon that cannot open its index cannot start.
 */
export class WorkerIndexFile implements IndexFile {
  readonly #host: BundledWorkerHost<IndexWriterRequest, IndexWriterResponse, IndexWriterValue>;

  constructor(
    file: string,
    private readonly fallback: IndexFile,
    options: WorkerIndexFileOptions = {},
  ) {
    this.#host = new BundledWorkerHost({
      label: 'the session index writer',
      spawn: options.spawn ?? spawnBundled,
      answer: indexWriterAnswer,
      greeting: () => ({ kind: 'open', file }),
      timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
      idleMs: () => IDLE_MS,
      restart: options.restart ?? INDEX_WRITER_RESTART,
      ...(options.retired === undefined ? {} : { retired: options.retired }),
    });
  }

  /** Whether the thread was retired, and the file is now written on the main thread. */
  get retired(): boolean {
    return this.#host.retired;
  }

  async load(): Promise<IndexLoad> {
    try {
      const id = this.#host.nextId();
      const load = await this.#host.request(id, { kind: 'load', id }, 'load the session index');
      if (load !== undefined) return load;
    } catch {
      // Whatever kept the thread from loading, the main thread's connection is the answer to it.
    }
    return await this.fallback.load();
  }

  async persist(writes: readonly IndexWrite[]): Promise<void> {
    if (this.#host.retired) return await this.fallback.persist(writes);
    const id = this.#host.nextId();
    await this.#host.request(id, { kind: 'persist', id, writes }, 'persist a batch of index writes');
  }

  /** The thread checkpoints and closes its connection, then the main thread's, if one was opened. */
  async close(): Promise<void> {
    try {
      if (this.#host.available) {
        const id = this.#host.nextId();
        await this.#host.request(id, { kind: 'close', id }, 'close the session index');
      }
    } catch {
      // A thread that cannot close leaves a log the next open folds in anyway.
    } finally {
      this.#host.close();
      await this.fallback.close();
    }
  }
}
