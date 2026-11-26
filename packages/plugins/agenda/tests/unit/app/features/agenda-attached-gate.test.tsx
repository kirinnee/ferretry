import { afterEach, describe, expect, test } from 'bun:test';
import type { AgendaItem } from '@ferretry/core-asks/contract';
import { ProseView } from '../../../../app/shell.ts';
import { AgendaItemCard } from '../../../../app/features/agenda/agenda-item-card.tsx';
import { agendaItem } from '../../../support/app/agenda-inbox.tsx';
import { interact, type Mounted, mount, must } from '@ferretry/app/testing';

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
      renderProse={text => <ProseView text={text} />}
      swipeable={false}
    />,
  );
  return view.container;
};

describe('a thread with a gate attached', () => {
  test('draws the gate options as a second answer row, beside the thread own answers', async () => {
    const root = await draw(
      thread({ cardAsks: [{ gate: gate, at: '2026-08-01T10:00:00.000Z' }] } as unknown as Partial<AgendaItem>),
    );
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
    const root = await draw(
      thread({ cardAsks: [{ gate: gate, at: '2026-08-01T10:00:00.000Z' }] } as unknown as Partial<AgendaItem>),
      acted,
    );
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
      thread({
        cardAsks: [{ gate: { ...gate, cardTitle: 'Badge colour' }, at: '2026-08-01T10:00:00.000Z' }],
      } as unknown as Partial<AgendaItem>),
    );
    const lead = must(root.querySelector<HTMLElement>('.fy-card__gate-lead'), 'the lead');
    expect(lead.textContent).toBe('Badge colour is ready to test.');
    // It is answered inside the item, in What I need from you: never docked, never a separate item.
    expect(lead.closest('[data-agenda-part="needs"]')).not.toBeNull();
  });

  test('keeps the arrows and the swipe on the thread own pair only: the gate buttons are tap only', async () => {
    const root = await draw(
      thread({ cardAsks: [{ gate: gate, at: '2026-08-01T10:00:00.000Z' }] } as unknown as Partial<AgendaItem>),
    );
    const row = must(root.querySelector<HTMLElement>('[data-agenda-attached-gate]'), 'the gate row');
    expect(row.querySelectorAll('[data-agenda-answer]')).toHaveLength(0);
    expect(row.querySelectorAll('.fy-qr__arrow')).toHaveLength(0);
    const own = [...root.querySelectorAll<HTMLElement>('[data-agenda-answer]')].filter(node => !row.contains(node));
    expect(own.length).toBeGreaterThan(0);
  });

  test('reads Not good on the left and Done on the right, like every swipe surface', async () => {
    const root = await draw(
      thread({ cardAsks: [{ gate: gate, at: '2026-08-01T10:00:00.000Z' }] } as unknown as Partial<AgendaItem>),
    );
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

describe('A-29: every open ask comes first', () => {
  test('the task ask is drawn before the why, the steps and the impact', async () => {
    const root = await draw(
      thread({
        impact: 'It changes the badge for everyone',
        cardAsks: [{ gate: gate, at: '2026-08-01T10:00:00.000Z' }],
      } as unknown as Partial<AgendaItem>),
    );
    const ask = must(root.querySelector<HTMLElement>('[data-agenda-card-asks]'), 'the task asks');
    const impact = must(root.querySelector<HTMLElement>('[data-agenda-section="impact"]'), 'the impact');
    expect(ask.compareDocumentPosition(impact) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

const second = { ...gate, cardId: 'F13', entry: 4, cardTitle: 'Badge shape' } as const;
const before = (earlier: Element, later: Element): boolean =>
  Boolean(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('A-29: EVERY open ask stays actionable above the supporting details', () => {
  test('two task asks are both drawn, each with its own buttons, before the impact', async () => {
    const acted: { cardAsk?: string; label: string }[] = [];
    const root = await draw(
      thread({
        impact: 'It changes the badge for everyone',
        cardAsks: [
          { gate, at: '2026-08-01T10:00:00.000Z' },
          { gate: second, at: '2026-08-01T10:05:00.000Z' },
        ],
      } as unknown as Partial<AgendaItem>),
      acted,
    );
    const rows = [...root.querySelectorAll<HTMLElement>('[data-agenda-card-ask]')];
    expect(rows.map(row => row.getAttribute('data-agenda-attached-gate'))).toEqual(['F12', 'F13']);
    const impact = must(root.querySelector<HTMLElement>('[data-agenda-section="impact"]'), 'the impact');
    for (const row of rows) expect(before(row, impact)).toBe(true);
    await interact(() =>
      must(rows[1]?.querySelector<HTMLElement>('[data-agenda-option="Done"]'), 'second Done').click(),
    );
    expect(acted).toEqual([expect.objectContaining({ label: 'Done', gate: true, cardAsk: 'gate:F13:tested:4' })]);
  });

  test('an answered task ask is not drawn again while another is still open', async () => {
    const root = await draw(
      thread({
        cardAsks: [
          { gate, at: '2026-08-01T10:00:00.000Z', answer: { at: '2026-08-01T10:30:00.000Z' } },
          { gate: second, at: '2026-08-01T10:05:00.000Z' },
        ],
      } as unknown as Partial<AgendaItem>),
    );
    const rows = [...root.querySelectorAll<HTMLElement>('[data-agenda-card-ask]')];
    expect(rows.map(row => row.getAttribute('data-agenda-attached-gate'))).toEqual(['F13']);
  });

  test("answering the item's own choice leaves no answered choice row beside the open task ask", async () => {
    const root = await draw(
      thread({
        ownerAnswer: {
          at: '2026-08-01T11:00:00.000Z',
          response: { kind: 'multiple-choice', choice: 'Blue' },
          request: 1,
        },
        cardAsks: [{ gate, at: '2026-08-01T10:00:00.000Z' }],
      } as unknown as Partial<AgendaItem>),
    );
    const row = must(root.querySelector<HTMLElement>('[data-agenda-attached-gate]'), 'the open task ask');
    expect(root.querySelector('[data-agenda-item-answer]')).toBeNull();
    const own = [...root.querySelectorAll<HTMLElement>('[data-agenda-option]')].filter(node => !row.contains(node));
    expect(own.map(node => node.getAttribute('data-agenda-option'))).not.toContain('Blue');
  });

  test('a machine input form comes before the impact', async () => {
    view = await mount(
      <AgendaItemCard
        busy={false}
        error={null}
        ferret="kai"
        inputForm={<form data-fake-input="" />}
        item={agendaItem('A9', { kind: 'input', impact: 'It unlocks the phone' } as never)}
        now={Date.parse('2026-08-01T12:00:00.000Z')}
        onAct={() => undefined}
        renderProse={text => <ProseView text={text} />}
        swipeable={false}
      />,
    );
    const root = view.container;
    const form = must(root.querySelector<HTMLElement>('[data-agenda-input-form]'), 'the input form');
    const impact = must(root.querySelector<HTMLElement>('[data-agenda-section="impact"]'), 'the impact');
    expect(before(form, impact)).toBe(true);
  });

  test('a plan form comes before the steps and the impact', async () => {
    view = await mount(
      <AgendaItemCard
        busy={false}
        error={null}
        ferret="kai"
        item={agendaItem('A9', { kind: 'info', raisedBy: 'daemon', impact: 'It runs the plan' } as never)}
        now={Date.parse('2026-08-01T12:00:00.000Z')}
        onAct={() => undefined}
        planForm={<form data-fake-plan="" />}
        renderProse={text => <ProseView text={text} />}
        swipeable={false}
      />,
    );
    const root = view.container;
    const form = must(root.querySelector<HTMLElement>('[data-agenda-plan-form]'), 'the plan form');
    const impact = must(root.querySelector<HTMLElement>('[data-agenda-section="impact"]'), 'the impact');
    expect(before(form, impact)).toBe(true);
  });
});

describe('A-29: History is the state of the answered asks, not a message tally', () => {
  const answered = {
    gate,
    at: '2026-08-01T10:00:00.000Z',
    answer: {
      at: '2026-08-01T10:30:00.000Z',
      response: { kind: 'multiple-choice', choice: 'Done' },
      receipt: 'a'.repeat(64),
    },
  };
  const foldOf = (root: HTMLElement): HTMLElement | null =>
    root.querySelector<HTMLElement>('[data-agenda-fold="conversation"]');

  test('a stored task answer with no transcript still has its History fold, counted once', async () => {
    const root = await draw(
      thread({
        cardAsks: [answered, { gate: second, at: '2026-08-01T10:05:00.000Z' }],
      } as unknown as Partial<AgendaItem>),
    );
    expect(must(foldOf(root), 'the History fold').textContent).toBe('History1 answered');
  });

  test('an answer the machine refused is not counted as answered', async () => {
    view = await mount(
      <AgendaItemCard
        busy={false}
        error={null}
        ferret="kai"
        history={[
          {
            kind: 'owner',
            key: 'sent-1',
            at: 1,
            text: 'Blue',
            form: 'answer',
            reached: { via: 'device', answered: false, outbox: { reason: 'refused', refused: true } },
          },
        ]}
        item={thread()}
        now={Date.parse('2026-08-01T12:00:00.000Z')}
        onAct={() => undefined}
        renderProse={text => <ProseView text={text} />}
        swipeable={false}
      />,
    );
    expect(must(foldOf(view.container), 'the History fold').textContent).toBe('History1 message');
  });
});
