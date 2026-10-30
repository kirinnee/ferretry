/**
 * A SEND'S RECEIPT: where one of the reader's own messages is, as one small mark after its time.
 *
 * The owner asked for the receipt a messaging app has taught everyone to read — a clock, one tick, two
 * ticks, two coloured ticks — instead of a text pill that took a whole row of every bubble. So a final
 * state is a mark and never a pill. The two states that ask the reader to DO something keep a small
 * word beside the mark, because a mark alone cannot say "this needs you":
 *
 *   * `failed` — the daemon proved it never arrived; Retry is offered and stays reachable.
 *   * `unconfirmed` — it could be proven neither way; "send again…" is offered behind its warning.
 *
 * Every word here still comes from `sendBadge`, which owns what each fate CLAIMS. This module only
 * decides how loudly the claim is drawn, so the two cannot disagree about a fate. `name` is the
 * accessible name and the tooltip's first line: a mark is never carried by colour or shape alone.
 *
 * `answered` is the one state the ledger does not hold. It is a delivered send with an assistant reply
 * after it in the loaded transcript — the agent has demonstrably handled the turn that carried it.
 */

import { sendBadge } from './send-badge.ts';
import { effectiveQueueState } from './send-queue.ts';
import { isSessionEndedTimeout, type LedgerSendRecord } from './send-ledger.ts';

export type SendReceiptKind =
  | 'sending'
  | 'saved'
  | 'held'
  | 'queued'
  | 'typed'
  | 'delivered'
  | 'answered'
  | 'read'
  | 'unconfirmed'
  | 'failed'
  | 'cancelled';

export interface SendReceipt {
  readonly kind: SendReceiptKind;
  /** The accessible name — "Delivered", "Queued" — and the tooltip's first line. */
  readonly name: string;
  /** Why, in the daemon's proven words; read out on tap and in the tooltip. */
  readonly detail: string;
  /** A small word beside the mark, only for a state that needs the reader. */
  readonly chip?: string;
}

const ANSWERED_DETAIL = 'the agent has replied since this message arrived';

/**
 * A message still in this device's outbox is tick one: ✓ saved here, with "waiting for connection" (and its place
 * in line when several wait). One a machine refused is not waiting — it needs the person, so it wears the red mark.
 */
const outboxReceipt = (record: LedgerSendRecord, detail: string): SendReceipt | undefined => {
  const outbox = record.outbox;
  if (outbox === undefined) return undefined;
  if (outbox.refused === true) return { kind: 'failed', name: 'Not sent', detail: outbox.reason, chip: 'not sent' };
  const chip = outbox.of > 1 ? `${outbox.reason} · ${outbox.position} of ${outbox.of}` : outbox.reason;
  return { kind: 'saved', name: 'Saved on this device', detail: `${detail}; ${outbox.reason}`, chip };
};

/**
 * A message the durable queue holds draws the queue's tick: ✓✓ queued (with the plain reason it waits), ✓✓ while
 * it is being typed, ✓✓✓ delivered, ✓✓✓✓ read. A delivered ledger fate outranks a queue that has not caught up.
 * Failed and cancelled keep their own marks. `undefined` leaves a row to the ledger mapping below.
 */
const queueReceipt = (record: LedgerSendRecord, detail: string): SendReceipt | undefined => {
  const state = effectiveQueueState(record);
  switch (state) {
    case 'read':
      return { kind: 'read', name: 'Read', detail };
    case 'queued':
      return record.fate === 'cancelled'
        ? undefined
        : {
            kind: 'queued',
            name: 'Queued',
            detail,
            ...(record.queue?.waitReason === undefined ? {} : { chip: detail }),
          };
    case 'typing':
      return record.fate === 'cancelled' ? undefined : { kind: 'queued', name: 'Sending', detail };
    case 'unconfirmed':
      return record.fate === 'cancelled' || record.fate === 'delivered'
        ? undefined
        : { kind: 'unconfirmed', name: 'Unconfirmed', detail, chip: 'unconfirmed' };
    case 'failed':
      if (record.fate === 'cancelled' || record.fate === 'delivered') return undefined;
      return record.fate === 'unaccounted'
        ? { kind: 'unconfirmed', name: 'Unconfirmed', detail, chip: 'unconfirmed' }
        : { kind: 'failed', name: 'Failed', detail, chip: 'failed' };
    default:
      return undefined;
  }
};

