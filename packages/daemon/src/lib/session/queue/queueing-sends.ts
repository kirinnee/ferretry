import type { QueueAuthor, SendSenderKind } from '@ferretry/protocol';
import type { ClockPort } from '../../ports.ts';
import type { SessionId } from '../../session-id.ts';
import type { SendMessageRequest, SendOutcome } from '../send/service.ts';
import { type SendLedger, SendRefused, type SendTarget } from '../send/types.ts';
import { answerOf } from './answer.ts';
import type { QueueDeliverer } from './deliverer.ts';
import { boardOnly } from './policy.ts';
import type { SessionQueueService } from './service.ts';

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
 * The answer has the shape the direct path's has, so no producer changes: `queued`, under the request's own
 * id, which is the id the deliverer hands over with — the send ledger, and every receipt read from it, sees
 * the same message when it is typed.
 */

export interface QueueingSendsPorts {
  readonly queue: Pick<SessionQueueService, 'enqueue'>;
  readonly deliverer: Pick<QueueDeliverer, 'enqueued'>;
  /** The direct send path: what the queue does not carry, and the refusals only a person can lift. */
  readonly direct: {
    send(request: SendMessageRequest): Promise<SendOutcome>;
    authorize(id: SessionId, attachmentIds: readonly string[]): Promise<void>;
  };
  /** The session a message is for, as the send path reads it. */
  target(id: SessionId): Promise<SendTarget | undefined>;
  /** The send ledger, which says what the hand-over did under the message's own id. */
  readonly ledger: Pick<SendLedger, 'list'>;
  readonly clock: ClockPort;
  sleep(milliseconds: number): Promise<void>;
}

/**
 * How long a send waits for the deliverer's first look at its message before it is answered `queued`. A
 * message into an empty box is typed within it, and answered as the direct path answered; one held for a
 * draft or a question is answered at once, because the look returns as soon as it says why.
 */
export const QUEUE_ANSWER_WAIT_MS = 20_000;

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

  async send(request: SendMessageRequest): Promise<SendOutcome> {
    const target = await this.ports.target(request.id);
    if (target === undefined) throw new SendRefused(`session ${request.id} does not exist`);
    const sender: SendSenderKind =
      request.origin === 'daemon' ? 'daemon' : request.senderReference !== undefined ? 'agent' : this.kind;
    // The direct path has no queue item to say who sent it, so it carries the sender itself: otherwise the
    // record reads as the owner's own words.
    if (boardOnly({ sender }, target.mode))
      return await this.ports.direct.send({ ...request, origin: 'daemon', by: this.authorOf(sender) });
    await this.ports.direct.authorize(request.id, request.attachmentIds ?? []);
    const { message } = await this.ports.queue.enqueue(request.id, {
      id: request.sendId,
      sender,
      ...(request.senderReference === undefined ? {} : { from: request.senderReference }),
      by: this.authorOf(sender),
      text: request.message,
      ...(request.attachmentIds === undefined ? {} : { attachmentIds: request.attachmentIds }),
      ...(request.replyExpected === true ? { replyExpected: true } : {}),
      // `now` keeps its place in the queue: the deliverer stops the turn when this message's turn comes.
      ...(request.now === true ? { interrupt: true } : {}),
    });
    await Promise.race([
      this.ports.deliverer.enqueued(request.id).catch(() => undefined),
      this.ports.sleep(QUEUE_ANSWER_WAIT_MS),
    ]);
    const handed = (await this.ports.ledger.list(request.id)).find(record => record.sendId === message.id);
    const { disposition } = answerOf(handed);
    return {
      target,
      disposition,
      record: handed ?? {
        sendId: message.id,
        acceptedAt: message.enqueuedAt,
        acceptedTurn: target.turn,
        path: 'native-inline',
        message: message.text,
        fate: 'accepted',
        senderKind: sender,
      },
    };
  }
}
