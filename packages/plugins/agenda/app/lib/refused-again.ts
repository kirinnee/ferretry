/**
 * A RETRIED ANSWER THE MACHINE REFUSED AGAIN, FOUND ON THE BOARD. A retry the daemon accepts is not a failed send: the
 * refusal comes later, as the item's own `undelivered` on the next board read, with a new `at`. The receipts
 * (`DeferredAgendaState.failed`) never hear of it, so this reads the boards against what the reader retried.
 *
 * `RetriedAnswers` maps each retried task to the `at` of the refusal it was retried from. A task that is back with an
 * `undelivered` of any OTHER `at` was refused again. Nothing here holds a clock or a store: the caller keeps the map.
 */

import { RETRY_LABEL } from './agenda-answers.ts';
import type { DeferredAgendaState, InboxCard } from './agenda-inbox.ts';

/** Task key to the `at` of the refusal it was retried from. */
export type RetriedAnswers = ReadonlyMap<string, string>;

/** The retries the reader has given and not yet settled: held in their undo window, or on their way. */
export const withRetriesOf = (known: RetriedAnswers, state: DeferredAgendaState): RetriedAnswers => {
  let next: Map<string, string> | undefined;
  for (const entry of [...state.pending, ...state.sending]) {
    const refusedAt = entry.card.item.undelivered?.at;
    if (entry.action.label !== RETRY_LABEL || refusedAt === undefined || known.get(entry.key) === refusedAt) continue;
    next ??= new Map(known);
    next.set(entry.key, refusedAt);
  }
  return next ?? known;
};

/**
 * What the reader has no more use for: a retry whose task is open (its own view says the refusal), has gone off the
 * list (it was delivered), or is back without a refusal. A retry still held or on its way is kept.
 */
export const withoutSettledRetries = (
  known: RetriedAnswers,
  cards: readonly InboxCard[],
  open: ReadonlySet<string>,
  state: DeferredAgendaState,
): RetriedAnswers => {
  const hidden = new Set([...state.pending, ...state.sending].map(entry => entry.key));
  let next: Map<string, string> | undefined;
  for (const key of known.keys()) {
    if (hidden.has(key)) continue;
    const card = cards.find(each => each.key === key);
    if (card !== undefined && card.item.undelivered !== undefined && !open.has(key)) continue;
    next ??= new Map(known);
    next.delete(key);
  }
  return next ?? known;
};

/** The retried tasks the board now says were refused again, whose own view is not the one the reader is on. */
export const refusedAgain = (
  known: RetriedAnswers,
  cards: readonly InboxCard[],
  open: ReadonlySet<string>,
): readonly InboxCard[] =>
  cards.filter(card => {
    const { undelivered } = card.item;
    const was = known.get(card.key);
    return undelivered !== undefined && was !== undefined && undelivered.at !== was && !open.has(card.key);
  });
