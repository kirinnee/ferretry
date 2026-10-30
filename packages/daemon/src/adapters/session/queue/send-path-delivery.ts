import type { QueuedMessage, SendDisposition } from '@ferretry/protocol';
import type { DeliveryView, HandOver } from '../../../lib/session/queue/delivery.ts';
import type { QueueTransport } from '../../../lib/session/queue/deliverer.ts';
import type { SessionSendService } from '../../../lib/session/send/service.ts';
import {
  type SendFate,
  SendDraftRefused,
  type SendLaunchGate,
  type SendLedger,
  SendPending,
  SendRefused,
  type SendRepository,
  SendScreenUnreadable,
  type SendTerminal,
  SendUnavailable,
  SendUnconfirmed,
} from '../../../lib/session/send/types.ts';
import type { SessionId } from '../../../lib/session-id.ts';

/** The send path's answers that mean the pane proved the message: a turn started, a queue holding it, a revive. */
const LANDED: ReadonlySet<SendDisposition> = new Set(['delivered', 'queued', 'revived']);

/**
 * The queue's deliverer handing a message to the tracked send path, under the message's own id.
 *
 * The send path keeps the session's turn record straight and writes the ledger the read tick is proven
 * from; this class only says what its answer means for the queue. Every refusal that typed nothing is a
 * reason to wait — a draft, a screen it could not read, a session still starting, one only a person can
 * unblock — and a plain refusal (an empty message, a revive the session refused) is a failure. Anything
 * else it throws is the deliverer's to settle from the ledger, since keys may have gone.
 */
export class SendPathQueueTransport implements QueueTransport {
  constructor(
    private readonly sends: Pick<SessionSendService, 'send'>,
    private readonly ledger: Pick<SendLedger, 'list'>,
  ) {}

  async handOver(id: SessionId, message: QueuedMessage): Promise<HandOver> {
    try {
      const outcome = await this.sends.send({
        id,
        sendId: message.id,
        message: message.text,
        ...(message.replyExpected === true ? { replyExpected: true } : {}),
        // An interrupt is the send path's own stop-then-type, done when this message's turn has come.
        ...(message.interrupt === true ? { now: true } : {}),
        ...(message.sender === 'agent' && message.from !== undefined ? { senderReference: message.from } : {}),
        ...(message.sender === 'daemon' ? { origin: 'daemon' as const } : {}),
      });
      // A person's send the screen refused before any key is kept open and `untyped` by the send path,
      // which types it itself once the screen reads clear; its disposition then says nothing about the
      // pane. Unproven, so the ledger — keyed by this id — moves the message on.
      if (outcome.record.untyped === true) return { kind: 'unproven' };
      return LANDED.has(outcome.disposition) ? { kind: 'landed' } : { kind: 'unproven' };
    } catch (error) {
      if (error instanceof SendUnconfirmed) return { kind: 'unproven' };
      if (error instanceof SendDraftRefused) return { kind: 'refused', reason: 'draft' };
      if (error instanceof SendScreenUnreadable) return { kind: 'refused', reason: 'unreadable' };
      if (error instanceof SendPending) return { kind: 'refused', reason: 'launching' };
      if (error instanceof SendUnavailable) return { kind: 'refused', reason: 'dialog' };
      if (error instanceof SendRefused) return { kind: 'failed', failure: error.message };
      throw error;
    }
  }

  async fate(id: SessionId, messageId: string): Promise<SendFate | undefined> {
    return (await this.ledger.list(id)).find(record => record.sendId === messageId)?.fate;
  }
}

/** The session as the deliverer reads it before typing: its record, a fresh look at its pane, its launch. */
export class SendPathDeliveryView {
  constructor(
    private readonly repository: Pick<SendRepository, 'read'>,
    private readonly terminal: Pick<SendTerminal, 'observe'>,
    private readonly gate: Pick<SendLaunchGate, 'launching'>,
  ) {}

  async view(id: SessionId): Promise<DeliveryView> {
    const target = await this.repository.read(id);
    if (target === undefined) throw new Error(`session ${id} has no record to deliver to`);
    return { target, pane: await this.terminal.observe(id), launching: this.gate.launching(id) };
  }
}
