import type { SendSenderKind } from '@ferretry/protocol';
import type { ClockPort } from '../../ports.ts';
import type { SessionId } from '../../session-id.ts';
import type { SendMessageRequest, SendOutcome } from '../send/service.ts';
import { SendRefused, type SendTarget } from '../send/types.ts';
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
  /** The direct send path, for what the queue does not carry. */
  readonly direct: { send(request: SendMessageRequest): Promise<SendOutcome> };
  /** The session a message is for, as the send path reads it. */
  target(id: SessionId): Promise<SendTarget | undefined>;
  readonly clock: ClockPort;
}

export class QueueingSends {
  constructor(
    private readonly ports: QueueingSendsPorts,
    /** Whose a request that does not say is: this producer's own kind. */
    private readonly kind: SendSenderKind,
  ) {}

  async send(request: SendMessageRequest): Promise<SendOutcome> {
    const target = await this.ports.target(request.id);
    if (target === undefined) throw new SendRefused(`session ${request.id} does not exist`);
    const sender: SendSenderKind =
      request.origin === 'daemon' ? 'daemon' : request.senderReference !== undefined ? 'agent' : this.kind;
    if (request.now === true || boardOnly({ sender }, target.mode)) return await this.ports.direct.send(request);
    const { message } = await this.ports.queue.enqueue(request.id, {
      id: request.sendId,
      sender,
      ...(request.senderReference === undefined ? {} : { from: request.senderReference }),
      text: request.message,
      ...(request.attachmentIds === undefined ? {} : { attachmentIds: request.attachmentIds }),
      ...(request.replyExpected === true ? { replyExpected: true } : {}),
    });
    void this.ports.deliverer.enqueued(request.id).catch(() => undefined);
    return {
      target,
      disposition: 'queued',
      record: {
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
