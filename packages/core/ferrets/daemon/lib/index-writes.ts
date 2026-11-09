/**
 * THE SESSION INDEX'S WRITES, AS DATA.
 *
 * Each write here is one call the index already had, and each touches exactly one session's rows — except
 * `replace-all`, which touches every row. The index applies one write per transaction.
 */
import type { SessionId } from './session-id.ts';
import type { EventPointer, IndexedSession } from './storage-types.ts';

export type IndexWrite =
  /** Every row replaced: the rebuild. */
  | {
      readonly kind: 'replace-all';
      readonly sessions: readonly IndexedSession[];
      readonly events: readonly EventPointer[];
    }
  /** One session's metadata and exactly these pointers, and no others. */
  | {
      readonly kind: 'replace-session';
      readonly session: IndexedSession;
      readonly events: readonly EventPointer[];
    }
  /** One session's metadata upserted; its pointers kept as they are. */
  | { readonly kind: 'refresh-session'; readonly session: IndexedSession }
  /** One session's metadata upserted, and these pointers added to the ones it has. */
  | {
      readonly kind: 'append-events';
      readonly session: IndexedSession;
      readonly events: readonly EventPointer[];
    }
  /** One session's row and every pointer it had, gone. */
  | { readonly kind: 'remove-session'; readonly id: SessionId };
