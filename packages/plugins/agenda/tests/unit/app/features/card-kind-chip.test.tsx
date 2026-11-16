import { itemCardKind } from '../../../../app/lib/card-kind.ts';
import { agendaItem } from '../../../support/app/agenda-inbox.tsx';
import { TASK_CARD_KIND } from '../../../../app/lib/card-kind.ts';
import { describe, expect, it } from 'bun:test';
import { CardKindChip } from '../../../../app/features/agenda/card-kind-chip.tsx';
import { mount, must } from '@ferretry/app/testing';

describe('CardKindChip', () => {
  it('says Test with the check box, and an agenda word with the speech bubble', async () => {
    const task = await mount(<CardKindChip kind={TASK_CARD_KIND} />);
    const taskChip = must(task.container.querySelector('[data-card-kind]'), 'the task chip');
    expect(taskChip.getAttribute('data-card-kind')).toBe('task');
    expect(taskChip.textContent).toBe('Test');
    expect(taskChip.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    await task.unmount();

    const agenda = await mount(<CardKindChip kind={{ family: 'agenda', word: 'Decision' }} />);
    const agendaChip = must(agenda.container.querySelector('[data-card-kind]'), 'the agenda chip');
    expect(agendaChip.getAttribute('data-card-kind')).toBe('agenda');
    expect(agendaChip.textContent).toBe('Decision');
    expect(agendaChip.innerHTML).not.toBe(taskChip.innerHTML);
    await agenda.unmount();
  });
});

describe('itemCardKind', () => {
  it('words a notice as FYI whatever its kind, and any other item by its kind', () => {
    const notice = itemCardKind(agendaItem('N1', { notice: true, kind: 'decision' } as never));
    expect(notice).toEqual({ family: 'agenda', word: 'FYI' });
  });
});
