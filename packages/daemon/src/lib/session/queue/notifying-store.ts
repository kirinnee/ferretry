import { QUEUE_CHANGED_EVENT, type QueueChangedEventData } from '@ferretry/protocol';
import type { SessionId } from '../../session-id.ts';
import type { QueueEvent } from './model.ts';
import type { SessionQueueStore } from './ports.ts';

/** Where a queue change is announced: the session's own journal, which `/v1/events` serves live. */
export interface QueueChangePublisher {
  publish(id: SessionId, type: typeof QUEUE_CHANGED_EVENT, data: QueueChangedEventData): Promise<void>;
}

/**
 * THE ONE PLACE A QUEUE CHANGE IS ANNOUNCED.
 *
 * Every writer of a session's queue log — the service's enqueue, edit and cancel, and the deliverer's moves and
 * waiting reasons — appends through the {@link SessionQueueStore} port, so decorating the port covers all of them
 * and any writer added later. The announcement goes out only AFTER the event is durable (a reader told "it
 * changed" must find it changed), and it carries the message id and the kind of change, never its text.
 *
 * AN ANNOUNCEMENT THAT FAILS NEVER FAILS THE CHANGE. The queue's promise is "on disk before it answers"; the
 * journal is a courtesy to open chats, which keep a slow fallback read for exactly the event that does not arrive.
 */
export class NotifyingSessionQueueStore implements SessionQueueStore {
  constructor(
    private readonly inner: SessionQueueStore,
    private readonly publisher: QueueChangePublisher,
  ) {}

  async read(id: SessionId): Promise<readonly QueueEvent[]> {
    return await this.inner.read(id);
  }

  async append(id: SessionId, event: QueueEvent): Promise<void> {
    await this.inner.append(id, event);
    const messageId = event.kind === 'enqueued' ? event.message.id : event.id;
    await this.publisher.publish(id, QUEUE_CHANGED_EVENT, { messageId, change: event.kind }).catch(() => undefined);
  }
}
