import type { SendDisposition } from '../../seams/protocol.ts';
import type { QueueDelivery, QueueTransport } from '../lib/deliverer.ts';
import type { DeliveryView, HandOver, OwnDraft } from '../lib/delivery.ts';
import type { SendMessageRequest, SessionSendService } from '../../delivery/lib/service.ts';
import type { SendTracker } from '../../delivery/lib/tracker.ts';
import {
  SendDraftRefused,
  type SendFate,
  type SendLaunchGate,
  type SendLedger,
  SendNotReady,
  SendPending,
  SendRefused,
  type SendRepository,
  SendScreenUnreadable,
  type SendTerminal,
  SendUnavailable,
  SendUnconfirmed,
} from '../../delivery/lib/types.ts';
import type { SessionId } from '../../seams/ferret-id.ts';

/** The send path's answers that mean the pane proved the message: a turn started, a queue holding it, a revive. */
const LANDED: ReadonlySet<SendDisposition> = new Set(['delivered', 'queued', 'revived']);

/**
 * The queue's deliverer handing a message to the tracked send path, under the message's own id.
 *
 * The send path keeps the session's turn record straight and writes the ledger the read tick is proven
 * from; this class only says what its answer means for the queue. Every refusal that typed nothing is a
 * reason to wait — a draft, a screen it could not read, a pane that never came to a prompt, a session
 * still starting, one only a person can unblock — and a plain refusal (an empty message, a revive the
 * session refused) is a failure. Anything else it throws is the deliverer's to settle from the ledger,
 * since keys may have gone.
 */
export class SendPathQueueTransport implements QueueTransport {
  constructor(
    private readonly sends: Pick<SessionSendService, 'send' | 'finishOwnDraft'>,
    private readonly ledger: Pick<SendLedger, 'list'>,
    private readonly tracking: Pick<SendTracker, 'check'>,
  ) {}

  async handOver(id: SessionId, delivery: QueueDelivery): Promise<HandOver> {
    try {
      const outcome = await this.sends.send({ id, ...requestOf(delivery) });
      // A person's send the screen refused before any key is kept open and `untyped` by the send path,
      // which types it itself once the screen reads clear; its disposition then says nothing about the
      // pane. Unproven, so the ledger — keyed by this id — moves the message on.
      if (outcome.record.untyped === true) return { kind: 'unproven' };
      return LANDED.has(outcome.disposition) ? { kind: 'landed' } : { kind: 'unproven' };
    } catch (error) {
      if (error instanceof SendUnconfirmed) return { kind: 'unproven' };
      if (error instanceof SendDraftRefused) return { kind: 'refused', reason: 'draft' };
      if (error instanceof SendScreenUnreadable) return { kind: 'refused', reason: 'unreadable' };
      if (error instanceof SendNotReady) return { kind: 'refused', reason: error.reason, untilPrompt: true };
      if (error instanceof SendPending) return { kind: 'refused', reason: 'launching' };
      if (error instanceof SendUnavailable) return { kind: 'refused', reason: 'dialog' };
      if (error instanceof SendRefused) return { kind: 'failed', failure: error.message };
      throw error;
    }
  }

  async fate(id: SessionId, messageId: string): Promise<SendFate | undefined> {
    return (await this.ledger.list(id)).find(record => record.sendId === messageId)?.fate;
  }

  async clearOwnDraft(id: SessionId): Promise<OwnDraft> {
    return await this.sends.finishOwnDraft(id);
  }

  async recheck(id: SessionId): Promise<void> {
    await this.tracking.check(id);
  }
}

/** The send path's request for one delivery: a message as it is, or several folded into one turn. */
export function requestOf(delivery: QueueDelivery): Omit<SendMessageRequest, 'id'> {
  const { sendId, members } = delivery;
  const [first] = members;
  if (first === undefined) throw new Error('a delivery carries at least one message');
  if (members.length === 1)
    return {
      sendId,
      message: first.text,
      ...(first.replyExpected === true ? { replyExpected: true } : {}),
      // An interrupt is the send path's own stop-then-type, done when this message's turn has come.
      ...(first.interrupt === true ? { now: true } : {}),
      ...(first.label === undefined ? {} : { label: first.label }),
      ...(first.sender === 'agent' && first.from !== undefined ? { senderReference: first.from } : {}),
      ...(first.sender === 'daemon' ? { origin: 'daemon' as const } : {}),
    };
  const parts = members.flatMap(member =>
    member.from === undefined
      ? []
      : [
          {
            queueId: member.id,
            senderReference: member.from,
            text: member.text,
            replyExpected: member.replyExpected === true,
            ...(member.label === undefined ? {} : { label: member.label }),
          },
        ],
  );
  const attachmentIds = [...new Set(members.flatMap(member => member.attachmentIds))];
  return {
    sendId,
    message: members.map(member => member.text).join('\n\n'),
    parts,
    // Any member parked its sender on an answer: the ledger row says so.
    ...(members.some(member => member.replyExpected === true) ? { replyExpected: true } : {}),
    ...(members.some(member => member.interrupt === true) ? { now: true } : {}),
    senderReference: parts[0]?.senderReference ?? '',
    ...(attachmentIds.length === 0 ? {} : { attachmentIds }),
  };
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
