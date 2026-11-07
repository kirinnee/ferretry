import { afterEach, describe, expect, test } from 'bun:test';
import type { AgendaItem } from '../../../../app/wire/index.ts';
import { ChatProse } from '../../../../app/shell.ts';
import { AgendaItemCard } from '../../../../app/features/agenda/agenda-item-card.tsx';
import { agendaItem } from '../../../support/app/agenda-inbox.tsx';
import { interact, type Mounted, mount, must } from '../../../support/app/dom.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const gate = {
  cardId: 'F12',
  laneId: 'tested',
  laneName: 'Try it',
  entry: 3,
  projectId: 'p1',
  options: [
    { id: 'o0', label: 'Done', outcome: 'close' },
    { id: 'o1', label: 'Not good', outcome: 'reopen-with-agenda' },
  ],
} as const;

const thread = (extra: Partial<AgendaItem> = {}): AgendaItem =>
  agendaItem('A5', {
    subject: 'Which colour for the badge?',
    ask: { kind: 'multiple-choice', options: [{ label: 'Blue' }, { label: 'Green' }] },
    ...extra,
  } as Partial<AgendaItem>);

const draw = async (item: AgendaItem, acted: unknown[] = []): Promise<HTMLElement> => {
  view = await mount(
    <AgendaItemCard
      busy={false}
      error={null}
      ferret="kai"
      item={item}
      now={Date.parse('2026-08-01T12:00:00.000Z')}
      onAct={action => acted.push(action)}
      renderProse={text => <ChatProse text={text} />}
      swipeable={false}
    />,
  );
  return view.container;
};

describe('a thread with a gate attached', () => {
  test('draws the gate options as a second answer row, beside the thread own answers', async () => {
    const root = await draw(thread({ gateAttached: gate } as unknown as Partial<AgendaItem>));
    const row = must(root.querySelector<HTMLElement>('[data-agenda-attached-gate]'), 'the gate row');
    expect(row.getAttribute('data-agenda-attached-gate')).toBe('F12');
    expect(row.textContent).toContain('F12');
    const labels = [...row.querySelectorAll<HTMLElement>('[data-agenda-option]')].map(node =>
      node.getAttribute('data-agenda-option'),
    );
    expect(labels.sort()).toEqual(['Done', 'Not good']);
    const own = [...root.querySelectorAll<HTMLElement>('[data-agenda-option]')]
      .filter(node => !row.contains(node))
      .map(node => node.getAttribute('data-agenda-option'));
    expect(own).toContain('Blue');
  });

  test('tapping a gate option sends it marked for the gate; the thread own option is not marked', async () => {
    const acted: { gate?: true; label: string }[] = [];
    const root = await draw(thread({ gateAttached: gate } as unknown as Partial<AgendaItem>), acted);
    const row = must(root.querySelector<HTMLElement>('[data-agenda-attached-gate]'), 'the gate row');
    await interact(() => must(row.querySelector<HTMLElement>('[data-agenda-option="Done"]'), 'Done').click());
    expect(acted).toEqual([expect.objectContaining({ kind: 'respond', label: 'Done', gate: true })]);

    const blue = must(
      [...root.querySelectorAll<HTMLElement>('[data-agenda-option="Blue"]')].find(node => !row.contains(node)),
      'Blue',
    );
    await interact(() => blue.click());
    expect(acted[1]?.gate).toBeUndefined();
  });

  test('names the card by its title, says it is ready to test, inside What I need from you', async () => {
    const root = await draw(
      thread({ gateAttached: { ...gate, cardTitle: 'Badge colour' } } as unknown as Partial<AgendaItem>),
    );
    const lead = must(root.querySelector<HTMLElement>('.fy-card__gate-lead'), 'the lead');
    expect(lead.textContent).toBe('Badge colour is ready to test.');
    // It is answered inside the item, in What I need from you: never docked, never a separate item.
    expect(lead.closest('[data-agenda-part="needs"]')).not.toBeNull();
  });

  test('keeps the arrows and the swipe on the thread own pair only: the gate buttons are tap only', async () => {
    const root = await draw(thread({ gateAttached: gate } as unknown as Partial<AgendaItem>));
    const row = must(root.querySelector<HTMLElement>('[data-agenda-attached-gate]'), 'the gate row');
    expect(row.querySelectorAll('[data-agenda-answer]')).toHaveLength(0);
    expect(row.querySelectorAll('.fy-qr__arrow')).toHaveLength(0);
    const own = [...root.querySelectorAll<HTMLElement>('[data-agenda-answer]')].filter(node => !row.contains(node));
    expect(own.length).toBeGreaterThan(0);
  });

  test('reads Not good on the left and Done on the right, like every swipe surface', async () => {
    const root = await draw(thread({ gateAttached: gate } as unknown as Partial<AgendaItem>));
    const row = must(root.querySelector<HTMLElement>('[data-agenda-attached-gate]'), 'the gate row');
    const order = [...row.querySelectorAll<HTMLElement>('[data-agenda-option]')].map(node =>
      node.getAttribute('data-agenda-option'),
    );
    expect(order).toEqual(['Not good', 'Done']);
  });

  test('a thread without an attachment draws no gate row', async () => {
    const root = await draw(thread());
    expect(root.querySelector('[data-agenda-attached-gate]')).toBeNull();
  });
});
