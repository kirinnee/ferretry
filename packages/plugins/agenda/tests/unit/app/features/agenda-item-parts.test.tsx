import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { AgendaItem } from '../../../../app/wire/index.ts';
import { Markdown } from '../../../../app/shell.ts';
import { AgendaItemView, type AgendaItemViewProps } from '../../../../app/features/agenda/agenda-item-view.tsx';
import type { HistoryEvent } from '../../../../app/lib/agenda-history.ts';
import type { InboxAction } from '../../../../app/lib/agenda-inbox.ts';
import { agendaItem, choices } from '../../../support/app/agenda-inbox.tsx';
import { interact, type Mounted, mount, must } from '@ferretry/app/testing';

let view: Mounted | null = null;
beforeEach(() => {
  window.localStorage.clear();
});
const unmount = async (): Promise<void> => {
  await view?.unmount();
  view = null;
};
afterEach(unmount);

const NOW = Date.parse('2026-08-01T12:00:00.000Z');

const gate = {
  cardId: 'F12',
  laneId: 'tested',
  laneName: 'Try it',
  entry: 3,
  projectId: 'p1',
  cardTitle: 'Badge colour',
  options: [
    { id: 'o0', label: 'Done', outcome: 'close' },
    { id: 'o1', label: 'Not good', outcome: 'reopen-with-agenda' },
  ],
} as const;

const REPORT = `## The report you asked for\n\n${'Every finding is kept, line by line. '.repeat(600)}\n\nThe last line of the report.`;

const full = agendaItem('A47', {
  title: 'Badge colour',
  subject: 'Which colour for the badge?',
  ask: choices('Blue', 'Green'),
  stage: 'question',
  stages: [
    { stage: 'explainer', at: '2026-08-01T09:00:00.000Z' },
    { stage: 'question', at: '2026-08-01T10:00:00.000Z' },
  ],
  premise: '- The badge is grey today',
  context: '- Two colours tested well',
  detail: 'The badge is the small dot on each row. It tells the owner which items need them.',
  terms: [{ term: 'badge', meaning: 'the small dot on a row' }],
  links: [
    { label: 'The change this item is about', target: 'https://github.com/kirinnee/ferretry/pull/1428' },
    { target: '&F12' },
  ],
  whereWeAre: '- The two colours are tested; the pick is yours',
  decided: '- The shape stays round',
  stillOpen: '- The colour',
  body: REPORT,
  gateAttached: gate,
  cardAsks: [{ gate, at: '2026-08-01T11:00:00.000Z' }],
  revisions: [
    { at: '2026-08-01T10:00:00.000Z', by: 'agent', changed: ['subject'], previous: { subject: 'Which badge?' } },
  ],
} as unknown as Partial<AgendaItem>);

const conversation: readonly HistoryEvent[] = [
  { kind: 'owner', key: 'o1', at: NOW - 4_000, text: 'Why not red?' },
  { kind: 'ferret', key: 'f1', at: NOW - 3_000, text: `Re !A47: ${'Red reads as an error. '.repeat(200)}End.` },
  { kind: 'owner', key: 'o2', at: NOW - 2_000, text: 'OK, and green?' },
  { kind: 'ferret', key: 'f2', at: NOW - 1_000, text: 'Re !A47: green tested well.' },
];

const draw = async (
  item: AgendaItem,
  extra: Partial<AgendaItemViewProps> = {},
  history: readonly HistoryEvent[] = [],
): Promise<InboxAction[]> => {
  const acted: InboxAction[] = [];
  view = await mount(
    <AgendaItemView
      busy={false}
      error={null}
      ferret="Zoe"
      history={history}
      item={item}
      itemKey="laptop/sess-1/A47"
      now={NOW}
      onAct={action => acted.push(action)}
      onClose={() => undefined}
      position={{ index: 0, total: 1 }}
      renderProse={text => <Markdown text={text} />}
      swipeable={false}
      {...extra}
    />,
  );
  return acted;
};

const root = (): HTMLElement => must(view?.container, 'the view');
const one = <T extends Element>(selector: string): T => must(root().querySelector<T>(selector), selector);
const parts = (): (string | null)[] =>
  [...root().querySelectorAll('[data-agenda-part]')].map(part => part.getAttribute('data-agenda-part'));

