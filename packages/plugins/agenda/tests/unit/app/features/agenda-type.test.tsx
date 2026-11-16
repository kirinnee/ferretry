import { describe, expect, test } from 'bun:test';
import { agendaTypeMeta } from '../../../../app/features/agenda/agenda-type.tsx';
import { agendaItem } from '../../../support/app/agenda-inbox.tsx';

describe('the type of an agenda item', () => {
  test('names each kind in the protocol’s plain word, with a tone of its own, and no line of advice', () => {
    const named = (extra: Record<string, unknown>) => agendaTypeMeta(agendaItem('A5', extra as never));
    expect(named({ kind: 'choice' })).toEqual({ kind: 'choice', label: 'Decision', tone: 'decision' });
    expect(named({ kind: 'yesno' })).toMatchObject({ label: 'Decision', tone: 'decision' });
    expect(named({ kind: 'permission' })).toMatchObject({ label: 'Approve', tone: 'approval' });
    expect(named({ kind: 'task' })).toMatchObject({ label: 'To do', tone: 'todo' });
    expect(named({ kind: 'review' })).toMatchObject({ label: 'Review', tone: 'review' });
    expect(named({ kind: 'info' })).toMatchObject({ label: 'FYI', tone: 'note' });
    expect(named({ kind: 'reply' })).toMatchObject({ label: 'Question', tone: 'reply' });
    expect(named({ kind: 'input' })).toMatchObject({ label: 'Type in', tone: 'approval' });
    expect(named({ kind: 'form' })).toMatchObject({ label: 'Fill in', tone: 'reply' });
  });

  test('calls a task with or without steps a To do', () => {
    const todo = agendaTypeMeta(agendaItem('A5', { kind: 'task', steps: ['one'] } as never));
    expect(todo).toMatchObject({ label: 'To do', tone: 'todo' });
    expect(agendaTypeMeta(agendaItem('A5', { kind: 'task' } as never)).label).toBe(todo.label);
  });

  test('calls a card waiting to be tried a Test, and a plan waiting for a go-ahead Approve', () => {
    const gate = {
      cardId: 'F1',
      laneId: 'try-it',
      laneName: 'Try it',
      entry: 1,
      options: [{ id: 'o0', label: 'Done', outcome: 'close' }],
    };
    const gated = (subject: string) => agendaTypeMeta(agendaItem('G1', { kind: 'choice', subject, gate } as never));
    expect(gated('Try it: open Settings')).toMatchObject({ kind: 'choice', label: 'Test', tone: 'decision' });
    expect(gated('OK to build? Pairing QR').label).toBe('Approve');
  });
});
