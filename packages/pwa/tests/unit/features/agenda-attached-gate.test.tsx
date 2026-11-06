import { afterEach, describe, expect, test } from 'bun:test';
import type { AgendaItem } from '@ferretry/protocol';
import { ChatProse } from '../../../src/components/chat-prose.tsx';
import { AgendaItemCard } from '../../../src/features/agenda/agenda-item-card.tsx';
import { agendaItem } from '../../support/agenda-inbox.tsx';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';

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

// &B165: the old app drew the mirrored gate as a SECOND answer row beside the thread's own. One row only, now.
const reply = (extra: Partial<AgendaItem> = {}): AgendaItem =>
  agendaItem('A6', {
    subject: 'Which shade of blue?',
    kind: 'reply',
    ask: { kind: 'open-question' },
    ...extra,
  } as unknown as Partial<AgendaItem>);

/** What an older daemon raised for a card to try: the ask line is the card's own title, and the gate is mirrored. */
const tryIt = (gateAttached: object): AgendaItem =>
  reply({
    subject: 'Try it: Badge colour',
    raisedBy: 'daemon',
    source: 'task',
    sourceRef: 'card-agenda:F12',
    gateAttached,
  } as unknown as Partial<AgendaItem>);

describe('a thread with a gate attached (an older daemon’s mirror)', () => {
  test('a thread that asks its own choice keeps ITS buttons as the one row; the gate waits, named once (&B165)', async () => {
    const root = await draw(
      thread({ gateAttached: { ...gate, cardTitle: 'Badge colour' } } as unknown as Partial<AgendaItem>),
    );
    expect(root.querySelector('[data-agenda-attached-gate]')).toBeNull();
    expect(root.querySelectorAll('[data-agenda-option="Done"]')).toHaveLength(0);
    expect(root.querySelectorAll('[data-agenda-option="Blue"]')).toHaveLength(1);
    expect(root.querySelector('[data-agenda-own-row-held]')).toBeNull();
    expect(root.querySelector('[data-agenda-card-ask-later]')).not.toBeNull();
  });

  test('a thread answered in words draws the gate as its own ask, inside What I need from you', async () => {
    const root = await draw(tryIt({ ...gate, cardTitle: 'Badge colour' }));
    const row = must(root.querySelector<HTMLElement>('[data-agenda-attached-gate]'), 'the gate row');
    expect(row.getAttribute('data-agenda-attached-gate')).toBe('F12');
    expect(row.closest('[data-agenda-part="needs"]')).not.toBeNull();
    expect(row.querySelector('[data-agenda-card-ask-title]')?.textContent).toBe('Try it');
    expect(row.querySelector('[data-agenda-card-ask-ref]')?.textContent).toBe('For &F12 Badge colour');
    expect(root.textContent).not.toMatch(/your answer for the card|Card &F12|card ask|ready to test/iu);
  });

  test('tapping a gate option sends it marked for the gate', async () => {
    const acted: { gate?: true; label: string }[] = [];
    const root = await draw(tryIt({ ...gate, cardTitle: 'Badge colour' }), acted);
    const row = must(root.querySelector<HTMLElement>('[data-agenda-attached-gate]'), 'the gate row');
    await interact(() => must(row.querySelector<HTMLElement>('[data-agenda-option="Done"]'), 'Done').click());
    expect(acted).toEqual([expect.objectContaining({ kind: 'respond', label: 'Done', gate: true })]);
  });

  test('reads Not good on the left and Done on the right, like every swipe surface', async () => {
    const root = await draw(tryIt({ ...gate, cardTitle: 'Badge colour' }));
    const row = must(root.querySelector<HTMLElement>('[data-agenda-attached-gate]'), 'the gate row');
    const order = [...row.querySelectorAll<HTMLElement>('[data-agenda-option]')].map(node =>
      node.getAttribute('data-agenda-option'),
    );
    expect(order).toEqual(['Not good', 'Done']);
  });

  test('a thread without an attachment draws no gate row', async () => {
    const root = await draw(thread());
    expect(root.querySelector('[data-agenda-attached-gate]')).toBeNull();
    expect(root.querySelector('[data-agenda-card-ask-later]')).toBeNull();
  });
});
