import {
  type AnalyticsIndexStore,
  type AnalyticsIngestedMarker,
  type AnalyticsStorePersister,
  type AnalyticsStoredSession,
  type AnalyticsStoreStatus,
  type AnalyticsStoreWrites,
  hasAnalyticsWrites,
  mergeAnalyticsWrites,
  NO_ANALYTICS_WRITES,
} from '../../lib/index.ts';
import { WriteBehindQueue, type WriteBehindOptions } from '../storage/write-behind-queue.ts';

/**
 * The analytics store answered from memory, with every write persisted behind it.
 *
 * Reads and writes are the copy in memory's — synchronous, as the port is, and without one byte of disk
 * IO. Each write is queued, merged with the writes it supersedes ({@link mergeAnalyticsWrites}), and handed
 * to the {@link AnalyticsStorePersister} in a batch, one batch at a time, each one a single transaction on
 * the file.
 *
 * WHAT A CRASH CAN LOSE. The writes still queued — at most a batch window and the batch in flight — and,
 * if the disk is slow, whatever that disk has not taken. That is safe because the store was always
 * disposable (see {@link AnalyticsIndexStore}): every row is derived from a session's own durable
 * documents, and the next boot's sweep compares each stored row's signature with the session's evidence
 * and writes again every one that is missing or behind. A crash between a session ending and its row
 * reaching the file costs one re-ingestion of that session, and the answers in the meantime are the
 * memory copy's, which already held the row. `close` persists what is queued.
 */
export class WriteBehindAnalyticsStore implements AnalyticsIndexStore {
  readonly #queue: WriteBehindQueue<AnalyticsStoreWrites>;
  #closed = false;

  constructor(
    private readonly memory: AnalyticsIndexStore,
    private readonly persister: AnalyticsStorePersister,
    options: WriteBehindOptions = {},
  ) {
    this.#queue = new WriteBehindQueue(
      {
        merge: mergeAnalyticsWrites,
        empty: NO_ANALYTICS_WRITES,
        isEmpty: writes => !hasAnalyticsWrites(writes),
        persist: writes => this.persister.persist(writes),
      },
      options,
    );
  }

  /** The writes queued and not yet sent. */
  get pendingWrites(): AnalyticsStoreWrites {
    return this.#queue.pending;
  }

  upsert(rows: readonly AnalyticsStoredSession[]): void {
    this.memory.upsert(rows);
    this.#queue.push({ ...NO_ANALYTICS_WRITES, upserts: rows });
  }

  forget(ids: readonly string[]): void {
    this.memory.forget(ids);
    this.#queue.push({ ...NO_ANALYTICS_WRITES, forgets: ids });
  }

  drop(): void {
    this.memory.drop();
    this.#queue.push({ ...NO_ANALYTICS_WRITES, drop: true });
  }

  ingested(): ReadonlyMap<string, AnalyticsIngestedMarker> {
    return this.memory.ingested();
  }

  rows(): readonly AnalyticsStoredSession[] {
    return this.memory.rows();
  }

  status(): AnalyticsStoreStatus {
    return this.memory.status();
  }

  /** Persists everything queued — once more after a failure, then gives up — and closes both copies. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#queue.drain();
    } finally {
      try {
        await this.persister.close();
      } finally {
        await this.memory.close();
      }
    }
  }
}
