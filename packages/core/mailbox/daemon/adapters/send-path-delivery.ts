import { AGENT_ORIGIN, type LaunchOrigin, PERSON_ORIGIN } from '@ferretry/core-ferrets/contract';
import type { QueueDelivery, QueueTransport } from '../lib/queue/index.ts';
import type { DeliveryView, HandOver, OwnDraft, QueueAuthor, SendResult } from '../../contract/index.ts';
import type { SendMessageRequest } from '../lib/delivery/service.ts';
import type { SendTracker } from '../lib/delivery/tracker.ts';
import type { LedgerFate as SendFate } from '../../contract/index.ts';
import type { SendLaunchGate, SendLedger, SendRepository, SendTerminal } from '../../contract/index.ts';
import { type SessionId, tryParseSessionId } from '../../contract/index.ts';
import { NOT_READY_SENTENCES, UnreadableComposer } from '../../contract/lib/send/harness-seam.ts';
import type { PaneNotReadyReason } from '@ferretry/core-ferrets/contract';
import { SessionSendError } from '../lib/delivery/mounts/session-send.ts';

/**
 * One delivery as the typing send takes it: the request the queue's message makes once its turn has come.
 * `queued` says the queue's own entry under `sendId` is the thing being delivered, not an earlier send of that id.
 */
export interface QueuedSend {
  readonly sendId: string;
  readonly message: string;
  readonly origin: LaunchOrigin;
  readonly queued: true;
  readonly senderSessionId?: string | undefined;
  readonly replyExpected?: boolean | undefined;
  readonly now?: boolean | undefined;
  readonly label?: unknown;
  /** Who the daemon is, when it is the sender: shown as the sender chip, and what decides how a refusal is met. */
  readonly by?: QueueAuthor | undefined;
  readonly warden?: true;
  readonly agenda?: true;
  readonly notice?: true;
  /** Two or more ferret messages delivered as one turn. */
  readonly parts?: SendMessageRequest['parts'];
}

/** The typing send and the composer act the queue's transport leans on: today's `typeMessage`, and finishing our own draft. */
export interface QueuedTyping {
  type(id: SessionId, request: QueuedSend): Promise<SendResult>;
  finishOwnDraft(id: SessionId): Promise<OwnDraft>;
}

/** The sentence a pane that never came to a prompt is refused with, back to the reason it names. */
const NOT_READY_REASONS: ReadonlyMap<string, PaneNotReadyReason> = new Map(
  (Object.entries(NOT_READY_SENTENCES) as [PaneNotReadyReason, string][]).map(([reason, sentence]) => [
    sentence,
    reason,
  ]),
);

/**
 * The queue's deliverer handing a message to the typing send (`typeMessage`), under the message's own id.
 *
 * The send path keeps the session's turn record straight and writes the ledger the read tick is proven from; this class
 * only says what its answer means for the queue. A refusal that typed nothing is a reason to wait (a draft, a screen it
 * could not read, a pane that never came to a prompt, a session still starting) and any other refusal is a failure that
 * a wait would not change. Anything else the send throws is the deliverer's to settle from the ledger, since keys may
 * have gone.
 */
export class SendPathQueueTransport implements QueueTransport {
  constructor(
    private readonly typing: QueuedTyping,
    private readonly ledger: Pick<SendLedger, 'list'>,
    private readonly tracking: Pick<SendTracker, 'check'>,
  ) {}

  async handOver(id: SessionId, delivery: QueueDelivery): Promise<HandOver> {
    try {
      const sent = await this.typing.type(id, typedRequestOf(delivery));
      // Kept open and `untyped` by the send path (the box could not be proven empty): it types the message itself once
      // the screen reads clear, so what the pane proved is nothing yet, and the ledger — keyed by this id — moves it on.
      return sent.waitReason === undefined ? { kind: 'landed' } : { kind: 'unproven' };
    } catch (error) {
      return refusalOf(error);
    }
  }

  /**
   * Where a message handed over before now stands, per the send ledger. A `withdrawn` row is the send path taking back a
   * hand-over it refused before any key: nothing was typed, so it says no more than no row does.
   */
  async fate(id: SessionId, messageId: string): Promise<SendFate | undefined> {
    const fate = (await this.ledger.list(id)).find(record => record.sendId === messageId)?.fate;
    return fate === 'withdrawn' ? undefined : fate;
  }

  async clearOwnDraft(id: SessionId): Promise<OwnDraft> {
    return await this.typing.finishOwnDraft(id);
  }

  async recheck(id: SessionId): Promise<void> {
    await this.tracking.check(id);
  }
}

/** What an error of the typing send means for a message handed over; one nobody can classify is rethrown. */
function refusalOf(error: unknown): HandOver {
  if (!(error instanceof SessionSendError)) throw error;
  switch (error.failure) {
    case 'unconfirmed':
      return { kind: 'unproven' };
    case 'pending':
      return { kind: 'refused', reason: 'launching' };
    case 'refused': {
      if (error.draft !== undefined) return { kind: 'refused', reason: 'draft' };
      if (error instanceof UnreadableComposer) return { kind: 'refused', reason: 'unreadable' };
      const why = NOT_READY_REASONS.get(error.message);
      if (why !== undefined) return { kind: 'refused', reason: why === 'exited' ? 'stopped' : why, untilPrompt: true };
      return { kind: 'failed', failure: error.message };
    }
    default:
      throw error;
  }
}

/** Who a revive this delivery causes is FOR: a person's own words, a ferret's, or Ferretry's. */
function originOf(delivery: QueueDelivery): LaunchOrigin {
  const [first] = delivery.members;
  if (first?.sender === 'human') return PERSON_ORIGIN;
  const from = first?.sender === 'agent' && first.from !== undefined ? tryParseSessionId(first.from) : undefined;
  return from === undefined ? AGENT_ORIGIN : { kind: 'agent', ferret: from };
}

/** The typing send's request for one delivery: the send path's request, plus who it is for and what the daemon is. */
export function typedRequestOf(delivery: QueueDelivery): QueuedSend {
  const { senderReference, origin: _daemon, attachmentIds: _carried, ...rest } = requestOf(delivery);
  const [first] = delivery.members;
  const feature = first?.sender === 'daemon' ? first.by?.feature : undefined;
  return {
    ...rest,
    queued: true,
    origin: originOf(delivery),
    ...(senderReference === undefined || senderReference === '' ? {} : { senderSessionId: senderReference }),
    ...(first?.sender === 'daemon'
      ? {
          ...(first.by === undefined ? {} : { by: first.by }),
          ...(feature === 'Warden'
            ? { warden: true as const }
            : feature === 'Agenda'
              ? { agenda: true as const }
              : { notice: true as const }),
        }
      : {}),
  };
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
