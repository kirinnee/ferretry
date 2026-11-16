// THE QUEUE VIEWS, AS PURE DECISIONS.
//
// One row per message that has not finished its way to the ferret: still on this device (the outbox, tick 1),
// on the machine's queue, typed and awaiting proof, or read. The views draw these rows; nothing here reads
// a network or a clock.

import { relativeTime } from '@ferretry/app';
import type { QueuedMessage } from '../../contract/index.ts';
import { type OutboxEntry, WAITING_REASON } from '../composer/send-outbox.ts';
import { WAIT_REASON_COPY } from './send-queue.ts';

/** How urgent the sender said it is (`fy send --kind`); a message with no label is an `action`. */
type QueueKind = NonNullable<QueuedMessage['label']>;

/** `saved` is the browser's own outbox; the rest are the daemon queue's states. */
type QueueRowState = 'saved' | QueuedMessage['state'];

export interface QueueRow {
  readonly id: string;
  readonly daemonId: string;
  readonly ferretId: string;
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
  /** Whose message: the owner's own (delivered first, alone), a ferret's, or the daemon's (Board, Warden…). */
  readonly origin: 'owner' | 'ferret' | 'daemon';
  /** When the queue stops holding a ferret's message to combine it with others; absent: never held. */
  readonly holdUntil?: string;
  /** Who sent it, when it is not the owner: a ferret's name or "Ferretry · Board". Never text in the body. */
  readonly sender?: string;
  /** Still changeable: on this device, or queued and not typed yet. */
  readonly editable: boolean;
  readonly refused?: true;
  /** Why it waits, when the daemon says (`QueuedMessage.waitReason`). */
  readonly waitReason?: NonNullable<QueuedMessage['waitReason']>;
}

const originOf = (message: QueuedMessage): QueueRow['origin'] =>
  message.sender === 'human' ? 'owner' : message.sender === 'agent' ? 'ferret' : 'daemon';

