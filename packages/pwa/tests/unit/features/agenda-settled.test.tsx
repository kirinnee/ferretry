import { afterEach, describe, expect, it } from 'bun:test';
import type { AgendaItem, ResolvedAgendaItem } from '@ferretry/protocol';
import { AgendaSettled, isResolved } from '../../../src/features/agenda/agenda-settled.tsx';
import { agendaItem } from '../../support/agenda-inbox.tsx';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const NOW = Date.parse('2026-10-30T22:15:00.000Z');

const resolved = (patch: Record<string, unknown> = {}): ResolvedAgendaItem =>
  ({
    ...agendaItem('A1', { title: 'Use the shared fixture?' }),
    resolvedAt: '2026-10-30T21:55:00.000Z',
    resolvedBy: 'human',
    resolvedBySession: null,
    resolvedByName: null,
    resolutionNote: null,
    disposition: 'done',
    ...patch,
  }) as unknown as ResolvedAgendaItem;

const replied = (): AgendaItem =>
  agendaItem('A89', { title: 'Update the Liftoff MBP', parked: { reason: 'replied', at: '2026-10-30T22:11:00.000Z' } });

const show = async (props: Parameters<typeof AgendaSettled>[0]) => {
  view = await mount(<AgendaSettled {...props} />);
  return must(view.container, 'view');
};

describe('AgendaSettled (#B76): where an item that cannot be answered here stands', () => {
  it('tells a resolved record from an open item', () => {
    expect(isResolved(resolved())).toBe(true);
    expect(isResolved(replied())).toBe(false);
  });

  it('reads a resolved item: how it ended and when, its answer and its note, in sentence case', async () => {
    const root = await show({
      busy: false,
      error: null,
      ferret: 'Lizzette',
      item: resolved({ response: { kind: 'multiple-choice', choice: 'Yes' }, resolutionNote: 'Delete the old one.' }),
      timeZone: 'UTC',
    });
    expect(root.querySelector('[data-agenda-settled="resolved"]')).not.toBeNull();
    expect(root.textContent).toContain('Done by you · Oct 30');
    expect(root.querySelector('[data-agenda-settled-answer]')?.textContent).toBe('Chose “Yes”');
    expect(root.querySelector('[data-agenda-settled-note]')?.textContent).toBe('Delete the old one.');
    expect(root.querySelector('[data-agenda-bring-back]')).toBeNull();
  });

  it('reads a resolved item with no answer and no note as just how it ended', async () => {
    const root = await show({
      busy: false,
      error: null,
      ferret: 'Lizzette',
      item: resolved({ disposition: 'dismissed' }),
    });
    expect(root.textContent).toContain('Dismissed by you');
    expect(root.querySelector('[data-agenda-settled-answer]')).toBeNull();
    expect(root.querySelector('[data-agenda-settled-note]')).toBeNull();
  });

  it('says a replied item waits on the ferret, and brings it back on a tap', async () => {
    const back: string[] = [];
    const root = await show({
      busy: false,
      error: null,
      ferret: 'Lizzette',
      item: replied(),
      now: NOW,
      onBringBack: () => back.push('A89'),
    });
    expect(root.querySelector('[data-agenda-settled="replied"]')?.textContent).toContain('waiting on Lizzette');
    await interact(() => must(root.querySelector<HTMLButtonElement>('[data-agenda-bring-back]'), 'Back').click());
    expect(back).toEqual(['A89']);
  });

  it('says a refused bring-back in place, and holds the button while it is on its way', async () => {
    const root = await show({
      busy: true,
      error: 'Update the Liftoff MBP to snooze from here.',
      ferret: 'Lizzette',
      item: replied(),
      onBringBack: () => undefined,
    });
    expect(root.querySelector('[role="alert"]')?.textContent).toBe('Update the Liftoff MBP to snooze from here.');
    expect(root.querySelector<HTMLButtonElement>('[data-agenda-bring-back]')?.disabled).toBe(true);
  });

  it('offers no way back when nothing can be sent from here', async () => {
    const root = await show({ busy: false, error: null, ferret: 'Lizzette', item: replied() });
    expect(root.querySelector('[data-agenda-bring-back]')).toBeNull();
  });

  it('draws nothing for an item that is neither parked nor resolved', async () => {
    const root = await show({ busy: false, error: null, ferret: 'Lizzette', item: agendaItem('A5') });
    expect(root.textContent).toBe('');
  });
});
