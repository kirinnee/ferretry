/**
 * THE ANSWER THE READER JUST GAVE, in the item's conversation at once.
 *
 * An Inbox answer waits out its undo window (`DeferredAgendaActions`) before anything is posted, so for those seconds the
 * machine's item still shows no answer and the conversation under it reads as if the owner had said nothing. This turns
 * what the inbox is holding for ONE item into the History line the owner expects, drawn with the receipt of the words
 * still on this device: held, being sent, or refused with the machine's reason.
 *
 * It RECONCILES instead of remembering. The line is a pure function of the inbox's own state, so Undo (the entry leaves
 * `pending`), a refusal (it moves to `failed`, drawn "Not sent") and a commit (it leaves `sending`) need no extra
 * bookkeeping; and a line is dropped once the item itself already carries the answer it stands for, so the machine's echo
 * never draws it twice.
 */

import type { AgendaItem } from '@ferretry/core-asks/contract';
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

/** Whether the item already records the answer given at `at`: its own, or a task ask's. Then the echo has arrived. */
const itemHoldsAnswer = (item: AgendaItem, at: number): boolean =>
  [item.ownerAnswer?.at, ...(item.cardAsks ?? []).map(ask => ask.answer?.at)].some(
    stored => stored !== undefined && Date.parse(stored) >= at,
  );

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
    entry: { readonly action: InboxAction; readonly at: number },
    reason: string,
    refused: boolean,
  ): readonly HistoryEvent[] => {
    // A snooze is no answer; and an answer the item already records is the echo of this one.
    if (entry.action.kind === 'snooze' || entry.action.kind === 'unsnooze' || itemHoldsAnswer(item, entry.at))
      return [];
    const form = formOf(entry.action);
    const note = noteOf(entry.action);
    return [
      {
        kind: 'owner',
        key: `pending:${key}:${String(entry.at)}`,
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
