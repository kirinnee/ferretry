import type { Database } from 'bun:sqlite';
import type { AnalyticsStorePersister, AnalyticsStoreWrites } from '../../lib/index.ts';
import { bundledWorkerUrl } from '../runtime/bundled-worker.ts';
import {
  BundledWorkerHost,
  type HostedAnswer,
  type HostedWorker,
  type WorkerRestartPolicy,
} from '../runtime/bundled-worker-host.ts';
import { LoadSafeWorker } from '../runtime/load-safe-worker.ts';
import type { AnalyticsWriterRequest, AnalyticsWriterResponse } from './analytics-writer-program.ts';
import { applyAnalyticsWrites } from './sqlite-analytics-statements.ts';

/**
 * Each batch applied on the calling thread, through a connection it was given.
 *
 * The fallback, and what tests use: under a saturated disk it blocks the event loop for as long as the
 * commit takes, which is exactly what {@link WorkerAnalyticsPersister} exists to prevent.
 */
export class InlineAnalyticsPersister implements AnalyticsStorePersister {
  #closed = false;

  constructor(private readonly database: Database) {}

  async persist(writes: AnalyticsStoreWrites): Promise<void> {
    if (this.#closed) throw new Error('the analytics store was closed');
    applyAnalyticsWrites(this.database, writes);
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

/** What the analytics writer answers, as a request's answer; a probe reply answers nothing. */
function analyticsWriterAnswer(message: AnalyticsWriterResponse): HostedAnswer<undefined> | undefined {
  if ('probe' in message) return undefined;
  return message.ok
    ? { id: message.id, ok: true, value: undefined }
    : { id: message.id, ok: false, error: new Error(`the analytics store could not be written: ${message.error}`) };
}

/**
 * Five minutes, because a slow disk is not a stuck thread: a checkpoint measured 38 s on the owner's
 * saturated disk, and a thread replaced mid-commit only makes the next one wait for its lock.
 */
const PERSIST_TIMEOUT_MS = 5 * 60_000;
/** The thread holds no connection between batches, so an idle one is ended and its memory returned. */
const IDLE_MS = 60_000;
const ANALYTICS_WRITER_RESTART: WorkerRestartPolicy = {
  backoffMs: 1_000,
  maxBackoffMs: 30_000,
  maxFailures: 5,
  windowMs: 10 * 60_000,
};

export interface WorkerAnalyticsPersisterOptions {
  readonly spawn?: () => HostedWorker<AnalyticsWriterRequest, AnalyticsWriterResponse>;
  readonly timeoutMs?: number;
  readonly idleMs?: number;
  readonly restart?: WorkerRestartPolicy;
  /** Told once, when the thread is retired and every batch is written on the main thread. */
  readonly retired?: () => void;
}

const spawnBundled = (): HostedWorker<AnalyticsWriterRequest, AnalyticsWriterResponse> =>
  new LoadSafeWorker(bundledWorkerUrl('analytics-index'), { type: 'module' });

/**
 * Each batch applied on the analytics-writer thread, which opens its own connection to the file.
 *
 * A thread that fails is replaced after a back-off, and the batch it held is refused: the write-behind
 * store keeps it and sends it again, so a failure delays the file and loses nothing. Only once the thread
 * is RETIRED — too many failures in a window — do batches go to the main thread's connection
 * (`fallback`), because correctness never depends on a worker. While it is merely backing off they do
 * not: a thread replaced mid-commit may still hold the file's write lock, and a main-thread write waiting
 * on that lock would be the very stall this exists to remove.
 *
 * ITS OWN THREAD, NOT THE SESSION INDEX WRITER'S. Sharing one would save a thread that is idle almost
 * always, but a 1.5 s analytics commit would then hold up the session index's durability behind it, a
 * stuck analytics batch would count against the session index writer's failures and could retire it, and
 * the session index's writer would stop being a program that knows one file.
 */
export class WorkerAnalyticsPersister implements AnalyticsStorePersister {
  readonly #host: BundledWorkerHost<AnalyticsWriterRequest, AnalyticsWriterResponse, undefined>;

  constructor(
    file: string,
    private readonly fallback: AnalyticsStorePersister,
    options: WorkerAnalyticsPersisterOptions = {},
  ) {
    this.#host = new BundledWorkerHost({
      label: 'the analytics store writer',
      spawn: options.spawn ?? spawnBundled,
      answer: analyticsWriterAnswer,
      greeting: () => ({ kind: 'open', file }),
      timeoutMs: options.timeoutMs ?? PERSIST_TIMEOUT_MS,
      idleMs: () => options.idleMs ?? IDLE_MS,
      restart: options.restart ?? ANALYTICS_WRITER_RESTART,
      ...(options.retired === undefined ? {} : { retired: options.retired }),
    });
  }

  /** Whether the thread was retired, and every batch is now written on the main thread. */
  get retired(): boolean {
    return this.#host.retired;
  }

  async persist(writes: AnalyticsStoreWrites): Promise<void> {
    if (this.#host.retired) return await this.fallback.persist(writes);
    const id = this.#host.nextId();
    await this.#host.request(id, { kind: 'persist', id, writes }, 'persist a batch of analytics writes');
  }

  /** The thread checkpoints the file, then the main thread's connection is checkpointed and closed. */
  async close(): Promise<void> {
    try {
      if (this.#host.available) {
        const id = this.#host.nextId();
        await this.#host.request(id, { kind: 'close', id }, 'close the analytics store');
      }
    } catch {
      // A thread that cannot close leaves a log the main thread's checkpoint below folds in anyway.
    } finally {
      this.#host.close();
      await this.fallback.close();
    }
  }
}
