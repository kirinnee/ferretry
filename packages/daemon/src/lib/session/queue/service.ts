import type { QueueAuthor, QueuedMessage, SendSenderKind } from '@ferretry/protocol';
import type { ClockPort, SerialExecutor } from '../../ports.ts';
import type { SessionId } from '../../session-id.ts';
import { foldQueue } from './model.ts';
import type { SessionQueueStore } from './ports.ts';

/** A message as its sender hands it over, before the queue gives it a state. */
export interface QueueRequest {
  /** The sender's idempotency key: a retried request is answered from the message it already made. */
  readonly id: string;
  readonly sender: SendSenderKind;
  readonly from?: string | undefined;
  readonly fromName?: string | undefined;
  /** Who it is from, as data for the app's sender chip — never as text in the body. */
  readonly by?: QueueAuthor | undefined;
  readonly text: string;
  readonly attachmentIds?: readonly string[] | undefined;
  readonly replyExpected?: boolean | undefined;
}

/** What an enqueue did: made the message, or found the one a first request already made. */
export interface Enqueued {
  readonly message: QueuedMessage;
  readonly created: boolean;
}

/** Why a change to a queued message was not made. */
export type QueueRefusal = 'not_found' | 'not_waiting';

/** A change the queue will not make, with the reason a caller can branch on. */
export class QueueRefused extends Error {
  constructor(
    readonly refusal: QueueRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'QueueRefused';
  }
}

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
export class SessionQueueService {
  constructor(private readonly ports: SessionQueuePorts) {}

  /** Every message the session's queue holds, oldest first. */
  async list(id: SessionId): Promise<readonly QueuedMessage[]> {
    return foldQueue(await this.ports.store.read(id));
  }

  /** Accepts one message: on disk, `queued`, before this resolves — the first tick. */
  async enqueue(id: SessionId, request: QueueRequest): Promise<Enqueued> {
    return await this.ports.serial.run(id, async () => {
      const existing = (await this.list(id)).find(message => message.id === request.id);
      if (existing !== undefined) return { message: existing, created: false };
      const at = this.ports.clock.now();
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
        enqueuedAt: at,
        state: 'queued',
        stateAt: at,
        revision: 1,
      };
      await this.ports.store.append(id, { v: 1, kind: 'enqueued', at, message });
      return { message, created: true };
    });
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
