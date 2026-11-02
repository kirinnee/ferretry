import { describe, expect, it } from 'bun:test';
import { CardKindChip } from '../../../src/features/agenda/card-kind-chip.tsx';
import { TASK_CARD_KIND } from '../../../src/lib/card-kind.ts';
import { mount, must } from '../../support/dom.ts';

describe('CardKindChip', () => {
  it('says Task with the check box, and an agenda word with the speech bubble', async () => {
    const task = await mount(<CardKindChip kind={TASK_CARD_KIND} />);
    const taskChip = must(task.container.querySelector('[data-card-kind]'), 'the task chip');
    expect(taskChip.getAttribute('data-card-kind')).toBe('task');
    expect(taskChip.textContent).toBe('Task');
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
