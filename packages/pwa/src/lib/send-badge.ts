import type { SendCancelEffect, SendUnaccountedReason } from '@ferretry/protocol';
import type { LedgerSendRecord } from './send-ledger.ts';
import { isSessionEndedTimeout } from './send-ledger.ts';
import { WAIT_REASON_COPY } from './send-queue.ts';

export interface SendBadge {
  readonly label: string;
  /** Utility classes. Never error-red for an unconfirmed row — see below. */
  readonly tone: string;
  /** Long-form explanation, used for `title`, the tap-to-read line AND the screen-reader text, so the
   *  state is never carried by colour alone. */
  readonly detail: string;
}

const WAITING_TONE = 'border-warn-border bg-warn-bg text-warn';
const QUIET_TONE = 'border-border bg-surface-2 text-muted';

/**
 * Why a send settled without proof, in plain words. Each says what is KNOWN — never more.
 */
const REASONS: Readonly<Record<SendUnaccountedReason, string>> = {
  timeout: 'the agent was still holding it after a long wait',
  session_ended: 'the session ended before it arrived',
  composer_discarded: 'the agent’s queue let go of it before reading it',
  transcript_unreadable: 'the agent’s transcript could not be read, so arrival could not be checked',
  transcript_unbound:
    'Ferretry can’t find a transcript it can prove is this session’s, so it can’t check what the agent received',
  pane_unreadable: 'the agent’s screen could not be read, so arrival could not be checked',
  blocked_by_prompt: 'a prompt on the agent’s screen is waiting for an answer, so it could not be typed',
  revive_unconfirmed: 'the session was revived to hand it over, but its transcript never showed it arriving',
  landing_unconfirmed: 'it was typed into the agent’s box, but the agent didn’t show it there in time',
  not_delivered: 'it never reached the agent',
};

/** What cancelling did on the agent’s screen — only some of it can be undone there, so each says which. */
const CANCEL_EFFECTS: Readonly<Record<SendCancelEffect, string>> = {
  cleared: 'removed, and erased from the agent’s composer',
  not_in_pane: 'removed; it never reached the agent',
  left_in_queue: 'removed here, but the agent was already holding it in its own queue and may still read it',
  left_in_composer: 'removed here; the agent’s composer held other text too, so it was left as it was',
};

const reasonOf = (record: LedgerSendRecord): string =>
  record.unaccountedReason === undefined ? 'arrival could not be checked' : REASONS[record.unaccountedReason];

/** The clock time a ledger read last succeeded, in this reader's own locale. */
const readAt = (since: string): string =>
  new Date(since).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

const attempts = (record: LedgerSendRecord): string => {
  const count = record.attempt ?? 1;
  return count === 1 ? '1 attempt' : `${count} attempts`;
};

/**
 * A message the durable queue holds says where it is in the queue's own words, and a plain reason when it
 * waits. Rows the queue never saw, and rows the agent has (delivered) or a person took back from the
 * ledger, keep the ledger's words.
 */
const queueBadge = (record: LedgerSendRecord): SendBadge | undefined => {
  const queue = record.queue;
  if (queue?.state === 'read' && record.fate === 'delivered')
    return {
      label: 'read',
      tone: 'border-ok-border bg-ok-bg text-ok',
      detail: 'the agent has read it — its transcript shows it as a message from you',
    };
  if (queue === undefined || record.fate === 'delivered' || record.fate === 'cancelled') return undefined;
  switch (queue.state) {
    case 'queued':
      return {
        label: 'queued',
        tone: WAITING_TONE,
        detail:
          queue.waitReason === undefined ? 'waiting for its turn' : `waiting: ${WAIT_REASON_COPY[queue.waitReason]}`,
      };
    case 'typing':
      return { label: 'sending', tone: QUIET_TONE, detail: 'sending — it is being typed into the agent now' };
    case 'failed':
      if (record.fate === 'unaccounted')
        return {
          label: 'unconfirmed',
          tone: QUIET_TONE,
          detail: queue.failure ?? 'nothing proves it reached the agent, though it may have',
        };
      return {
        label: 'failed',
        tone: 'border-err-border bg-err-bg text-err',
        detail: queue.failure ?? 'it could not be delivered',
      };
    default:
      return undefined;
  }
};

/**
 * The chip for a send. Every word is a claim the daemon has PROVEN:
 *
 *   * `sending` — the daemon has it and is checking where it went. Nothing more is known yet.
 *   * `queued` — the agent's own queue is holding it (its transcript or its screen says so), and it
 *     will be read when the current turn ends. Never shown for a merely busy agent.
 *   * `delivered` — the agent's transcript shows the message.
 *   * `not delivered` — proven absent after every attempt; Retry is safe because it cannot duplicate.
 *   * `unconfirmed` — could be proven neither way. NOT an error, and never red: it may well have
 *     landed, and red invites a resend that would make the agent read it twice.
 */
export const sendBadge = (record: LedgerSendRecord): SendBadge => {
  const queued = queueBadge(record);
  if (queued !== undefined) return queued;
  if (record.fate === 'delivered')
    return {
      label: 'delivered',
      tone: 'border-ok-border bg-ok-bg text-ok',
      detail:
        record.evidence?.tier === 'merged-text'
          ? 'the agent’s transcript shows this message, delivered joined with the message next to it'
          : 'the agent’s transcript shows this message',
    };
  if (record.fate === 'cancelled')
    return {
      label: 'cancelled',
      tone: QUIET_TONE,
      detail:
        record.cancelEffect !== undefined
          ? CANCEL_EFFECTS[record.cancelEffect]
          : record.queue?.state === 'cancelled'
            ? 'taken back before it was typed; the agent never saw it'
            : 'taken back; what that did on the agent’s screen is not known',
    };
  if (record.fate === 'timed_out' && !isSessionEndedTimeout(record))
    return {
      label: 'not delivered',
      tone: 'border-err-border bg-err-bg text-err',
      detail: `timed out — ${reasonOf(record)} (${attempts(record)})`,
    };
  if (record.fate === 'unaccounted' || record.fate === 'timed_out')
    return {
      label: 'unconfirmed',
      tone: QUIET_TONE,
      detail: `unconfirmed — ${reasonOf(record)}; it may still have landed`,
    };
  // AN OPEN ROW THIS BROWSER CAN NO LONGER READ says that, and why, instead of the last fate it saw:
  // "the daemon has it and is checking" was the sentence a phone kept showing after the daemon had
  // long since settled the message. Quiet, never red — it may well have arrived.
  if (record.unread !== undefined)
    return {
      label: 'status unknown',
      tone: QUIET_TONE,
      detail: `Ferretry has not been able to read where this message went since ${readAt(record.unread.since)} (${record.unread.reason}); it may still have arrived`,
    };
  if (record.typedNotSent === true)
    return {
      label: 'typed, not sent',
      tone: WAITING_TONE,
      detail: 'it is sitting in the agent’s composer; press Enter to send it or cancel it',
    };
  if (record.held === true)
    return {
      label: 'held for revive',
      tone: WAITING_TONE,
      detail: 'kept safely; it will be delivered when this session is revived',
    };
  if (record.fate === 'queued')
    return {
      label: 'queued',
      tone: WAITING_TONE,
      detail: 'the agent is holding it in its own queue and will read it when its current turn ends',
    };
  return {
    label: 'sending',
    tone: QUIET_TONE,
    detail:
      (record.attempt ?? 1) > 1
        ? `sending again (${attempts(record)}) — the first try was proven not to have arrived`
        : 'the daemon has it and is checking that it reached the agent',
  };
};
