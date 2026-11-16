import type { FerretId } from '@ferretry/core-ferrets/contract';
import type { PeerMessageLabel } from '../../peer-messages.ts';
import type { SendSenderKind } from '../../stores.ts';
import type { QueueAuthor, QueuedMessage } from '../../wire-send.ts';

type SessionId = FerretId;

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
  /** Stop the running turn first, when this message's turn comes. */
  readonly interrupt?: boolean | undefined;
  /** A ferret's own label (`fy send --kind`); absent is `action`. Ignored for a person and the daemon. */
  readonly label?: PeerMessageLabel | undefined;
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

/** A session's queue, as the people and ferrets who put messages in it use it (the Mailbox's service implements it). */
export interface SessionQueue {
  /** Every message the session's queue holds, oldest first. */
  list(id: SessionId): Promise<readonly QueuedMessage[]>;
  /** Accepts one message: on disk, `queued`, before this resolves. */
  enqueue(id: SessionId, request: QueueRequest): Promise<Enqueued>;
  /** Replaces the text of a message that is still waiting. */
  edit(id: SessionId, messageId: string, text: string): Promise<QueuedMessage>;
  /** Takes back a message that is still waiting. */
  cancel(id: SessionId, messageId: string): Promise<QueuedMessage>;
}
