import { describe, expect, test } from 'bun:test';
import { agendaTypeMeta } from '../../../src/features/agenda/agenda-type.tsx';
import { agendaItem } from '../../support/agenda-inbox.tsx';

describe('the type of an agenda item', () => {
  test('names each kind in one word, with a tone of its own, and no line of advice', () => {
    const named = (extra: Record<string, unknown>) => agendaTypeMeta(agendaItem('A5', extra as never));
    expect(named({ kind: 'choice' })).toEqual({ kind: 'choice', label: 'Decision', tone: 'decision' });
    expect(named({ kind: 'yesno' })).toMatchObject({ label: 'Decision', tone: 'decision' });
    expect(named({ kind: 'permission' })).toMatchObject({ label: 'Approval', tone: 'approval' });
    expect(named({ kind: 'task' })).toMatchObject({ label: 'Task', tone: 'todo' });
    expect(named({ kind: 'review' })).toMatchObject({ label: 'Review', tone: 'review' });
    expect(named({ kind: 'info' })).toMatchObject({ label: 'Note', tone: 'note' });
    expect(named({ kind: 'reply' })).toMatchObject({ label: 'Reply', tone: 'reply' });
    expect(named({ kind: 'input' })).toMatchObject({ label: 'Input', tone: 'approval' });
  });

  test('calls a task with steps a to-do', () => {
    expect(agendaTypeMeta(agendaItem('A5', { kind: 'task', steps: ['one'] } as never))).toMatchObject({
      label: 'To-do',
      tone: 'todo',
    });
  });
});
