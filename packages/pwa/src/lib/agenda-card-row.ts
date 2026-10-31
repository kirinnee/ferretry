/**
 * THE ANSWER ROW OF AN OPEN AGENDA CARD, IN THE OPTIONS LIST'S ORDER. When every answer on the row is one of the
 * item's options, the row reads exactly as the list above it does — the first option ←, the second ↑, the third →
 * (two options: ← and →; one: ↑) — wherever the recommendation sits; the recommended one keeps its outline in its
 * place. Each button's arrow is the swipe and the key that sends it, so the swipes are re-pointed to match.
 *
 * Answers that are not options (Allow / Deny, Done / Need more info) keep the directions the card gave them: those
 * mean something on their own. Pure.
 */

import type { AgendaCardAnswer, AgendaDirection, AgendaItem } from '@ferretry/protocol';
import { answerAction } from './agenda-answers.ts';
import type { CardModel } from './agenda-card-model.ts';
import { type SwipeMap, swipeMap } from './agenda-inbox.ts';
import { itemOptions } from './agenda-options.ts';

export interface CardRow {
  /** The row's answers, each pointed at the direction its place on the row says. */
  readonly answers: readonly AgendaCardAnswer[];
  /** What each swipe and arrow key sends: the same answers, by those directions. */
  readonly map: SwipeMap;
}

/** Where the row's buttons sit, by how many there are. */
const SLOTS: Readonly<Record<number, readonly AgendaDirection[]>> = {
  1: ['up'],
  2: ['left', 'right'],
  3: ['left', 'up', 'right'],
};

const key = (label: string): string => label.trim().toLowerCase();

export const cardRow = (item: AgendaItem, model: Pick<CardModel, 'answers'>): CardRow => {
  const order = itemOptions(item).map(option => key(option.label));
  const slots = SLOTS[model.answers.length];
  const listed =
    slots !== undefined && model.answers.every(answer => answer.does === 'choose' && order.includes(key(answer.label)));
  if (!listed) return { answers: model.answers, map: swipeMap(item) };
  const answers = model.answers
    .toSorted((a, b) => order.indexOf(key(a.label)) - order.indexOf(key(b.label)))
    .map((answer, at) => ({ ...answer, direction: slots[at] ?? answer.direction }));
  const map: SwipeMap = Object.fromEntries(
    answers.flatMap(answer => {
      const action = answerAction(answer, '');
      return action === null ? [] : [[answer.direction, action]];
    }),
  );
  return { answers, map };
};
