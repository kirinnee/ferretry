import { describe, expect, test } from 'bun:test';
import type { AgendaItem } from '../../../app/wire/index.ts';
import { agendaRunKeys } from '../../../app/features/agenda/agenda-inbox-page.tsx';
import { answerRowLayout, cardModel } from '../../../app/lib/agenda-card-model.ts';
import { agendaItem, choices, inboxCard } from '../../support/app/agenda-inbox.tsx';

const review = agendaItem('A1', { kind: 'review', ask: { kind: 'answer-review' } } as Partial<AgendaItem>);
const two = agendaItem('A2', { ask: choices('Lock the whole session row', 'Wait') });
const three = agendaItem('A3', { ask: choices('Left', 'Middle', 'Right') });

describe('answerRowLayout', () => {
  test('counts the answers the row draws', () => {
    expect(answerRowLayout(cardModel(two), { requestChanges: false, doneClose: false })).toEqual({
      closeInRow: false,
      slots: 2,
    });
  });

  test('counts Request changes only where the row draws it', () => {
    expect(answerRowLayout(cardModel(review), { requestChanges: true, doneClose: false }).slots).toBe(2);
    expect(answerRowLayout(cardModel(review), { requestChanges: false, doneClose: false }).slots).toBe(1);
  });

  test('counts "Done · closes" as a button when it takes the → slot, and not when it sits under three', () => {
    expect(answerRowLayout(cardModel(two), { requestChanges: false, doneClose: true })).toEqual({
      closeInRow: true,
      slots: 3,
    });
    expect(answerRowLayout(cardModel(three), { requestChanges: false, doneClose: true })).toEqual({
      closeInRow: false,
      slots: 3,
    });
  });
});

describe('the run’s arrow-key hints', () => {
  const words = (keys: ReturnType<typeof agendaRunKeys>) => keys.filter(each => '←↑→'.includes(each.key));

  test('cut a label as the open card’s row cuts it: a row of two, or three once "Done · closes" joins it', () => {
    expect(words(agendaRunKeys(inboxCard(two)))).toEqual([
      { key: '←', word: 'Lock the whole session…' },
      { key: '→', word: 'Wait' },
    ]);
    expect(words(agendaRunKeys(inboxCard(two), true))).toEqual([
      { key: '←', word: 'Lock the whole…' },
      { key: '→', word: 'Wait' },
    ]);
  });

  test('count a review’s Request changes, which the open card always draws beside Approve', () => {
    expect(words(agendaRunKeys(inboxCard(review))).map(each => each.word)).toEqual(['Request changes', 'Approve']);
  });
});
