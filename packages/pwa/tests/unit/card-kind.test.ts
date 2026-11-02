import { describe, expect, test } from 'bun:test';
import type { AgendaItem } from '@ferretry/protocol';
import { agendaWord, itemCardKind, TASK_CARD_KIND } from '../../src/lib/card-kind.ts';
import { agendaItem } from '../support/agenda-inbox.tsx';

const kinded = (kind: AgendaItem['kind']) => agendaItem('A1', { kind });

describe('task or agenda, in one word', () => {
  test('each kind says its protocol word, and a notice is FYI', () => {
    expect(agendaWord(kinded('reply'))).toBe('Question');
    expect(agendaWord(kinded('form'))).toBe('Fill in');
    expect(agendaWord(kinded('input'))).toBe('Type in');
    expect(agendaWord(kinded('yesno'))).toBe('Decision');
    expect(agendaWord(kinded('permission'))).toBe('Approve');
    expect(agendaWord(kinded('choice'))).toBe('Decision');
    expect(agendaWord(kinded('review'))).toBe('Review');
    expect(agendaWord(kinded('info'))).toBe('FYI');
    expect(agendaWord(kinded('task'))).toBe('To do');
    expect(agendaWord({ ...kinded('reply'), notice: true })).toBe('FYI');
  });

  test('a gate on a board task is a TASK (Test, or Approve for a plan); everything else is the AGENDA', () => {
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
    expect(itemCardKind(gate)).toEqual({ family: 'task', word: 'Test' });
    expect(itemCardKind({ ...gate, subject: 'OK to build? Pairing QR' })).toEqual({ family: 'task', word: 'Approve' });
    expect(TASK_CARD_KIND).toEqual({ family: 'task', word: 'Test' });
  });
});
