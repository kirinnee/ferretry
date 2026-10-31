import { describe, expect, test } from 'bun:test';
import type { AgendaItem } from '@ferretry/protocol';
import { cardModel } from '../../src/lib/agenda-card-model.ts';
import { cardRow } from '../../src/lib/agenda-card-row.ts';
import { swipeMap } from '../../src/lib/agenda-inbox.ts';
import { agendaItem, choices } from '../support/agenda-inbox.tsx';

const row = (extra: Partial<AgendaItem>) => {
  const item = agendaItem('A5', extra);
  return { item, ...cardRow(item, cardModel(item)) };
};
const directions = (answers: ReturnType<typeof row>['answers']) =>
  answers.map(answer => `${answer.direction}:${answer.label}`);
const choice = (action: unknown) => (action as { response?: { choice?: string } } | undefined)?.response?.choice;

describe('the answer row of an open card', () => {
  test('reads in the options list’s order — ← ↑ → — wherever the recommendation sits, and swipes match', () => {
    const { answers, map } = row({
      ask: choices('Pause', 'Switch', 'Warn'),
      recommendation: { decision: 'Pause' },
    } as Partial<AgendaItem>);
    expect(directions(answers)).toEqual(['left:Pause', 'up:Switch', 'right:Warn']);
    expect([choice(map.left), choice(map.up), choice(map.right)]).toEqual(['Pause', 'Switch', 'Warn']);
  });

  test('puts two options on ← and →', () => {
    const { answers, map } = row({ ask: choices('Yes', 'No') } as Partial<AgendaItem>);
    expect(directions(answers)).toEqual(['left:Yes', 'right:No']);
    expect(map.up).toBeUndefined();
  });

  test('puts a lone option on ↑', () => {
    expect(directions(row({ ask: choices('Ship it') } as Partial<AgendaItem>).answers)).toEqual(['up:Ship it']);
  });

  test('keeps the card’s own directions for answers that are not options, and a choice past three', () => {
    const permission = row({ ask: { kind: 'permission' } } as Partial<AgendaItem>);
    expect(permission.map).toEqual(swipeMap(permission.item));
    const many = row({ ask: choices('A1', 'B2', 'C3', 'D4') } as Partial<AgendaItem>);
    expect(many.answers).toHaveLength(3);
    expect(directions(many.answers).map(entry => entry.split(':')[0])).toEqual(['left', 'up', 'right']);
    const none = cardRow(agendaItem('A6', { kind: 'info' } as Partial<AgendaItem>), { answers: [] });
    expect(none.answers).toEqual([]);
  });
});
