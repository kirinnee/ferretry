/**
 * THE ANALYTICS STORE'S WRITES, AS DATA — so they can be queued, merged and carried to the thread that
 * owns the file on disk.
 *
 * The daemon answers every analytics read from memory and persists the same writes behind it, off the
 * event loop, for the reason the session index does (`index-writes.ts`): a commit to a saturated disk ends
 * in an `fsync` that measured seconds, and while it ran nothing else did. Unlike the session index, the
 * analytics store has one table keyed by session id and every write is a REPLACEMENT of whole rows, so the
 * writes collapse into one value: whether the table is emptied first, which rows are written, and which
 * are gone. That is all a batch needs to say, and what makes {@link mergeAnalyticsWrites} total.
 */
import type { AnalyticsStoredSession } from './store.ts';

/**
 * What to do to the table, applied in this order as ONE transaction: empty it when `drop`, then delete
 * `forgets`, then write `upserts`. A session id is in at most one of `forgets` and `upserts`.
 */
export interface AnalyticsStoreWrites {
  readonly drop: boolean;
  readonly upserts: readonly AnalyticsStoredSession[];
  readonly forgets: readonly string[];
}

export const NO_ANALYTICS_WRITES: AnalyticsStoreWrites = Object.freeze({ drop: false, upserts: [], forgets: [] });

export function hasAnalyticsWrites(writes: AnalyticsStoreWrites): boolean {
  return writes.drop || writes.upserts.length > 0 || writes.forgets.length > 0;
}

/**
 * `earlier` followed by `later`, as the one batch that says both.
 *
 * A row is replaced whole and a forgotten row is gone, so what the table holds for a session afterwards
 * depends on the LAST write that named it and on nothing before. Writes to different sessions commute,
 * so the batch is only ever as large as the sessions it names — however many times the same session was
 * written while the disk was slow. A drop supersedes everything before it, and survives merging because
 * the file still holds the rows it must empty.
 */
export function mergeAnalyticsWrites(earlier: AnalyticsStoreWrites, later: AnalyticsStoreWrites): AnalyticsStoreWrites {
  if (later.drop) return later;
  const named = new Set<string>([...later.upserts.map(row => row.raw.id), ...later.forgets]);
  return {
    drop: earlier.drop,
    upserts: [...earlier.upserts.filter(row => !named.has(row.raw.id)), ...later.upserts],
    forgets: [...earlier.forgets.filter(id => !named.has(id)), ...later.forgets],
  };
}

/**
 * Where the analytics store's writes are made durable, behind the reads that are answered from memory.
 *
 * `persist` applies one batch as one transaction: all of it lands or none of it does. It may be asked to
 * apply a batch it already applied — a thread presumed stuck can have committed before it was replaced —
 * which is safe because every write replaces by key.
 */
export interface AnalyticsStorePersister {
  persist(writes: AnalyticsStoreWrites): Promise<void>;
  /** Checkpoints and closes the file. Nothing is persisted after it. */
  close(): Promise<void>;
}
