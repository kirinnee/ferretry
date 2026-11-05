// THE QUEUE VIEWS, AS PURE DECISIONS.
//
// One row per message that has not finished its way to the ferret: still on this device (the outbox, tick 1),
// on the machine's queue, typed and awaiting proof, or read. The views draw these rows; nothing here reads
// a network or a clock.

import type { QueuedMessage } from '@ferretry/protocol';
import { relativeTime } from './session-screens.ts';
import { type OutboxEntry, WAITING_REASON } from './send-outbox.ts';
import { WAIT_REASON_COPY } from './send-queue.ts';

/** How urgent the sender said it is (`fy send --kind`); a message with no label is an `action`. */
export type QueueKind = NonNullable<QueuedMessage['label']>;

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
  /** Its kind: the sender's label, or `action` when it set none. */
  readonly kind: QueueKind;
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
    kind: message.label ?? 'action',
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
  kind: 'action',
  editable: true,
  ...(entry.refused === true ? { refused: true as const } : {}),
});

/** Messages the ferret has not finished with — what "waiting" means in the All-queues view. */
export const isWaitingRow = (row: QueueRow): boolean =>
  row.state === 'saved' || row.state === 'queued' || row.state === 'typing' || row.state === 'unconfirmed';

/** Not yet typed into the ferret: the rows whose turn is still to come. */
const isPendingRow = (row: QueueRow): boolean => row.state === 'saved' || row.state === 'queued';

/**
 * Where a row stands in the ferret's delivery: what is being typed now, then what is still to come (a
 * `blocker` goes at once, an `action` is combined, an `fyi` is held the longest), then what is finished.
 */
const deliveryRank = (row: QueueRow): number => {
  if (row.state === 'typing') return 0;
  if (!isPendingRow(row)) return row.state === 'unconfirmed' ? 1 : 5;
  return row.kind === 'blocker' ? 2 : row.kind === 'action' ? 3 : 4;
};

/** The order the ferret will meet its messages in; oldest first within the same standing. */
export const orderedRows = (rows: readonly QueueRow[]): readonly QueueRow[] =>
  [...rows].sort((a, b) => deliveryRank(a) - deliveryRank(b) || a.at.localeCompare(b.at) || a.id.localeCompare(b.id));

/** The id of the row that is delivered next: the first one still to come, if any. */
export const nextRowId = (rows: readonly QueueRow[]): string | undefined => orderedRows(rows).find(isPendingRow)?.id;

/** Who the message is from: the sender's name, or "You" for the owner's own. */
export const fromLabel = (row: QueueRow): string => row.sender ?? 'You';

/** "Queued 14m ago" — the time chip. Nothing is claimed when the instant cannot be read. */
export const queuedAgo = (at: string, now: number): string => {
  const ago = relativeTime(at, now);
  return ago === '—' ? 'Queued' : ago === 'now' ? 'Queued just now' : `Queued ${ago}`;
};

/** A message past this many lines, characters or a code block, shows a clamp with "Show more". */
export const CLAMP_LINES = 6;
export const CLAMP_CHARS = 420;

/** Whether a message body is long enough to fold behind "Show more". */
export const needsClamp = (text: string): boolean => {
  const body = text.trim();
  return body.length > CLAMP_CHARS || body.split('\n').length > CLAMP_LINES;
};

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
