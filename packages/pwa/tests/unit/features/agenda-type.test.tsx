import { afterEach, describe, expect, test } from 'bun:test';
import { AgendaTypeBadge, agendaTypeMeta } from '../../../src/features/agenda/agenda-type.tsx';
import { agendaItem } from '../../support/agenda-inbox.tsx';
import { type Mounted, mount, must } from '../../support/dom.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

describe('the type of an agenda item', () => {
  test('names each kind in the item’s own words, with a tone of its own', () => {
    const named = (extra: Record<string, unknown>) => agendaTypeMeta(agendaItem('A5', extra as never));
    expect(named({ kind: 'choice' })).toMatchObject({ label: 'Decision', tone: 'decision' });
    expect(named({ kind: 'yesno' })).toMatchObject({ label: 'Decision', tone: 'decision' });
    expect(named({ kind: 'permission' })).toMatchObject({ label: 'Approval', tone: 'approval' });
    expect(named({ kind: 'task' })).toMatchObject({ label: 'Task', tone: 'todo' });
    expect(named({ kind: 'review' })).toMatchObject({ label: 'Review', tone: 'review' });
    expect(named({ kind: 'info' })).toMatchObject({ label: 'Note', tone: 'note' });
    expect(named({ kind: 'reply' })).toMatchObject({ label: 'Reply', tone: 'reply' });
    expect(named({ kind: 'input' })).toMatchObject({ label: 'Reply', tone: 'reply' });
  });

  test('calls a task with steps a to-do', () => {
    expect(agendaTypeMeta(agendaItem('A5', { kind: 'task', steps: ['one'] } as never))).toMatchObject({
      label: 'To-do',
      tone: 'todo',
    });
  });

  test('draws the badge with its word, icon and one line, tagged for its kind and tone', async () => {
    view = await mount(<AgendaTypeBadge item={agendaItem('A5', { kind: 'permission' } as never)} />);
    const badge = must(must(view.container, 'view').querySelector('[data-agenda-type]'), 'the badge');
    expect(badge.getAttribute('data-agenda-type')).toBe('permission');
    expect(badge.getAttribute('data-tone')).toBe('approval');
    expect(badge.querySelector('.fy-item-type__badge')?.textContent).toBe('Approval');
    expect(badge.querySelector('svg')).not.toBeNull();
    expect(badge.querySelector('.fy-item-type__hint')?.textContent).toContain('Allow or deny');
  });
});