describe('the item view’s parts', () => {
  test('are the spec’s eight, in order, for an item that carries every one', async () => {
    await draw(full, {}, conversation);
    expect(parts()).toEqual(['head', 'premise', 'detail', 'references', 'needs', 'tabs', 'conversation', 'activity']);
  });

  test('keep the log at the bottom: the conversation and the activity come after the tabs, never between the asks', async () => {
    await draw(full, {}, conversation);
    const order = parts();
    expect(order.indexOf('needs')).toBeLessThan(order.indexOf('tabs'));
    expect(order.indexOf('tabs')).toBeLessThan(order.indexOf('conversation'));
    expect(order.slice(-2)).toEqual(['conversation', 'activity']);
  });

  test('draw only what the item carries: a bare question is its head, its premise and what it needs', async () => {
    await draw(agendaItem('A3', { ask: choices('Yes', 'No'), premise: '- a', context: '- b' } as Partial<AgendaItem>));
    expect(parts()).toEqual(['head', 'premise', 'needs']);
  });

  test('the head says where the item stands and the stage it is at now', async () => {
    await draw(full);
    expect(one('[data-agenda-part="head"] [data-agenda-state]').textContent).toBe('Needs you');
    expect(one('[data-agenda-part="head"] [data-agenda-stage]').textContent).toBe('Question');
    // The version picker is the head's too, behind its ⋯ — never a row of its own on the card.
    expect(root().querySelector('.fy-card [data-agenda-version-picker]')).toBeNull();
    await interact(() => one<HTMLButtonElement>('[data-agenda-menu-toggle]').click());
    expect(one('[data-agenda-menu] [data-agenda-version-slot] [data-agenda-version-picker]')).toBeDefined();
  });

  test('the head draws the description — the item’s summary — whole, right under its two small chips', async () => {
    const long = `Which colour for the badge? ${'It sits on every row and is the first thing the owner sees. '.repeat(20)}End.`;
    await draw(agendaItem('A47', { ...full, subject: long } as Partial<AgendaItem>));
    const head = one('[data-agenda-part="head"]');
    const description = must(head.querySelector('[data-agenda-description]'), 'the description');
    expect(description.textContent).toBe(long);
    expect(head.firstElementChild?.matches('[data-agenda-card-top]')).toBe(true);
    expect(head.lastElementChild).toBe(description);
    // Said on the card, so the head's ⋯ does not hold it a second time.
    await interact(() => one<HTMLButtonElement>('[data-agenda-menu-toggle]').click());
    expect(root().querySelector('[data-agenda-menu] [data-agenda-ask]')).toBeNull();
  });

  test('a resting item says who it waits on, and a working one says so', async () => {
    await draw(
      agendaItem('A4', {
        ask: choices('Yes', 'No'),
        parked: { reason: 'replied', at: '2026-08-01T11:00:00.000Z' },
      } as Partial<AgendaItem>),
    );
    expect(one('[data-agenda-state]').textContent).toBe('Resting · waiting on Zoe');
  });
});

describe('the folded parts', () => {
  test('the detailed context, the terms and references, the conversation and the activity log start closed, and open on a tap', async () => {
    await draw(full, {}, conversation);
    for (const part of ['detail', 'references', 'conversation', 'activity']) {
      const toggle = one<HTMLButtonElement>(`[data-agenda-fold="${part}"]`);
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(one<HTMLElement>(`[data-agenda-part="${part}"] .fy-card__fold-body`).hidden).toBe(true);
    }
    expect(root().textContent).not.toContain('It tells the owner which items need them.');
    await interact(() => one<HTMLButtonElement>('[data-agenda-fold="detail"]').click());
    expect(one('[data-agenda-fold="detail"]').getAttribute('aria-expanded')).toBe('true');
    expect(one('[data-agenda-part="detail"]').textContent).toContain('It tells the owner which items need them.');
  });

  test('are remembered per item on this device: reopened, the same item keeps them; another item does not', async () => {
    await draw(full);
    await interact(() => one<HTMLButtonElement>('[data-agenda-fold="activity"]').click());
    await unmount();
    await draw(full);
    expect(one('[data-agenda-fold="activity"]').getAttribute('aria-expanded')).toBe('true');
    expect(one('[data-agenda-fold="detail"]').getAttribute('aria-expanded')).toBe('false');
    await unmount();
    await draw(full, { itemKey: 'laptop/sess-2/A47' });
    expect(one('[data-agenda-fold="activity"]').getAttribute('aria-expanded')).toBe('false');
  });

  test('still open and close when the browser refuses storage', async () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('blocked');
      },
    });
    try {
      await draw(full);
      await interact(() => one<HTMLButtonElement>('[data-agenda-fold="detail"]').click());
      expect(one('[data-agenda-fold="detail"]').getAttribute('aria-expanded')).toBe('true');
    } finally {
      if (original !== undefined) Object.defineProperty(window, 'localStorage', original);
    }
  });
});

