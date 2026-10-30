import type { SessionId } from '../../session-id.ts';
import type { QueueEvent } from './model.ts';

/** Where a session's queue is kept: its log, read whole, and one event appended durably at a time. */
export interface SessionQueueStore {
  /** Every event this session's queue has recorded, oldest first; an empty log when it has none. */
  read(id: SessionId): Promise<readonly QueueEvent[]>;
  /** Records one event; it is on disk when this resolves. */
  append(id: SessionId, event: QueueEvent): Promise<void>;
}
