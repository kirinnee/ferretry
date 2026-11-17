import type { InteractionMode, QueueAuthor, SendResult, SendSenderKind } from '../../../contract/index.ts';
import type { SessionId } from '../../../contract/index.ts';
import type { SendMessageRequest } from '../delivery/service.ts';
import { SendRefused } from '../../../contract/index.ts';
import type { QueueDeliverer } from './deliverer.ts';
import { boardOnly } from '../../../contract/index.ts';
import type { SessionQueue } from '../../../contract/index.ts';

/**
 * THE SEND PATH EVERY PRODUCER INSIDE THE DAEMON USES WHEN THE QUEUE IS ON: the message is written to the
 * session's queue and answered at once, and the deliverer — the one owner of delivery — types it, in order,
 * when the input box is empty. The Warden, the board's nudges, the declared-wait watcher, the owner's agenda
 * answers: each called the send path directly and raced every other for the same composer.
 *
 * WHO SENT IT decides its place. A request that says it is the daemon's (`origin`) is the daemon's, and one
 * naming a sending session is that ferret's; anything else is this producer's own kind — the daemon's for
 * the Warden and the board, a person's for the agenda answers the owner gave.
 *
 * A DAEMON MESSAGE TO AN INTERACTIVE SESSION is never in the queue's delivery order — that session is the
 * owner's own chat — so it is not enqueued to sit there for ever: it takes the direct send path it took
 * before, until each such producer posts to the session's board instead.
 *
 * What the caller is answered is the Mailbox's to say (it reads the queue and the ledger under the message's
 * own id): this class returns only what the direct path answered, and nothing for a message it queued.
 */

export interface QueueingSendsPorts {
  readonly queue: Pick<SessionQueue, 'enqueue'>;
  readonly deliverer: Pick<QueueDeliverer, 'enqueued'>;
  /** The direct send path: what the queue does not carry, and the refusals only a person can lift. */
  readonly direct: {
    send(request: SendMessageRequest): Promise<SendResult>;
    authorize(id: SessionId, attachmentIds: readonly string[]): Promise<void>;
  };
  /** The session a message is for, as the send path reads it. */
  target(id: SessionId): Promise<{ readonly mode: InteractionMode } | undefined>;
  /** A wait that can be given up: the timer is not left running once the deliverer's first look is back. */
  timer(milliseconds: number): { readonly done: Promise<void>; cancel(): void };
}

/**
 * How long a send waits for the deliverer's first look at its message before it is answered `queued`. A
 * message into an empty box is typed within it, and answered as the direct path answered; one held for a
 * draft or a question is answered at once, because the look returns as soon as it says why.
 */
const QUEUE_ANSWER_WAIT_MS = 20_000;

export class QueueingSends {
  constructor(
    private readonly ports: QueueingSendsPorts,
    /** Whose a request that does not say is: this producer's own kind. */
    private readonly kind: SendSenderKind,
    /** The part of Ferretry this producer is — Board, Warden, Agenda… — shown as the sender chip. */
    private readonly feature?: string,
  ) {}

  /** Who a message is from, as data: the app's sender chip, never text in the body. */
  private authorOf(sender: SendSenderKind): QueueAuthor {
    const feature = this.feature === undefined ? {} : { feature: this.feature };
    if (sender === 'agent') return { kind: 'ferret' };
    return sender === 'daemon' ? { kind: 'ferretry', ...feature } : { kind: 'owner', ...feature };
  }

  /** Queues the message, and answers what the direct path answered when it took that path instead. */
  async send(request: SendMessageRequest): Promise<SendResult | undefined> {
    const target = await this.ports.target(request.id);
    if (target === undefined) throw new SendRefused(`session ${request.id} does not exist`);
    const sender: SendSenderKind =
      request.origin === 'daemon' ? 'daemon' : request.senderReference !== undefined ? 'agent' : this.kind;
    // The direct path has no queue item to say who sent it, so it carries the sender itself: otherwise the
    // record reads as the owner's own words.
    if (boardOnly({ sender }, target.mode))
      return await this.ports.direct.send({ ...request, origin: 'daemon', by: this.authorOf(sender) });
    await this.ports.direct.authorize(request.id, request.attachmentIds ?? []);
    await this.ports.queue.enqueue(request.id, {
      id: request.sendId,
      sender,
      ...(request.senderReference === undefined ? {} : { from: request.senderReference }),
      by: this.authorOf(sender),
      text: request.message,
      ...(request.attachmentIds === undefined ? {} : { attachmentIds: request.attachmentIds }),
      ...(request.replyExpected === true ? { replyExpected: true } : {}),
      ...(request.label === undefined ? {} : { label: request.label }),
      // `now` keeps its place in the queue: the deliverer stops the turn when this message's turn comes.
      ...(request.now === true ? { interrupt: true } : {}),
    });
    const waited = this.ports.timer(QUEUE_ANSWER_WAIT_MS);
    try {
      await Promise.race([this.ports.deliverer.enqueued(request.id).catch(() => undefined), waited.done]);
    } finally {
      waited.cancel();
    }
    return undefined;
  }
}
