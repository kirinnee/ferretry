// WAITING MESSAGES, HIDDEN FROM THE CHAT.
//
// A message that has not gone into the ferret yet — the owner's send saved on this device, a send in the
// machine's queue, a ferret's note held to be combined with others — is not part of the conversation, so
// the chat does not draw it at all (the owner's call, 2026-11-04: "hide fully"). It lives on the Queue
// page, where each can be read, edited or taken back, and appears in the chat once it is delivered. A
// message that needs the person (failed, refused, unconfirmed, typed but not sent) is NOT waiting and stays.
// Pure decisions: no clock, no network.

import type { LedgerSendRecord } from '../shell.ts';
import { effectiveQueueState } from '../shell.ts';
import type { TranscriptEntry } from '../shell.ts';

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
export const hideWaiting = (entries: readonly TranscriptEntry[]): readonly TranscriptEntry[] => {
  const kept = entries.filter(
    entry =>
      entry.kind !== 'ledger' ||
      entry.ledger === undefined ||
      entry.settled !== undefined ||
      !isWaitingSend(entry.ledger),
  );
  return kept.length === entries.length ? entries : kept;
};
