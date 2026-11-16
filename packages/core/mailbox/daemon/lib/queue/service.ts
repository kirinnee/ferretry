import type { FerretId } from '@ferretry/core-ferrets/contract';
import { type Instant, instantFromEpochMs } from '@ferretry/std';
import {
  type ClockPort,
  defaultQueueCoalesceSettings,
  type Enqueued,
  type PeerMessageLabel,
  type QueueCoalesceSettings,
  QueueRefused,
  type QueuedMessage,
  type QueueRequest,
  type SerialExecutor,
  type SessionQueue,
  type SessionQueueStore,
} from '../../../contract/index.ts';

type SessionId = FerretId;

export interface SessionQueuePorts {
  readonly store: SessionQueueStore;
  readonly clock: ClockPort;
  /**
   * Serializes every change to one session's queue, so an edit cannot land on a message a delivery has
   * just started typing. Its own executor, never the send service's: a delivery will hold that one.
   */
  readonly serial: SerialExecutor;
}

/**
 * A session's queue, for the people and ferrets who put messages in it.
 *
 * Only a message still `queued` can be edited or cancelled — once a key has gone to the pane, the words
 * are the agent's to read, and taking them back is no longer the queue's to promise.
 */
export class SessionQueueService implements SessionQueue {
  constructor(
    private readonly ports: SessionQueuePorts,
    private readonly coalescing: QueueCoalesceSettings = defaultQueueCoalesceSettings,
  ) {}

  /** Every message the session's queue holds, oldest first. */
  async list(id: SessionId): Promise<readonly QueuedMessage[]> {
    return await this.ports.store.messages(id);
  }

  /** Accepts one message: on disk, `queued`, before this resolves — the first tick. */
  async enqueue(id: SessionId, request: QueueRequest): Promise<Enqueued> {
    return await this.ports.serial.run(id, async () => {
      const existing = (await this.list(id)).find(message => message.id === request.id);
      if (existing !== undefined) return { message: existing, created: false };
      const at = this.ports.clock.now();
      const label =
        request.sender === 'agent'
          ? request.replyExpected === true
            ? 'blocker'
            : (request.label ?? 'action')
          : undefined;
      const holdUntil = this.holdUntil(request, label, at);
      const message: QueuedMessage = {
        v: 1,
        id: request.id,
        sender: request.sender,
        ...(request.from === undefined ? {} : { from: request.from }),
        ...(request.fromName === undefined ? {} : { fromName: request.fromName }),
        ...(request.by === undefined ? {} : { by: request.by }),
        text: request.text,
        attachmentIds: [...(request.attachmentIds ?? [])],
        ...(request.replyExpected === true ? { replyExpected: true } : {}),
        ...(request.interrupt === true ? { interrupt: true } : {}),
        ...(label === undefined ? {} : { label }),
        ...(holdUntil === undefined ? {} : { holdUntil }),
        enqueuedAt: at,
        state: 'queued',
        stateAt: at,
        revision: 1,
      };
      await this.ports.store.append(id, { v: 1, kind: 'enqueued', at, message });
      return { message, created: true };
    });
  }

  /**
   * How long a ferret's message is held to ride with others, fixed NOW so a later settings change never
   * moves a hold already promised. Never for a person, the daemon, a blocker, an interrupt or with the
   * kill switch off. A question is a blocker whatever it was labelled, so it is never held.
   */
  private holdUntil(request: QueueRequest, label: PeerMessageLabel | undefined, at: Instant): Instant | undefined {
    if (!this.coalescing.coalesce || label === undefined || label === 'blocker' || request.interrupt === true)
      return undefined;
    const windowMs = label === 'fyi' ? this.coalescing.fyiMaxHoldMs : this.coalescing.actionWindowMs;
    return instantFromEpochMs(Date.parse(at) + windowMs);
  }

  /** Replaces the text of a message that is still waiting. */
  async edit(id: SessionId, messageId: string, text: string): Promise<QueuedMessage> {
    return await this.ports.serial.run(id, async () => {
      const current = await this.waiting(id, messageId, 'edited');
      const at = this.ports.clock.now();
      const revision = current.revision + 1;
      await this.ports.store.append(id, { v: 1, kind: 'edited', at, id: messageId, text, revision });
      return { ...current, text, revision };
    });
  }

  /** Takes back a message that is still waiting; nothing of it was ever typed. */
  async cancel(id: SessionId, messageId: string): Promise<QueuedMessage> {
    return await this.ports.serial.run(id, async () => {
      const current = await this.waiting(id, messageId, 'cancelled');
      const at = this.ports.clock.now();
      await this.ports.store.append(id, { v: 1, kind: 'moved', at, id: messageId, state: 'cancelled' });
      const { waitReason: _reason, ...rest } = current;
      return { ...rest, state: 'cancelled', stateAt: at };
    });
  }

  private async waiting(id: SessionId, messageId: string, verb: string): Promise<QueuedMessage> {
    const current = (await this.list(id)).find(message => message.id === messageId);
    if (current === undefined) throw new QueueRefused('not_found', `session ${id} has no queued message ${messageId}`);
    if (current.state !== 'queued')
      throw new QueueRefused(
        'not_waiting',
        `message ${messageId} is ${current.state}, so it can no longer be ${verb}: only a waiting message can`,
      );
    return current;
  }
}
