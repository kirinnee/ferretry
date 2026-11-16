import type { QueuedMessage } from '../../seams/protocol.ts';
import type { SessionId } from '../../seams/ferret-id.ts';
import type { QueueEvent } from './model.ts';

/**
 * Where a session's queue is kept: its log, and the messages that log describes.
 *
 * EVERY `append` HOLDS THE SESSION'S QUEUE LOCK (the service's enqueue, edit and cancel; the deliverer's moves and
 * waiting reasons all run inside `serial.run(session)`). A store that rotates its log relies on it: a rotation reads the
 * live segment and replaces it, and an append between the two would be lost.
 */
export interface SessionQueueStore {
  /** Every message the session's queue holds, in the order they were first accepted; none when it has none. */
  messages(id: SessionId): Promise<readonly QueuedMessage[]>;
  /** Records one event; it is on disk when this resolves. */
  append(id: SessionId, event: QueueEvent): Promise<void>;
}
