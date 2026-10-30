// THE QUEUE VIEWS, AS PURE DECISIONS.
//
// One row per message that has not finished its way to the ferret: still on this device (the outbox, tick 1),
// on the machine's queue, typed and awaiting proof, or read. The views draw these rows; nothing here reads
// a network or a clock.

import type { QueuedMessage } from '@ferretry/protocol';
import { type OutboxEntry, WAITING_REASON } from './send-outbox.ts';
import { WAIT_REASON_COPY } from './send-queue.ts';

/** `saved` is the browser's own outbox; the rest are the daemon queue's states. */
type QueueRowState = 'saved' | QueuedMessage['state'];

export interface QueueRow {
  readonly id: string;
  readonly daemonId: string;
  readonly sessionId: string;
  /** What the person calls the ferret. */
  readonly ferret: string;
  readonly text: string;
  readonly state: QueueRowState;
  /** The plain sentence for where it is and why it waits. */
  readonly why: string;
  /** When it was written down: the queue's `enqueuedAt`, or the outbox entry's `createdAt`. */
  readonly at: string;
  /** Who sent it, when it is not the owner: a ferret's name or "Ferretry · Board". Never text in the body. */
  readonly sender?: string;
  /** Still changeable: on this device, or queued and not typed yet. */
  readonly editable: boolean;
  readonly refused?: true;
}

const senderOf = (message: QueuedMessage): string | undefined => {
  const by = message.by;
  if (by === undefined || by.kind === 'owner') return undefined;
  if (by.kind === 'ferret') return by.name ?? message.fromName;
  return by.feature === undefined ? 'Ferretry' : `Ferretry · ${by.feature}`;
};

const WHY: Readonly<Record<Exclude<QueuedMessage['state'], 'queued'>, string>> = {
  typing: 'being typed into the ferret now',
  delivered: 'typed into the ferret',
  read: 'the ferret read it',
  unconfirmed: 'typed, but nothing yet proves it arrived',
  cancelled: 'cancelled',
  failed: 'could not be sent',
};

const queuedWhy = (message: QueuedMessage): string =>
  message.waitReason === undefined ? 'waiting for its turn' : `waiting — ${WAIT_REASON_COPY[message.waitReason]}`;

export const queueRowOf = (daemonId: string, sessionId: string, ferret: string, message: QueuedMessage): QueueRow => {
  const sender = senderOf(message);
  return {
    id: message.id,
    daemonId,
    sessionId,
    ferret,
    text: message.text,
    state: message.state,
    why: message.state === 'queued' ? queuedWhy(message) : (message.failure ?? WHY[message.state]),
    at: message.enqueuedAt,
    editable: message.state === 'queued',
    ...(sender === undefined ? {} : { sender }),
  };
};

export const outboxRowOf = (ferret: string, entry: OutboxEntry): QueueRow => ({
  id: entry.id,
  daemonId: entry.daemonId,
  sessionId: entry.sessionId,
  ferret,
  text: entry.message,
  state: 'saved',
  why: entry.reason ?? WAITING_REASON,
  at: entry.createdAt,
  editable: true,
  ...(entry.refused === true ? { refused: true as const } : {}),
});

/** Messages the ferret has not finished with — what "waiting" means in the All-queues view. */
export const isWaitingRow = (row: QueueRow): boolean =>
  row.state === 'saved' || row.state === 'queued' || row.state === 'typing' || row.state === 'unconfirmed';

/** Oldest first within a ferret: what the ferret will meet in that order. */
export const orderedRows = (rows: readonly QueueRow[]): readonly QueueRow[] =>
  [...rows].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));

/** A ferret's rows: its machine's queue and this device's outbox, each message once (the queue wins). */
export const ferretRows = (
  daemonId: string,
  sessionId: string,
  ferret: string,
  messages: readonly QueuedMessage[],
  entries: readonly OutboxEntry[],
): readonly QueueRow[] => {
  const known = new Set(messages.map(message => message.id));
  return orderedRows([
    ...messages
      .filter(message => message.state !== 'cancelled')
      .map(message => queueRowOf(daemonId, sessionId, ferret, message)),
    ...entries
      .filter(entry => entry.daemonId === daemonId && entry.sessionId === sessionId && !known.has(entry.id))
      .map(entry => outboxRowOf(ferret, entry)),
  ]);
};

/** One heading's worth of the All-queues view: a ferret and what waits for it. */
export interface QueueGroup {
  readonly key: string;
  readonly daemonId: string;
  readonly machine: string;
  readonly sessionId: string;
  readonly ferret: string;
  readonly rows: readonly QueueRow[];
}

/** Only ferrets with something waiting, the longest-waiting first. */
export const waitingGroups = (groups: readonly QueueGroup[]): readonly QueueGroup[] =>
  groups
    .map(group => ({ ...group, rows: group.rows.filter(isWaitingRow) }))
    .filter(group => group.rows.length > 0)
    .sort((a, b) => (a.rows[0]?.at ?? '').localeCompare(b.rows[0]?.at ?? '') || a.key.localeCompare(b.key));

/** "3 waiting for connection" — the one line a count of saved-on-device messages reads as. */
export const waitingCountLine = (count: number): string =>
  count === 0 ? 'nothing is waiting' : count === 1 ? '1 message is waiting' : `${count} messages are waiting`;