describe('the folded parts, when storage refuses reads and writes', () => {
  test('still open and close, remembering nothing', async () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    const refuse = (): never => {
      throw new Error('quota');
    };
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: { getItem: refuse, setItem: refuse, removeItem: refuse },
    });
    try {
      await draw(full);
      const fold = one<HTMLButtonElement>('[data-agenda-fold="detail"]');
      expect(fold.getAttribute('aria-expanded')).toBe('false');
      await interact(() => fold.click());
      expect(one('[data-agenda-fold="detail"]').getAttribute('aria-expanded')).toBe('true');
      await interact(() => one<HTMLButtonElement>('[data-agenda-fold="detail"]').click());
      expect(one('[data-agenda-fold="detail"]').getAttribute('aria-expanded')).toBe('false');
    } finally {
      if (original !== undefined) Object.defineProperty(window, 'localStorage', original);
    }
  });
});

describe('terms and references', () => {
  test('are ONE table of every term and every link, each with its meaning, links through the reference renderer', async () => {
    await draw(full);
    await interact(() => one<HTMLButtonElement>('[data-agenda-fold="references"]').click());
    const table = one('[data-agenda-part="references"] table');
    const rows = [...table.querySelectorAll('tbody tr')];
    expect(rows.map(row => row.getAttribute('data-agenda-reference'))).toEqual(['term', 'link', 'link']);
    // A link means its own label; with none, the cell is empty (never a made-up sentence).
    expect(rows.map(row => row.querySelector('td')?.textContent)).toEqual([
      'the small dot on a row',
      'The change this item is about',
      '',
    ]);
    expect(rows[1]?.querySelector('a')?.getAttribute('href')).toBe('https://github.com/kirinnee/ferretry/pull/1428');
    expect(rows[2]?.querySelector('th')?.textContent).toContain('&F12');
  });
});

describe('where we are now, the main tab (&F923)', () => {
  test('opens first: decided so far and still open at its top, then where things stand', async () => {
    await draw(full);
    const tabs = one('[data-agenda-part="tabs"]');
    expect(tabs.getAttribute('data-agenda-tab')).toBe('main');
    expect(one('[role="tab"][aria-selected="true"]').textContent).toBe('Where we are now');
    const panel = one('[data-agenda-tab-panel="main"]');
    expect([...panel.children].map(child => child.getAttribute('data-agenda-section') ?? child.className)).toEqual([
      'decided',
      'still-open',
      'fy-card__where',
    ]);
    expect(panel.textContent).toContain('The two colours are tested');
    // The report is the full picture's, never repeated here: only the open tab is in the page.
    expect(tabs.textContent).not.toContain('The report you asked for');
  });

  test('holds the ferret’s answer to the owner’s question first, and What I need from you says it is there', async () => {
    await draw(
      agendaItem('A9', { ask: choices('Yes', 'No'), questionAnswer: 'It ships on Friday.' } as Partial<AgendaItem>),
    );
    // One tab: no tab row, the part is drawn under the tab's name.
    expect(one('[data-agenda-part="tabs"] > h4').textContent).toBe('Where we are now');
    expect(root().querySelector('[role="tablist"]')).toBeNull();
    expect(one('[data-agenda-part="tabs"] [data-agenda-question-answer]').textContent).toContain('It ships on Friday.');
    expect(one('[data-agenda-part="needs"] [data-agenda-answered-line]').textContent).toBe(
      'Answered: see Where we are now',
    );
  });
});

describe('the full picture', () => {
  test('holds the report the owner asked for in the body, open and whole — no cut-off, however long', async () => {
    await draw(full);
    await interact(() => one<HTMLButtonElement>('[data-agenda-tab-button="body"]').click());
    const body = one('[data-agenda-tab-panel="body"]');
    expect(one('[role="tab"][aria-selected="true"]').textContent).toBe('The full picture');
    expect(body.querySelector('[data-agenda-fold]')).toBeNull();
    expect(body.textContent).toContain('The report you asked for');
    expect(body.textContent).toContain('The last line of the report.');
    expect(body.textContent?.match(/Every finding is kept/gu)).toHaveLength(600);
  });
});

