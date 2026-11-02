import { describe, expect, test } from 'bun:test';
import type { AgendaItem } from '@ferretry/protocol';
import { agendaWord, itemCardKind, TASK_CARD_KIND } from '../../src/lib/card-kind.ts';
import { agendaItem } from '../support/agenda-inbox.tsx';

const kinded = (kind: AgendaItem['kind']) => agendaItem('A1', { kind });

describe('task or agenda, in one word', () => {
  test('a question, a decision, a notice and a to-do each say so', () => {
    expect(agendaWord(kinded('reply'))).toBe('Question');
    expect(agendaWord(kinded('form'))).toBe('Question');
    expect(agendaWord(kinded('input'))).toBe('Question');
    expect(agendaWord(kinded('yesno'))).toBe('Decision');
    expect(agendaWord(kinded('permission'))).toBe('Decision');
    expect(agendaWord(kinded('choice'))).toBe('Decision');
    expect(agendaWord(kinded('review'))).toBe('Decision');
    expect(agendaWord(kinded('info'))).toBe('Info');
    expect(agendaWord(kinded('task'))).toBe('To do');
    expect(agendaWord({ ...kinded('reply'), notice: true })).toBe('Info');
  });

  test('a gate on a board task is a TASK; everything else is the AGENDA', () => {
    expect(itemCardKind(kinded('yesno'))).toEqual({ family: 'agenda', word: 'Decision' });
    const gate = agendaItem('G1', {
      kind: 'choice',
      gate: {
        cardId: 'F1',
        laneId: 'tested',
        laneName: 'Tested',
        entry: 1,
        options: [{ id: 'o0', label: 'Done', outcome: 'close' }],
      },
    } as Partial<AgendaItem>);
    expect(itemCardKind(gate)).toBe(TASK_CARD_KIND);
    expect(TASK_CARD_KIND).toEqual({ family: 'task', word: 'Task' });
  });
});
