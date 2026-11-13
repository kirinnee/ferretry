import type { StatePort } from '@ferretry/kernel/contract';
import { QUEUE_STATE } from '../../../contract/index.ts';
import type { SessionId } from '../../seams/ferret-id.ts';
import { type QueueEvent, QueueEventSchema } from '../lib/model.ts';
import type { SessionQueueStore } from '../lib/ports.ts';

/**
 * A ferret's queue as an append-only log in its own state file (`state/conversation/<ferret>/queue.jsonl`).
 *
 * DURABLE BEFORE IT ANSWERS: the state port's append is on disk when it resolves, because "accepted" is a promise
 * the message survives a daemon that goes down a moment later.
 *
 * PARSED AT THE BOUNDARY: a line that is not an event this daemon knows is skipped, so one odd line cannot hide every
 * message after it. The fold decides what each surviving event may change.
 */
export class StateQueueStore implements SessionQueueStore {
  constructor(private readonly state: StatePort) {}

  async read(id: SessionId): Promise<readonly QueueEvent[]> {
    const events: QueueEvent[] = [];
    for await (const line of this.state.lines<unknown>(QUEUE_STATE, id)) {
      const parsed = QueueEventSchema.safeParse(line);
      if (parsed.success) events.push(parsed.data);
    }
    return events;
  }

  async append(id: SessionId, event: QueueEvent): Promise<void> {
    await this.state.append<unknown>(QUEUE_STATE, event, id);
  }
}