describe('the conversation', () => {
  test('shows every reply, oldest first, each whole', async () => {
    await draw(full, {}, conversation);
    await interact(() => one<HTMLButtonElement>('[data-agenda-fold="conversation"]').click());
    const said = [...one('[data-agenda-part="conversation"]').querySelectorAll('[data-history]')];
    expect(said.map(row => row.getAttribute('data-history'))).toEqual(['owner', 'ferret', 'owner', 'ferret']);
    expect(said[1]?.textContent).toContain('End.');
    expect(said[1]?.textContent?.match(/Red reads as an error/gu)).toHaveLength(200);
  });
});

describe('what it needs from you', () => {
  test('holds the ask and EVERY card ask, each with its own buttons, inside the item — never docked', async () => {
    const acted = await draw(full);
    const needs = one('[data-agenda-part="needs"]');
    const ask = must(needs.querySelector('[data-agenda-card-ask]'), 'the card ask');
    expect(ask.getAttribute('data-agenda-card-ask')).toBe('gate:F12:tested:3');
    expect(ask.textContent).toContain('Badge colour is ready to test.');
    expect(root().querySelector('.fy-item-view__dock [data-agenda-card-ask]')).toBeNull();
    const labels = [...ask.querySelectorAll('[data-agenda-option]')].map(node =>
      node.getAttribute('data-agenda-option'),
    );
    expect(labels).toEqual(['Not good', 'Done']);
    await interact(() => must(ask.querySelector<HTMLElement>('[data-agenda-option="Done"]'), 'Done').click());
    expect(acted).toEqual([expect.objectContaining({ kind: 'respond', label: 'Done', gate: true })]);
    // The item's own answers are its own row, inline under its ask and labelled: never docked beside the card's.
    expect(root().querySelector('.fy-item-view__dock [data-agenda-option="Blue"]')).toBeNull();
    const own = must(needs.querySelector('[data-agenda-item-answer]'), 'the item’s own answer');
    expect(own.textContent).toContain('Your answer for this item');
    expect(own.querySelector('[data-agenda-option="Blue"]')).not.toBeNull();
  });

  test('offers the owner’s plain “yes” reply as the card ask’s answer, one tap, never applied (&B155)', async () => {
    const acted = await draw(full, {}, [{ kind: 'owner', key: 'o1', at: NOW - 1_000, text: 'works for me!' }]);
    const offer = one('[data-agenda-card-ask] [data-agenda-reply-offer]');
    expect(offer.textContent).toContain('You replied “works for me!”.');
    expect(acted).toEqual([]);
    await interact(() => one<HTMLButtonElement>('[data-agenda-reply-offer-use="Done"]').click());
    expect(acted).toEqual([
      expect.objectContaining({ kind: 'respond', label: 'Done', gate: true, cardAsk: 'gate:F12:tested:3' }),
    ]);
    await unmount();
    // Longer words, or the ferret answering after them, offer nothing.
    await draw(full, {}, [{ kind: 'owner', key: 'o1', at: NOW - 1_000, text: 'works, but the colour is off' }]);
    expect(root().querySelector('[data-agenda-reply-offer]')).toBeNull();
    await unmount();
    await draw(full, {}, conversation);
    expect(root().querySelector('[data-agenda-reply-offer]')).toBeNull();
  });

  test('is marked out while the item needs the owner, and quiet once it rests', async () => {
    await draw(full);
    expect(one('[data-agenda-part="needs"]').hasAttribute('data-agenda-needs-you')).toBe(true);
    await unmount();
    await draw(
      agendaItem('A4', {
        ask: choices('Yes', 'No'),
        parked: { reason: 'replied', at: '2026-08-01T11:00:00.000Z' },
      } as Partial<AgendaItem>),
    );
    expect(one('[data-agenda-part="needs"]').hasAttribute('data-agenda-needs-you')).toBe(false);
  });

  test('gives every card ask its own heading, and the board’s How to test when the host has it', async () => {
    await draw(full, { howToTestFor: id => (id === 'F12' ? '1. Open the badge.\n2. See it is blue.' : null) });
    const ask = one('[data-agenda-card-ask]');
    expect(ask.querySelector('[data-agenda-card-ask-title]')?.textContent).toBe('Card &F12: your answer for the card');
    const steps = must(ask.querySelector('[data-agenda-card-ask-test]'), 'the test steps');
    expect(steps.textContent).toContain('How to test');
    expect(steps.textContent).toContain('Open the badge.');
    await unmount();
    await draw(full);
    expect(root().querySelector('[data-agenda-card-ask-test]')).toBeNull();
  });

  test('docks the item’s row at the view’s foot only when no card ask shares the view', async () => {
    await draw(agendaItem('A3', { ask: choices('Yes', 'No'), premise: '- a', context: '- b' } as Partial<AgendaItem>));
    expect(root().querySelector('.fy-item-view__dock [data-agenda-option="Yes"]')).not.toBeNull();
    expect(root().querySelector('[data-agenda-item-answer]')).toBeNull();
  });

  test('draws a review’s links once: under "What to review", not again in the references table', async () => {
    await draw(
      agendaItem('A8', {
        ask: choices('Approve', 'Reject'),
        kind: 'review',
        links: [{ label: 'The change', target: 'https://github.com/kirinnee/ferretry/pull/9' }],
      } as Partial<AgendaItem>),
    );
    expect(root().querySelectorAll('a[href="https://github.com/kirinnee/ferretry/pull/9"]')).toHaveLength(1);
    expect(
      one('a[href="https://github.com/kirinnee/ferretry/pull/9"]').closest('[data-agenda-part="needs"]'),
    ).not.toBeNull();
    expect(root().querySelector('[data-agenda-reference="link"]')).toBeNull();
  });

  // &B156: !A304 was a reply with three questions carrying "OK to build" for &F923, and the app drew no button for it.
  test('draws a card ask’s own buttons on a thread of questions, which is still answered in words', async () => {
    const plan = {
      ...gate,
      cardId: 'F923',
      laneId: 'plan',
      laneName: 'Plan',
      options: [{ id: 'ok', label: 'OK to build', outcome: 'next' }],
    };
    const acted = await draw(
      agendaItem('A304', {
        kind: 'reply',
        ask: { kind: 'open-question' },
        stage: 'plan',
        questions: [{ question: 'One?' }, { question: 'Two?' }, { question: 'Three?' }],
        premise: '- p',
        context: '- c',
        gateAttached: plan,
        cardAsks: [{ gate: plan, at: '2026-08-01T11:00:00.000Z' }],
      } as unknown as Partial<AgendaItem>),
    );
    const needs = one('[data-agenda-part="needs"]');
    const ask = must(needs.querySelector('[data-agenda-card-ask="gate:F923:plan:3"]'), 'the card ask');
    const ok = must(ask.querySelector<HTMLButtonElement>('[data-agenda-option="OK to build"]'), 'OK to build');
    // The thread's own questions are still asked, in words, with no buttons and no empty heading of their own.
    expect(needs.textContent).toContain('Three?');
    expect(needs.querySelector('[data-agenda-item-answer]')).toBeNull();
    await interact(() => ok.click());
    expect(acted).toHaveLength(1);
    expect(acted[0]).toMatchObject({ gate: true, cardAsk: 'gate:F923:plan:3' });
  });

  test('draws no card ask on an earlier version, which only reads', async () => {
    await draw(full);
    await interact(() => one<HTMLButtonElement>('[data-agenda-menu-toggle]').click());
    const picker = one<HTMLSelectElement>('[data-agenda-version-picker]');
    await interact(() => {
      picker.value = '1';
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(root().querySelector('[data-agenda-card-ask]')).toBeNull();
  });
});

describe('opened at its ask', () => {
  test('a push or a link that names the item scrolls to "What I need from you" and focuses it', async () => {
    const scrolled: string[] = [];
    // Stubbed on the instance's own prototype chain and put back exactly as it was, so no later test sees the stub.
    const own = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value(this: HTMLElement) {
        scrolled.push(this.getAttribute('data-agenda-part') ?? '');
      },
    });
    try {
      await draw(full, { startAt: 'ask' }, conversation);
      expect(scrolled).toEqual(['needs']);
      expect(document.activeElement).toBe(one('[data-agenda-part="needs"]'));
    } finally {
      if (own === undefined) Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
      else Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', own);
    }
  });

  test('without it, the view opens at its top with the dialog focused', async () => {
    await draw(full);
    expect(document.activeElement).toBe(one('[data-agenda-view]'));
  });
});

describe('the activity log', () => {
  test('lists each stage change and each edit, apart from the conversation', async () => {
    await draw(full, {}, conversation);
    await interact(() => one<HTMLButtonElement>('[data-agenda-fold="activity"]').click());
    const lines = [...one('[data-agenda-activity]').querySelectorAll('.fy-activity__text > span')].map(
      span => span.textContent,
    );
    expect(lines).toEqual(['Started as Explainer', 'Moved to Question', 'Updated to v2']);
    expect(one('[data-agenda-part="conversation"]').textContent).not.toContain('Updated to v2');
  });
});
