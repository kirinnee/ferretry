import type { SendUnaccountedReason } from '@ferretry/protocol';
import { isLedgerUnconfirmed, type LedgerSendRecord } from './send-ledger.ts';

export interface SendBadge {
  readonly label: string;
  /** Utility classes. Never error-red for an unconfirmed row — see below. */
  readonly tone: string;
  /** Long-form explanation, used for `title` AND for the screen-reader text, so
   *  the state is never carried by colour alone. */
  readonly detail: string;
}

const ACCEPTED_TONE = 'border-warn-border bg-warn-bg text-warn';

// UNCONFIRMED IS NOT AN ERROR, AND MUST NOT LOOK LIKE ONE.
//
// A red "failed" badge tells the reader the message did not arrive. That is a
// claim the daemon cannot make: the measured harness dwell between accepting a
// message and the transcript proving it has a p99 of 4.3 minutes and a maximum
// of 19.2 minutes, and the timeout sits generously above that — so a row that
// times out has very often STILL LANDED and we merely lost sight of it. The
// muted tone plus "may still have landed" wording is the honest rendering, and
// it is also the actionable one: red invites a resend, which on a message that
// did arrive means the agent is told the same thing twice.
const UNACCOUNTED_TONE = 'border-border bg-surface-2 text-muted';

const UNACCOUNTED_COPY: Readonly<Record<SendUnaccountedReason | 'unknown', string>> = {
  timeout: 'unconfirmed — this cannot be proved to have reached the agent; it may still have landed',
  session_ended: 'unconfirmed — the session ended before this was confirmed (kept durably; resend to try again)',
  composer_discarded:
    'unconfirmed — the session was interrupted before this was confirmed; it may or may not have been read',
  unknown: 'unconfirmed — this cannot be proved to have reached the agent; it may still have landed',
};

/**
 * The chip for a durable send row. Labels stay short — they sit inside a row of
 * metadata — while the sentence lives in `detail`.
 *
 * ACCEPTED MEANS ONE THING: a durable record was written. That record is
 * appended BEFORE any keystroke reaches the pane, so at that point nothing is
 * known about injection either. Wording like "sent" or "delivered to the pane"
 * overclaims during exactly the window where the uncertainty lives — the same
 * mistake as a green "delivered" on an HTTP 200 — so every branch below stays
 * on this side of the boundary.
 */
export const sendBadge = (record: LedgerSendRecord, nowMs: number = Date.now()): SendBadge => {
  if (isLedgerUnconfirmed(record, nowMs)) {
    return {
      label: 'unconfirmed',
      tone: UNACCOUNTED_TONE,
      detail: UNACCOUNTED_COPY[record.unaccountedReason ?? 'unknown'] ?? UNACCOUNTED_COPY.unknown,
    };
  }
  if (record.fate === 'delivered') {
    return {
      label: 'delivered',
      tone: 'border-ok-border bg-ok-bg text-ok',
      detail: 'the harness transcript confirms this message entered the conversation',
    };
  }
  // A held row waits on a human action, not on the harness.
  if (record.held === true) {
    return {
      label: 'held for revive',
      tone: ACCEPTED_TONE,
      detail: 'kept durably; it will be delivered when this session is explicitly revived',
    };
  }
  // "queued for next turn" is a claim about the HARNESS's input queue, so it is
  // only true on the native queue paths — a direct, turn-file or revive send was
  // never queued in that sense, and saying so would describe a mechanism that
  // did not happen. And once a consumption OPPORTUNITY has passed (the daemon
  // stamps `opportunityAt`), even that wording is stale: the next turn came and
  // went. A badge that ages truthfully is the difference between one a reader
  // trusts and one they learn to ignore.
  const nativeQueue = record.path === 'native-inline' || record.path === 'native-file';
  if (nativeQueue && record.opportunityAt === undefined) {
    return {
      label: 'queued for next turn',
      tone: ACCEPTED_TONE,
      detail: 'accepted and stored durably; it delivers at the next prompt-ready boundary',
    };
  }
  return {
    label: 'accepted — awaiting confirmation',
    tone: ACCEPTED_TONE,
    detail: 'stored durably; waiting for harness transcript proof',
  };
};