/** The name the sender goes by: a ferret's, or "Ferretry · Board"; nothing for the owner. */
const senderOf = (message: QueuedMessage): string | undefined => {
  const origin = originOf(message);
  if (origin === 'owner') return undefined;
  const by = message.by;
  if (origin === 'ferret')
    return (by?.kind === 'ferret' ? by.name : undefined) ?? message.fromName ?? message.from ?? 'A ferret';
  return by?.kind === 'ferretry' && by.feature !== undefined ? `Ferretry · ${by.feature}` : 'Ferretry';
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

export const queueRowOf = (daemonId: string, ferretId: string, ferret: string, message: QueuedMessage): QueueRow => {
  const sender = senderOf(message);
  return {
    id: message.id,
    daemonId,
    ferretId,
    ferret,
    text: message.text,
    state: message.state,
    why: message.state === 'queued' ? queuedWhy(message) : (message.failure ?? WHY[message.state]),
    at: message.enqueuedAt,
    kind: message.label ?? 'action',
    origin: originOf(message),
    ...(message.holdUntil === undefined ? {} : { holdUntil: message.holdUntil }),
    editable: message.state === 'queued',
    ...(message.waitReason === undefined ? {} : { waitReason: message.waitReason }),
    ...(sender === undefined ? {} : { sender }),
  };
};

export const outboxRowOf = (ferret: string, entry: OutboxEntry): QueueRow => ({
  id: entry.id,
  daemonId: entry.daemonId,
  ferretId: entry.ferretId,
  ferret,
  text: entry.message,
  state: 'saved',
  why: entry.reason ?? WAITING_REASON,
  at: entry.createdAt,
  kind: 'action',
  origin: 'owner',
  editable: true,
  ...(entry.refused === true ? { refused: true as const } : {}),
});

/** Messages the ferret has not finished with — what "waiting" means in the All-queues view. */
export const isWaitingRow = (row: QueueRow): boolean =>
  row.state === 'saved' || row.state === 'queued' || row.state === 'typing' || row.state === 'unconfirmed';

/** Not yet typed into the ferret: the rows whose turn is still to come. */
const isPendingRow = (row: QueueRow): boolean => row.state === 'saved' || row.state === 'queued';

const isHeld = (row: QueueRow, now: number): boolean => row.holdUntil !== undefined && Date.parse(row.holdUntil) > now;

/**
 * Where a row stands in the ferret's delivery, as the daemon plans it (`planDelivery`): one message is typed at a
 * time; the owner's own messages go first, each alone. Then, if ANY pending ferret message is due (no hold, or its
 * hold ended), the daemon flushes every pending ferret message together — held ones included — in the order the
 * queue accepted them, and the daemon's own notices (Board, Warden…) go after that batch. If none is due, a notice
 * may pass the held ferret messages. What is finished comes last. The kind says how soon a ferret's message is
 * due; it does not reorder the list by itself.
 */
const rankerFor = (rows: readonly QueueRow[], now: number): ((row: QueueRow) => number) => {
  const ferretDue = rows.some(row => isPendingRow(row) && row.origin === 'ferret' && !isHeld(row, now));
  return row => {
    if (row.state === 'typing') return 0;
    if (!isPendingRow(row)) return row.state === 'unconfirmed' ? 1 : 5;
    if (row.origin === 'owner') return 2;
    if (row.origin === 'ferret') return ferretDue ? 3 : 4;
    return ferretDue ? 4 : 3;
  };
};

/** The order the ferret will meet its messages in; oldest first within the same standing. */
export const orderedRows = (rows: readonly QueueRow[], now: number = Date.now()): readonly QueueRow[] => {
  const rank = rankerFor(rows, now);
  return [...rows].sort((a, b) => rank(a) - rank(b) || a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
};

/** The id of the row that is delivered next: the first one still to come, if any. */
export const nextRowId = (rows: readonly QueueRow[], now: number = Date.now()): string | undefined =>
  orderedRows(rows, now).find(isPendingRow)?.id;

/** Who the message is from: the sender's name, or "You" for the owner's own. */
export const fromLabel = (row: QueueRow): string => row.sender ?? 'You';

/** "14m ago" — how long it has waited. Empty (nothing is claimed) when the instant cannot be read. */
export const queuedAgo = (at: string, now: number): string => {
  const ago = relativeTime(at, now);
  return ago === '—' ? '' : ago === 'now' ? 'just now' : ago;
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
  ferretId: string,
  ferret: string,
  messages: readonly QueuedMessage[],
  entries: readonly OutboxEntry[],
  now: number = Date.now(),
): readonly QueueRow[] => {
  const known = new Set(messages.map(message => message.id));
  return orderedRows(
    [
      ...messages
        .filter(message => message.state !== 'cancelled')
        .map(message => queueRowOf(daemonId, ferretId, ferret, message)),
      ...entries
        .filter(entry => entry.daemonId === daemonId && entry.ferretId === ferretId && !known.has(entry.id))
        .map(entry => outboxRowOf(ferret, entry)),
    ],
    now,
  );
};

/** One heading's worth of the All-queues view: a ferret and what waits for it. */
export interface QueueGroup {
  readonly key: string;
  readonly daemonId: string;
  readonly machine: string;
  readonly ferretId: string;
  readonly ferret: string;
  readonly rows: readonly QueueRow[];
}

/** When the longest-waiting message of these rows was queued (rows may be listed in delivery order, not age). */
const oldestAt = (rows: readonly QueueRow[]): string =>
  rows.reduce((oldest, row) => (oldest === '' || row.at < oldest ? row.at : oldest), '');

/** Only ferrets with something waiting, the longest-waiting first. */
export const waitingGroups = (groups: readonly QueueGroup[]): readonly QueueGroup[] =>
  groups
    .map(group => ({ ...group, rows: group.rows.filter(isWaitingRow) }))
    .filter(group => group.rows.length > 0)
    .sort((a, b) => oldestAt(a.rows).localeCompare(oldestAt(b.rows)) || a.key.localeCompare(b.key));

/** "3 waiting for connection" — the one line a count of saved-on-device messages reads as. */
export const waitingCountLine = (count: number): string =>
  count === 0 ? 'nothing is waiting' : count === 1 ? '1 message is waiting' : `${count} messages are waiting`;

/** What a queued message with no time says it waits for. */
export const TURN_ENDS_COPY = 'when its turn ends';

/** What a queued message whose hold has run out (or is exactly up) says: the daemon sends it without waiting. */
export const DUE_NOW_COPY = 'due now';

/**
 * When a queued row goes, in the reader's words: `{ at }` while its hold still has time to run ("sends by
 * 11:20"), `{ due: true }` once a hold has run out (at or before now) with nothing else in the way — the daemon
 * treats an expired hold as due immediately, it does not wait for the turn — `{ turn: true }` for a queued
 * message with no hold at all that is just waiting for a busy ferret's turn to end, and `undefined` for everything else (on this device, typed, a stopped ferret — its `why`
 * already says).
 */
export type RowSend = { readonly at: string } | { readonly due: true } | { readonly turn: true };

export const rowSend = (row: QueueRow, nowMs: number): RowSend | undefined => {
  if (row.state !== 'queued') return undefined;
  // Something other than the turn is in the way (a question, a draft, a stopped ferret…): the daemon can hold a
  // future-dated row behind it, so no clock time is promised — the row's own reason says what it waits for.
  if (row.waitReason !== undefined && row.waitReason !== 'busy') return undefined;
  const held = row.holdUntil === undefined ? Number.NaN : Date.parse(row.holdUntil);
  if (Number.isFinite(held) && held > nowMs && row.holdUntil !== undefined) return { at: row.holdUntil };
  if (Number.isFinite(held) && row.waitReason === undefined) return { due: true };
  return { turn: true };
};

/**
 * A ferret's next send: due now when any row's hold has run out, else the earliest hold still running, else the
 * turn's end when a row waits on it.
 */
export const groupNextSend = (group: QueueGroup, nowMs: number): RowSend | undefined => {
  let earliest: { readonly at: string; readonly ms: number } | undefined;
  let turn = false;
  for (const row of group.rows) {
    const send = rowSend(row, nowMs);
    if (send === undefined) continue;
    if ('due' in send) return send;
    if ('turn' in send) {
      turn = true;
      continue;
    }
    const ms = Date.parse(send.at);
    if (earliest === undefined || ms < earliest.ms) earliest = { at: send.at, ms };
  }
  return earliest !== undefined ? { at: earliest.at } : turn ? { turn: true } : undefined;
};
