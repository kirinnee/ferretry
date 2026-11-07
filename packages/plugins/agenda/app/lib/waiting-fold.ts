// WAITING MESSAGES, HIDDEN FROM THE CHAT.
//
// A message that has not gone into the ferret yet — the owner's send saved on this device, a send in the
// machine's queue, a ferret's note held to be combined with others — is not part of the conversation, so
// the chat does not draw it at all (the owner's call, 2026-11-04: "hide fully"). It lives on the Queue
// page, where each can be read, edited or taken back, and appears in the chat once it is delivered. A
// message that needs the person (failed, refused, unconfirmed, typed but not sent) is NOT waiting and stays.
// Pure decisions: no clock, no network.
//
// The send ledger and the queue are Conversation's. These are the fields of them this fold reads, structurally, so a
// host's own ledger rows fit without this half importing the plugin that owns them.

/** Where the machine's durable queue has a message. */
export interface WaitingFoldQueue {
  readonly state: 'queued' | 'typing' | 'delivered' | 'read' | 'unconfirmed' | 'cancelled' | 'failed';
  readonly stateAt: string;
  readonly revision: number;
  readonly waitReason?: string;
  readonly failure?: string;
  readonly deliveredAs?: string;
}

/** One send as the chat's ledger holds it, as far as the fold reads it. */
export interface WaitingFoldSend {
  readonly sendId: string;
  readonly acceptedAt: string;
  readonly message: string;
  readonly attachmentIds: readonly string[];
  readonly fate: string;
  readonly from?: string;
  readonly fromName?: string;
  readonly held?: true;
  readonly withdrawn?: true;
  readonly retryable?: true;
  readonly typedNotSent?: true;
  /** This browser could not read the ledger: the fate is the last one it saw. */
  readonly unread?: unknown;
  /** Where this device's outbox has the message, while it has not reached the machine's queue. */
  readonly outbox?: {
    readonly reason: string;
    readonly position: number;
    readonly of: number;
    readonly refused?: true | boolean;
  };
  readonly queue?: WaitingFoldQueue;
}

/** One row of the chat, as far as the fold reads it: a ledger card carries its send. */
export interface WaitingFoldEntry {
  readonly id: string;
  readonly kind: string;
  readonly text: string;
  readonly ledger?: WaitingFoldSend;
  readonly send?: WaitingFoldSend;
  readonly settled?: string;
  readonly placement?: string;
}

type LedgerSendRecord = WaitingFoldSend;
type TranscriptEntry = WaitingFoldEntry;

const isQueueArrived = (state: WaitingFoldQueue['state']): boolean => state === 'delivered' || state === 'read';

/** The queue's word for a send, unless the ledger has already seen it delivered (today's `effectiveQueueState`). */
const effectiveQueueState = (record: LedgerSendRecord): WaitingFoldQueue['state'] | undefined => {
  const state = record.queue?.state;
  if (state === undefined) return undefined;
  if (record.fate === 'delivered' && !isQueueArrived(state)) return 'delivered';
  return state;
};

/**
 * Is this send still WAITING to go into the ferret? False for everything else — a message that needs the
 * person, one being typed this instant, a settled or cancelled one, and a delivered one.
 */
export const isWaitingSend = (record: LedgerSendRecord): boolean => {
  if (record.fate !== 'accepted' && record.fate !== 'queued') return false;
  if (record.unread !== undefined || record.typedNotSent === true || record.withdrawn === true) return false;
  // Saved on this device: waiting for a connection, unless the machine refused it (then the person must act).
  if (record.outbox !== undefined) return record.outbox.refused !== true;
  const state = effectiveQueueState(record);
  if (state !== undefined) return state === 'queued';
  // No queue view (a daemon from before the queue): the ledger's own word — held for a revive, or in the
  // agent's native queue. A bare `accepted` is "being checked", a moment from landing, and stays drawn.
  return record.held === true || record.fate === 'queued';
};

/** The conversation without the cards for messages still waiting. Rows that are not waiting are untouched. */
export const hideWaiting = <Entry extends TranscriptEntry>(entries: readonly Entry[]): readonly Entry[] => {
  const kept = entries.filter(
    entry =>
      entry.kind !== 'ledger' ||
      entry.ledger === undefined ||
      entry.settled !== undefined ||
      !isWaitingSend(entry.ledger),
  );
  return kept.length === entries.length ? entries : kept;
};
