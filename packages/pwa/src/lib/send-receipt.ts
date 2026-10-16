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
 * `read` is the one state the ledger does not hold. It is a delivered send with an assistant reply
 * after it in the loaded transcript — the agent has demonstrably handled the turn that carried it.
 */

import { sendBadge } from './send-badge.ts';
import type { LedgerSendRecord } from './send-ledger.ts';

export type SendReceiptKind = 'sending' | 'held' | 'queued' | 'delivered' | 'read' | 'unconfirmed' | 'failed';

export interface SendReceipt {
  readonly kind: SendReceiptKind;
  /** The accessible name — "Delivered", "Queued" — and the tooltip's first line. */
  readonly name: string;
  /** Why, in the daemon's proven words; read out on tap and in the tooltip. */
  readonly detail: string;
  /** A small word beside the mark, only for a state that needs the reader. */
  readonly chip?: string;
}

const READ_DETAIL = 'the agent has replied since this message arrived';

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
 * | `delivered` + a reply after it      | `read`        | two accent ticks| —               |
 * | `unaccounted`                       | `unconfirmed` | faint question  | "unconfirmed"   |
 * | `timed_out`                         | `failed`      | small red !     | "not delivered" |
 */
export const sendReceipt = (record: LedgerSendRecord, answered = false): SendReceipt => {
  const { detail } = sendBadge(record);
  switch (record.fate) {
    case 'delivered':
      return answered
        ? { kind: 'read', name: 'Read', detail: `${detail}; ${READ_DETAIL}` }
        : { kind: 'delivered', name: 'Delivered', detail };
    case 'timed_out':
      return { kind: 'failed', name: 'Not delivered', detail, chip: 'not delivered' };
    case 'unaccounted':
      return { kind: 'unconfirmed', name: 'Unconfirmed', detail, chip: 'unconfirmed' };
    default:
      if (record.held === true) return { kind: 'held', name: 'Held for revive', detail };
      if (record.fate === 'queued') return { kind: 'queued', name: 'Queued', detail };
      return { kind: 'sending', name: 'Sending', detail };
  }
};

/** A message's time as the bubble shows it (`HH:MM`) and as its tooltip spells it out (`HH:MM:SS`). */
export interface MessageClock {
  readonly short: string;
  readonly full: string;
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** The reader's local wall-clock time of an instant; `undefined` for one that does not parse. */
export const clockOfInstant = (at: number | string | undefined): MessageClock | undefined => {
  if (at === undefined) return undefined;
  const date = new Date(typeof at === 'number' ? at : Date.parse(at));
  if (!Number.isFinite(date.getTime())) return undefined;
  const short = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return { short, full: `${short}:${pad(date.getSeconds())}` };
};

const LABEL_CLOCK = /·\s*(\d{2}):(\d{2}):(\d{2})$/u;

/**
 * The clock a transcript label carries — "You · 13:58:44" — which is the daemon's own printed time and
 * the only time a log-derived row has. `undefined` when the label carries none.
 */
export const clockOfLabel = (label: string | undefined): MessageClock | undefined => {
  const match = LABEL_CLOCK.exec(label ?? '');
  if (match === null) return undefined;
  const short = `${match[1]}:${match[2]}`;
  return { short, full: `${short}:${match[3]}` };
};