/**
 * Every fate the daemon can report, mapped once. The order is `sendBadge`'s: a settled fate outranks
 * `held`, and `held` outranks a plain queue, so a revived session's held send never reads as queued.
 *
 * | daemon state                       | receipt       | mark            | chip            |
 * | ---------------------------------- | ------------- | --------------- | --------------- |
 * | `accepted` (checking where it went) | `sending`     | faint clock     | —               |
 * | `held` (kept for a revive)          | `held`        | faint clock     | —               |
 * | `queued` (in the agent's queue)     | `queued`      | one grey tick   | —               |
 * | `delivered`                         | `delivered`   | two grey ticks  | —               |
 * | `delivered` + a reply after it      | `answered`    | two accent ticks| —               |
 * | `unaccounted`                       | `unconfirmed` | faint question  | "unconfirmed"   |
 * | `timed_out`                         | `failed`      | small red !     | "not delivered" |
 * | `accepted`/`queued` + typed     | `typed`       | pencil          | "typed, not sent" |
 * | `cancelled`                       | `cancelled`   | struck circle   | "cancelled"     |
 * | queue `queued` / `typing`            | `queued`      | one grey tick   | —               |
 * | queue `read`                        | `read`        | three accent ticks | —            |
 * | queue `failed`                      | `failed`      | small red !     | "failed"        |
 * | queue `unconfirmed`                 | `unconfirmed` | faint question  | "unconfirmed"   |
 * | open, ledger unread (`unread`)     | `unconfirmed` | faint question  | "status unknown" |
 */
export const sendReceipt = (record: LedgerSendRecord, answered = false): SendReceipt => {
  const { detail } = sendBadge(record);
  const saved = outboxReceipt(record, detail);
  if (saved !== undefined) return saved;
  const queue = queueReceipt(record, detail);
  if (queue !== undefined) return queue;
  switch (record.fate) {
    case 'delivered':
      return answered
        ? { kind: 'answered', name: 'Answered', detail: `${detail}; ${ANSWERED_DETAIL}` }
        : { kind: 'delivered', name: 'Delivered', detail };
    case 'cancelled':
      return { kind: 'cancelled', name: 'Cancelled', detail, chip: 'cancelled' };
    case 'timed_out':
      if (isSessionEndedTimeout(record))
        return { kind: 'unconfirmed', name: 'Unconfirmed', detail, chip: 'unconfirmed' };
      return { kind: 'failed', name: 'Not delivered', detail, chip: 'not delivered' };
    case 'unaccounted':
      return { kind: 'unconfirmed', name: 'Unconfirmed', detail, chip: 'unconfirmed' };
    default:
      if (record.unread !== undefined)
        return { kind: 'unconfirmed', name: 'Status unknown', detail, chip: 'status unknown' };
      if (record.typedNotSent === true)
        return { kind: 'typed', name: 'Typed, not sent', detail, chip: 'typed, not sent' };
      if (record.held === true) return { kind: 'held', name: 'Held for revive', detail };
      if (record.fate === 'queued') return { kind: 'queued', name: 'Queued', detail };
      return { kind: 'sending', name: 'Sending', detail };
  }
};

/**
 * THE LEGEND: what each mark claims, in the words Settings › Appearance prints beside it. It lives
 * here, beside the mapping, so the legend and the tooltips cannot drift apart. `held` shares the
 * clock with `sending` and is named in its line rather than given a row of its own.
 */
export interface ReceiptLegendRow {
  readonly kind: SendReceiptKind;
  readonly name: string;
  readonly meaning: string;
}

export const RECEIPT_LEGEND: readonly ReceiptLegendRow[] = [
  { kind: 'sending', name: 'Sending', meaning: 'On its way, or kept until the session is revived.' },
  {
    kind: 'saved',
    name: 'Saved on this device',
    meaning:
      'One tick: it is kept on this phone or computer and goes to the machine as soon as there is a connection. You can edit or cancel it until then.',
  },
  {
    kind: 'queued',
    name: 'Queued',
    meaning:
      'Two ticks: it is on the machine’s queue and waiting to be typed in. The message says why when it has to wait: the ferret is busy, its box holds a draft, a question or dialog is open.',
  },
  {
    kind: 'typed',
    name: 'Typed, not sent',
    meaning: 'It is sitting in the agent’s composer. Press Enter on the message to send it, or cancel it.',
  },
  { kind: 'delivered', name: 'Delivered', meaning: 'Three ticks: it was typed into the agent and submitted.' },
  { kind: 'answered', name: 'Answered', meaning: 'The agent replied after it.' },
  {
    kind: 'read',
    name: 'Read',
    meaning: 'Four ticks: the agent took a turn on it, and its transcript shows it as a message from you.',
  },
  { kind: 'unconfirmed', name: 'Unconfirmed', meaning: 'It could not be proven either way.' },
  { kind: 'failed', name: 'Not delivered', meaning: 'It never arrived. Retry is offered on the message.' },
  {
    kind: 'cancelled',
    name: 'Cancelled',
    meaning: 'You took it back. The message says what that did on the agent’s screen.',
  },
];
