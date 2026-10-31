import { describe, expect, test } from 'bun:test';
import type { AgendaItem } from '@ferretry/protocol';
import { cardAnswers, swipeTargets } from '../../src/lib/agenda-answers.ts';
import { agendaItem, choices } from '../support/agenda-inbox.tsx';

const at = (extra: Partial<AgendaItem>) =>
  cardAnswers(agendaItem('A5', extra)).map(answer => `${answer.direction}:${answer.label}`);

describe('one meaning for every swipe: option answers in the options list’s order', () => {
  test('the first option ←, the second ↑, the third →, wherever the recommendation sits', () => {
    expect(at({ ask: choices('Pause', 'Switch', 'Warn'), recommendation: { decision: 'Pause' } } as never)).toEqual([
      'left:Pause',
      'up:Switch',
      'right:Warn',
    ]);
    expect(at({ ask: choices('Pause', 'Switch', 'Warn'), recommendation: { decision: 'Warn' } } as never)).toEqual([
      'left:Pause',
      'up:Switch',
      'right:Warn',
    ]);
  });

  test('two options on ← and →, one on ↑; a lone question’s options count as the list', () => {
    expect(at({ ask: choices('Yes', 'No') })).toEqual(['left:Yes', 'right:No']);
    expect(at({ ask: choices('Ship it') })).toEqual(['up:Ship it']);
    expect(
      at({
        ask: choices('Monday', 'Friday'),
        questions: [{ question: 'Which day?', options: [{ label: 'Monday' }, { label: 'Friday' }] }],
      } as never),
    ).toEqual(['left:Monday', 'right:Friday']);
  });

  test('the swipe deck reads the same directions', () => {
    const targets = swipeTargets(agendaItem('A5', { ask: choices('Pause', 'Switch', 'Warn') }));
    expect([targets.left?.label, targets.up?.label, targets.right?.label]).toEqual(['Pause', 'Switch', 'Warn']);
  });

  test('answers that are not options keep the card’s own directions', () => {
    const permission = cardAnswers(agendaItem('A6', { ask: { kind: 'permission' } } as Partial<AgendaItem>));
    expect(permission.length).toBeGreaterThan(0);
    expect(permission.every(answer => answer.does !== 'choose')).toBe(true);
    expect(at({ kind: 'info' } as Partial<AgendaItem>)).toEqual(
      cardAnswers(agendaItem('A5', { kind: 'info' } as Partial<AgendaItem>)).map(
        answer => `${answer.direction}:${answer.label}`,
      ),
    );
  });
});
