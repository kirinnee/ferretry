/**
 * THE ANSWER THE READER JUST GAVE, in the item's conversation at once.
 *
 * An Inbox answer waits out its undo window (`DeferredAgendaActions`) before anything is posted, so for those seconds the
 * machine's item still shows no answer and the conversation under it reads as if the owner had said nothing. This turns
 * what the inbox is holding for ONE item into the History line the owner expects, drawn with the receipt of the words
 * still on this device: held, being sent, or refused with the machine's reason.
 *
 * It RECONCILES instead of remembering. The line is a pure function of the receipts (`AnswerReceipts`), so Undo (the
 * receipt leaves `pending`), a refusal (it moves to `failed`, drawn "Not sent") and a commit (it leaves `sending`) need no
 * extra bookkeeping; and a line is dropped once the item itself already carries THIS answer — the same words to the same
 * ask, never judged by a clock — so the machine's echo never draws it twice.
 */

import { type AgendaItem, taskAskOf } from '@ferretry/core-asks/contract';
import type { HistoryEvent } from './agenda-history.ts';
import type { InboxAction } from './agenda-answers.ts';
import type { DeferredAgendaState } from './agenda-inbox.ts';

/** The words of the answer, as the owner chose them: a choice's label, "Done", a dismissal's own label. */
const wordsOf = (action: InboxAction): string => action.label;

const noteOf = (action: InboxAction): string | undefined =>
  action.kind === 'snooze' || action.kind === 'unsnooze' || action.note === undefined || action.note.trim() === ''
    ? undefined
    : action.note;

const formOf = (action: InboxAction): 'answer' | 'done' | undefined =>
  action.kind === 'respond' ? 'answer' : action.kind === 'resolve' ? 'done' : undefined;

const sameJson = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(name => sameJson((left as Record<string, unknown>)[name], (right as Record<string, unknown>)[name]))
  );
};

const wordsOnly = (note: string | undefined): string => (note ?? '').trim();

/**
 * Whether the item already records THIS answer: the same response and note, to the same ask. An answer is its own
 * echo's identity — never a clock, which the machine and this device do not share. A different answer (another
 * device's Hold while this Ship is still queued) is not it, and the one that matches is drawn once, by the item.
 *
 * A task ask is named by its reference; an item's own ask by its version. Only an answer to a question has an echo: a
 * Done, a dismissal and the rest leave when they settle.
 */
const itemHoldsAnswer = (item: AgendaItem, action: InboxAction): boolean => {
  if (action.kind !== 'respond') return false;
  const recorded =
    action.cardAsk === undefined
      ? item.ownerAnswer === undefined || (item.askVersion ?? 1) !== (action.askVersion ?? 1)
        ? undefined
        : item.ownerAnswer
      : taskAskOf(item, action.cardAsk)?.answer;
  return (
    recorded !== undefined &&
    sameJson(recorded.response, action.response) &&
    wordsOnly(recorded.note) === wordsOnly(action.note)
  );
};

/**
 * The History lines for the answers held, being sent or refused for the card `key`, oldest first. Empty when the inbox holds
 * nothing for it, or when the item already shows the answer.
 */
export const pendingAnswerEvents = (
  state: DeferredAgendaState,
  key: string,
  item: AgendaItem,
): readonly HistoryEvent[] => {
  const line = (
    entry: { readonly id: string; readonly action: InboxAction; readonly at: number },
    reason: string,
    refused: boolean,
  ): readonly HistoryEvent[] => {
    // A snooze is no answer; and an answer the item already records is the echo of this one.
    if (entry.action.kind === 'snooze' || entry.action.kind === 'unsnooze' || itemHoldsAnswer(item, entry.action))
      return [];
    const form = formOf(entry.action);
    const note = noteOf(entry.action);
    return [
      {
        kind: 'owner',
        key: `pending:${entry.id}`,
        at: entry.at,
        text: wordsOf(entry.action),
        ...(form === undefined ? {} : { form }),
        ...(note === undefined ? {} : { note }),
        reached: { via: 'device', answered: false, outbox: { reason, refused } },
      },
    ];
  };
  return [
    ...state.pending
      .filter(entry => entry.key === key)
      .flatMap(entry => line(entry, 'sends when the undo window closes', false)),
    ...state.sending.filter(entry => entry.key === key).flatMap(entry => line(entry, 'being sent now', false)),
    ...state.failed.filter(entry => entry.key === key).flatMap(entry => line(entry, entry.message, true)),
  ];
};
