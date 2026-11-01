import { afterEach, describe, expect, test } from 'bun:test';
import type { AgendaItem } from '@ferretry/protocol';
import { Markdown } from '../../../src/components/markdown.tsx';
import { AgendaItemView, type AgendaItemViewProps } from '../../../src/features/agenda/agenda-item-view.tsx';
import type { HistoryEvent } from '../../../src/lib/agenda-history.ts';
import { DISMISS_ACTION, type InboxAction } from '../../../src/lib/agenda-inbox.ts';
import type { DaemonId } from '../../../src/lib/daemon-connection.ts';
import { registerComposerQuoteTarget } from '../../../src/lib/quote.ts';
import { agendaItem, choices } from '../../support/agenda-inbox.tsx';
import { interact, type Mounted, mount, must, pressKey } from '../../support/dom.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const NOW = Date.parse('2026-08-01T12:00:00.000Z');

const richItem = agendaItem('A47', {
  title: 'Database for the board',
  subject: 'Which database should keep the board’s finished items?',
  ask: choices('SQLite', 'Postgres'),
  recommendation: { decision: 'SQLite', why: 'No server to run.' },
  premise: '- The board keeps every finished item in a WAL\n- Reads are rare',
  context: '- Postgres means another service',
  decided: '- Finished items are kept',
  stillOpen: '- Which engine',
  terms: [
    { term: 'WAL', meaning: 'write-ahead log' },
    { term: 'ACID', meaning: 'safe commits' },
  ],
  revisions: [
    { at: '2026-08-01T10:00:00.000Z', by: 'agent', changed: ['subject'], previous: { subject: 'Which engine?' } },
  ],
} as unknown as Partial<AgendaItem>);

interface Spy {
  readonly acted: InboxAction[];
  closed: number;
  previous: number;
  next: number;
  progress: [number, boolean][];
}

const draw = async (
  item: AgendaItem,
  extra: Partial<AgendaItemViewProps> = {},
  history: readonly HistoryEvent[] = [],
): Promise<Spy> => {
  const spy: Spy = { acted: [], closed: 0, previous: 0, next: 0, progress: [] };
  view = await mount(
    <AgendaItemView
      busy={false}
      error={null}
      ferret="Zoe"
      history={history}
      item={item}
      now={NOW}
      onAct={action => spy.acted.push(action)}
      onClose={() => {
        spy.closed += 1;
      }}
      onNext={() => {
        spy.next += 1;
      }}
      onPrevious={() => {
        spy.previous += 1;
      }}
      onProgress={async (step, done) => {
        spy.progress.push([step, done]);
      }}
      position={{ index: 1, total: 3 }}
      renderProse={text => text}
      swipeable
      {...extra}
    />,
  );
  return spy;
};

const root = (): HTMLElement => must(view?.container, 'the view');
const one = <T extends Element>(selector: string): T => must(root().querySelector<T>(selector), selector);
const press = (key: string, init: KeyboardEventInit = {}, target: EventTarget = one('[data-agenda-view]')) =>
  interact(() => pressKey(target, key, init));

const markdown = (text: string) => <Markdown text={text} />;

describe('the item view tools behind ⓘ', () => {
  test('draws ⓘ for a host that hands it tools even when the item has no description, and puts them in its panel', async () => {
    await draw(richItem, {
      tools: (
        <button data-test-tool="" type="button">
          Skip
        </button>
      ),
    });
    expect(root().querySelector('[data-test-tool]')).toBeNull();
    await interact(() => one<HTMLButtonElement>('[data-agenda-info-toggle]').click());
    expect(one('[data-test-tool]').textContent).toBe('Skip');
  });
});

describe('the item view snooze control', () => {
  test('draws no clock when it is given nothing to snooze with', async () => {
    await draw(richItem);
    expect(root().querySelector('[data-agenda-snooze]')).toBeNull();
  });

  test('puts the clock in the head’s one row, after ⓘ and before ✕ — never in the ⓘ panel — and snoozes from there; off while busy', async () => {
    const snoozed: string[] = [];
    await draw(richItem, { onSnooze: until => snoozed.push(until) });
    const clock = one<HTMLButtonElement>('.fy-item-view__bar [data-agenda-snooze]');
    expect(clock.className).toBe('fy-item-view__step fy-item-view__step--tight fy-card-head__snooze');
    await interact(() => one<HTMLButtonElement>('[data-agenda-info-toggle]').click());
    expect(root().querySelectorAll('[data-agenda-snooze]')).toHaveLength(1);
    expect(root().querySelector('[data-agenda-info-panel] [data-agenda-snooze]')).toBeNull();
    await interact(() => clock.click());
    await interact(() => must(root().querySelector<HTMLElement>('[role="menuitem"]'), '1 hour').click());
    expect(snoozed).toEqual([new Date(NOW + 3_600_000).toISOString()]);
    await view?.unmount();
    view = null;
    await draw(richItem, { onSnooze: () => undefined, busy: true });
    expect(one<HTMLButtonElement>('[data-agenda-snooze]').disabled).toBe(true);
  });

  test('has no ⓘ for an item with nothing to say under its title, but still has its clock', async () => {
    await draw(
      agendaItem('A48', {
        title: 'Same',
        subject: 'Same',
        why: 'Same',
        ask: choices('Yes', 'No'),
      } as unknown as Partial<AgendaItem>),
      {
        onSnooze: () => undefined,
      },
    );
    expect(root().querySelector('[data-agenda-info-toggle]')).toBeNull();
    expect(root().querySelectorAll('.fy-item-view__bar [data-agenda-snooze]')).toHaveLength(1);
  });
});

describe('the v6 layout: title, ONE card, history — one column', () => {
  test('is a dialog over the message list whose ONE scroller holds the head, the card and the History in order', async () => {
    const history: HistoryEvent[] = [{ kind: 'ferret', key: 'f', at: NOW, text: 'Re !A47: noted.' }];
    await draw(richItem, {}, history);
    expect(one('section').getAttribute('role')).toBe('dialog');
    const column = one('.fy-item-view__body > .fy-item-view__column');
    expect([...column.children].map(child => child.className.split(' ')[0])).toEqual([
      'fy-item-view__head',
      'fy-card',
      'fy-hist',
      'fy-item-view__dock',
    ]);
    // The answer row is in the sticky dock at the foot of the column, not a strip of its own above the composer.
    expect(one('.fy-item-view__dock [data-agenda-quick-replies]')).toBeDefined();
    expect(root().querySelectorAll('[data-agenda-quick-replies]')).toHaveLength(1);
  });

  test('is ONE row: the title, then the status dot, the pager, ⓘ, the clock and ✕ — nothing under it until ⓘ opens', async () => {
    await draw(richItem, { onSnooze: () => undefined });
    const head = one('.fy-item-view__head');
    expect([...head.children].filter(child => !child.hasAttribute('hidden')).map(child => child.className)).toEqual([
      'fy-item-view__bar fy-card-head',
    ]);
    const bar = one('.fy-item-view__head > .fy-item-view__bar');
    expect([...bar.children].map(child => child.className.split(' ')[0])).toEqual([
      'fy-item-view__title',
      'fy-item-view__pager',
    ]);
    expect(one('[data-agenda-title]').textContent).toBe('Database for the board');
    const tools = [...bar.querySelectorAll('.fy-item-view__pager > *')].map(
      node => node.getAttribute('aria-label') ?? node.getAttribute('data-agenda-where') ?? node.className,
    );
    expect(one('[data-agenda-where]').textContent).toBe('2/3');
    expect(tools).toEqual([
      expect.stringContaining('fy-item-view__status'),
      'Previous item',
      '2 of 3',
      'Next item',
      'About this item',
      'fy-snooze',
      'Back to the chat',
    ]);
    expect(root().querySelector('[data-agenda-ask]')).toBeNull();
  });

  test('says the item’s ask behind ⓘ: a tap opens its panel under the row, another closes it', async () => {
    await draw(richItem);
    const toggle = one<HTMLButtonElement>('.fy-item-view__bar [data-agenda-info-toggle]');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe(one('[data-agenda-info-panel]').id);
    expect(one<HTMLElement>('[data-agenda-info-panel]').hidden).toBe(true);
    await interact(() => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const panel = one<HTMLElement>('.fy-item-view__head > [data-agenda-info-panel]');
    expect(panel.hidden).toBe(false);
    expect(one('.fy-item-view__head [data-agenda-ask]').textContent).toBe(
      'Which database should keep the board’s finished items?',
    );
    await interact(() => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(one<HTMLElement>('[data-agenda-info-panel]').hidden).toBe(true);
  });

  test('a new item opens with its ⓘ closed', async () => {
    await draw(richItem);
    await interact(() => one<HTMLButtonElement>('[data-agenda-info-toggle]').click());
    await view?.unmount();
    view = null;
    await draw(agendaItem('A48', { title: 'Another', subject: 'Which?' } as Partial<AgendaItem>));
    expect(one('[data-agenda-info-toggle]').getAttribute('aria-expanded')).toBe('false');
  });

  test('draws no ⓘ when there is nothing to say behind it', async () => {
    await draw(agendaItem('A49', { title: 'Same', subject: 'Same', why: 'Same' } as Partial<AgendaItem>), {}, []);
    expect(root().querySelector('[data-agenda-info-toggle], [data-agenda-info-panel]')).toBeNull();
  });

  test('keeps a title that fits as plain text, and marks none as scrolling until the browser says it overflows', async () => {
    await draw(richItem);
    const title = one('[data-agenda-title]');
    expect(title.getAttribute('data-marquee')).toBeNull();
    expect(title.querySelector('.fy-item-view__title-text')?.textContent).toBe('Database for the board');
  });

  test('draws premise and context as ONE panel, labelled Premise and Context — never "Why now"', async () => {
    await draw(richItem);
    const panel = one('.fy-card [data-agenda-situation]');
    expect([...panel.querySelectorAll('h4')].map(label => label.textContent)).toEqual(['Premise', 'Context']);
    expect(panel.querySelectorAll('li')).toHaveLength(3);
    const text = root().textContent ?? '';
    expect(text).not.toMatch(/why now|what’s going on|what's going on|why it matters/iu);
  });

  test('teaches nothing: no hint line under the type, no ⋯ menu', async () => {
    await draw(richItem);
    expect(one('.fy-card__top [data-agenda-type]').textContent).toBe('Decision');
    const text = root().textContent ?? '';
    expect(text).not.toContain('it is yours to decide');
    expect(text).not.toContain('⋯');
    expect(root().querySelector('[aria-haspopup="menu"]:not([data-agenda-snooze])')).toBeNull();
  });
});

describe('the question and its options', () => {
  const spend = agendaItem('A90', {
    title: 'Spend limit: what happens at the hard limit?',
    subject: 'One rule left before spend limits ship.',
    premise: '- Each login has a limit',
    context: '- A running turn always finishes',
    questions: [
      {
        question: 'At the hard limit, what should happen?',
        options: [{ label: 'Pause' }, { label: 'Switch' }, { label: 'Warn' }],
        recommended: 'Pause',
        why: 'It can never overspend.',
      },
    ],
    ask: {
      kind: 'multiple-choice',
      options: [
        { label: 'Pause', description: 'No new turns on that login until it resets' },
        { label: 'Switch', description: 'New turns move to a login with room left' },
        { label: 'Warn', description: 'Nothing stops; you get one Inbox notice' },
      ],
    },
  } as Partial<AgendaItem>);

  test('states the question, then each option’s one word and what it means, the recommended one said in words', async () => {
    await draw(spend);
    expect(one('[data-agenda-question-line]').textContent).toBe('At the hard limit, what should happen?');
    const rows = [...root().querySelectorAll('[data-agenda-options] > li')];
    expect(rows.map(row => row.querySelector('.fy-card__option-name')?.textContent)).toEqual([
      'Pause',
      'Switch',
      'Warn',
    ]);
    expect(rows[0]?.textContent).toBe('PauseNo new turns on that login until it resets· Recommended');
    expect(rows[1]?.querySelector('[data-agenda-recommended]')).toBeNull();
  });

  test('puts at most three answers in ONE row, in the list’s order, ← ↑ → with their arrows, named as the list names them', async () => {
    await draw(spend);
    const chips = [...root().querySelectorAll('.fy-item-view__dock .fy-qr__row > button')];
    // In the options list's order, wherever the recommendation sits; it keeps its outline in its place.
    expect(chips.map(chip => chip.textContent)).toEqual(['←Pause', '↑Switch', '→Warn']);
    expect(chips[0]?.hasAttribute('data-recommended')).toBe(true);
    expect(root().querySelectorAll('.fy-qr__row')).toHaveLength(1);
  });

  test('says why it recommends the option in a section of its own, open', async () => {
    await draw(spend);
    const why = one('[data-agenda-section="recommendation"]');
    expect(why.querySelector('h4')?.textContent).toBe('Why I recommend Pause');
    expect(why.textContent).toContain('It can never overspend.');
  });

  test('letters every option when one label is not a single word, and the buttons say the letters too', async () => {
    await draw(
      agendaItem('A92', {
        ask: {
          kind: 'multiple-choice',
          options: [{ label: 'Studio disk' }, { label: 'S3' }, { label: 'Skip' }],
        },
      } as Partial<AgendaItem>),
    );
    expect([...root().querySelectorAll('.fy-card__option-name')].map(name => name.textContent)).toEqual([
      'A',
      'B',
      'C',
    ]);
    expect(one('[data-agenda-option-detail="Studio disk"] .fy-card__option-meaning').textContent).toBe(
      '**Studio disk**',
    );
    expect([...root().querySelectorAll('.fy-qr__label')].map(label => label.textContent).sort()).toEqual([
      'A',
      'B',
      'C',
    ]);
  });

  test('lets an option past the three be chosen from its row in the list — never a second row of buttons', async () => {
    const spy = await draw(
      agendaItem('A93', { ask: choices('North', 'South', 'East', 'West') } as Partial<AgendaItem>),
    );
    expect(root().querySelectorAll('.fy-qr__row > button')).toHaveLength(3);
    expect(root().querySelector('[data-agenda-more-row]')).toBeNull();
    const west = one<HTMLButtonElement>('[data-agenda-options] [data-agenda-option="West"]');
    await interact(() => west.click());
    expect(spy.acted[0]).toMatchObject({ kind: 'respond', response: { choice: 'West' } });
  });

  test('draws no list that would only repeat its buttons', async () => {
    await draw(agendaItem('A94', { ask: choices('Yes', 'No') } as Partial<AgendaItem>));
    expect(root().querySelector('[data-agenda-options]')).toBeNull();
  });
});

describe('Not needed', () => {
  test('is a small pill in the card’s top bar — a button only, saying no swipe and no arrow', async () => {
    const spy = await draw(richItem);
    const pill = one<HTMLButtonElement>('.fy-card__top [data-agenda-dismiss]');
    expect(pill.textContent).toBe('Not needed');
    expect(pill.getAttribute('aria-label')).toBe('Not needed');
    expect(pill.querySelector('.fy-card__arrow')).toBeNull();
    expect(root().querySelector('.fy-qr [data-agenda-dismiss]')).toBeNull();
    await interact(() => pill.click());
    expect(spy.acted).toEqual([DISMISS_ACTION]);
  });

  test('stays a button on a phone too: still no swipe wording', async () => {
    await draw(richItem, { swipeable: true });
    expect(one('.fy-card__top [data-agenda-dismiss]').getAttribute('aria-label')).toBe('Not needed');
  });

  test('is never the ↓ key or the ↓ swipe on the answer row: those skip to the next item and answer nothing', async () => {
    const spy = await draw(richItem);
    await press('ArrowDown');
    const row = one<HTMLElement>('[data-agenda-quick-replies]');
    const touch = (type: string, y: number): PointerEvent =>
      new PointerEvent(type, { bubbles: true, clientX: 200, clientY: y, pointerId: 5, pointerType: 'touch' });
    await interact(() => row.dispatchEvent(touch('pointerdown', 100)));
    await interact(() => row.dispatchEvent(touch('pointermove', 300)));
    await interact(() => row.dispatchEvent(touch('pointerup', 300)));
    expect([spy.next, spy.acted]).toEqual([2, []]);
  });

  test('has no ↓ key or swipe at all where there is no next item to skip to, and still dismisses nothing', async () => {
    const spy = await draw(richItem, { onNext: undefined });
    await press('ArrowDown');
    const row = one<HTMLElement>('[data-agenda-quick-replies]');
    const touch = (type: string, y: number): PointerEvent =>
      new PointerEvent(type, { bubbles: true, clientX: 200, clientY: y, pointerId: 5, pointerType: 'touch' });
    await interact(() => row.dispatchEvent(touch('pointerdown', 100)));
    await interact(() => row.dispatchEvent(touch('pointerup', 300)));
    expect([spy.next, spy.acted]).toEqual([0, []]);
  });

  describe('the pull down over the card’s top bar', () => {
    const pointer = (type: string, y: number, init: PointerEventInit = {}): PointerEvent =>
      new PointerEvent(type, { bubbles: true, clientX: 200, clientY: y, pointerId: 3, pointerType: 'touch', ...init });
    const pull = async (to: number, init: PointerEventInit = {}): Promise<void> => {
      const top = one<HTMLElement>('[data-agenda-card-top]');
      await interact(() => top.dispatchEvent(pointer('pointerdown', 100, init)));
      await interact(() => top.dispatchEvent(pointer('pointerup', to, init)));
    };

    test('a clear pull down on touch is Skip: the next item, and nothing dismissed or answered', async () => {
      const spy = await draw(richItem);
      await pull(300);
      expect([spy.next, spy.acted, spy.closed]).toEqual([1, [], 0]);
    });

    test('a short pull, a mouse, a bar that does not swipe and a pointer it never saw do nothing', async () => {
      const spy = await draw(richItem);
      await pull(140);
      await pull(300, { pointerType: 'mouse' });
      const top = one<HTMLElement>('[data-agenda-card-top]');
      await interact(() => top.dispatchEvent(pointer('pointerdown', 100)));
      await interact(() => top.dispatchEvent(pointer('pointerup', 300, { pointerId: 9 })));
      await interact(() => top.dispatchEvent(pointer('pointercancel', 300)));
      await interact(() => top.dispatchEvent(pointer('pointerup', 300)));
      expect([spy.next, spy.acted]).toEqual([0, []]);
      await view?.unmount();
      const still = await draw(richItem, { swipeable: false });
      await pull(300);
      expect([still.next, still.acted]).toEqual([0, []]);
    });
  });

  test('is not offered where the item cannot be answered here', async () => {
    await draw(richItem, { settled: <p data-settled="">Snoozed</p> });
    expect(root().querySelector('[data-agenda-dismiss]')).toBeNull();
    expect(one('.fy-card [data-settled]').textContent).toBe('Snoozed');
  });
});

describe('the version picker', () => {
  test('says which version this is, and redraws the card as an earlier one read, with the way back', async () => {
    const edited = agendaItem('A47', {
      premise: '- Now: two engines',
      revisions: [
        { at: '2026-08-01T11:57:00.000Z', by: 'agent', changed: ['premise'], previous: { premise: '- Then: one' } },
      ],
    } as Partial<AgendaItem>);
    await draw(edited);
    const picker = one<HTMLSelectElement>('.fy-card__top [data-agenda-version-picker]');
    expect([...picker.options].map(option => option.textContent)).toEqual(['v2 of 2 · 3m ago', expect.any(String)]);
    expect(picker.options[1]?.textContent).toMatch(/^v1 of 2/u);
    await interact(() => {
      picker.value = '1';
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(one('[data-agenda-situation]').textContent).toContain('Then: one');
    expect(root().querySelector('[data-agenda-quick-replies]')).toBeNull();
    expect(root().querySelector('[data-agenda-dismiss]')).toBeNull();
    await interact(() => one<HTMLButtonElement>('[data-agenda-latest]').click());
    expect(one('[data-agenda-situation]').textContent).toContain('Now: two engines');
    expect(root().querySelector('[data-agenda-quick-replies]')).not.toBeNull();
  });

  test('is not drawn for an item never edited', async () => {
    await draw(agendaItem('A3', { ask: choices('Yes', 'No') } as Partial<AgendaItem>));
    expect(root().querySelector('[data-agenda-version-picker]')).toBeNull();
  });
});

describe('the sections the ferret added', () => {
  test('draws only what the item carries: an item with premise and context alone has no sections', async () => {
    await draw(agendaItem('A3', { ask: choices('Yes', 'No'), premise: '- a', context: '- b' } as Partial<AgendaItem>));
    expect(root().querySelectorAll('.fy-card__section')).toHaveLength(0);
  });

  test('draws what else the item carries, open — decided, still open, impact, links — each under its own name', async () => {
    await draw(
      agendaItem('A7', {
        ask: { kind: 'permission' },
        decided: '- kept',
        stillOpen: '- engine',
        impact: '- writes to the bucket',
        urgency: 'before Friday',
        links: [{ label: 'The PR', target: 'https://example.test/pr/1' }],
        recommendation: { decision: 'Allow it for a week', why: 'It is reversible.' },
      } as Partial<AgendaItem>),
    );
    const titles = [...root().querySelectorAll('.fy-card__section > h4')].map(title => title.textContent);
    expect(titles).toEqual([
      'Why I recommend Allow it for a week',
      'Decided so far',
      'Still open',
      'What it allows',
      'Links',
    ]);
    expect(one('[data-agenda-section="impact"]').textContent).toContain('Urgency: before Friday');
    expect(one('[data-agenda-section="recommendation"] .fy-card__decision').textContent).toBe('Allow it for a week');
    expect(one<HTMLAnchorElement>('[data-agenda-section="links"] a').href).toBe('https://example.test/pr/1');
  });

  test('leads a to-do with its steps, tickable', async () => {
    const spy = await draw(
      agendaItem('A4', { kind: 'task', ask: { kind: 'task' }, steps: ['Open it', 'Rotate it'] } as Partial<AgendaItem>),
    );
    expect(root().querySelector('details')).toBeNull();
    await interact(() => one<HTMLInputElement>('[data-agenda-tick="1"]').click());
    expect(spy.progress).toEqual([[1, true]]);
  });

  test('draws a review’s body as its Reasoning and any other body as More detail, both open', async () => {
    await draw(
      agendaItem('A5', { kind: 'review', ask: { kind: 'answer-review' }, body: 'Because.' } as Partial<AgendaItem>),
    );
    expect(one('[data-agenda-section="reasoning"] h4').textContent).toBe('Reasoning');
    await view?.unmount();
    view = null;
    await draw(agendaItem('A6', { ask: choices('Yes', 'No'), body: 'More.' } as Partial<AgendaItem>));
    expect(one('[data-agenda-section="more"] h4').textContent).toBe('More detail');
    expect(root().querySelector('details')).toBeNull();
  });
});

describe('terms', () => {
  test('are underlined where the premise uses them; a tap shows the meaning, a second tap or Esc hides it', async () => {
    await draw(richItem, { renderProse: markdown });
    const mark = one<HTMLAnchorElement>('[data-agenda-situation] a[href="#fy-term-0"]');
    expect(mark.textContent).toBe('WAL');
    await interact(() => mark.click());
    expect(one('[data-agenda-term-tip]').textContent).toBe('WAL write-ahead log');
    await interact(() => mark.click());
    expect(root().querySelector('[data-agenda-term-tip]')).toBeNull();
    await interact(() => mark.click());
    await press('Escape', {}, mark);
    expect(root().querySelector('[data-agenda-term-tip]')).toBeNull();
  });

  test('are listed in an open Terms section', async () => {
    await draw(richItem);
    const terms = one('[data-agenda-section="terms"]');
    expect([...terms.querySelectorAll('dt')].map(term => term.textContent)).toEqual(['WAL', 'ACID']);
  });
});

describe('an input request', () => {
  test('draws its form inside the card, in the answer row’s place', async () => {
    const input = agendaItem('A8', {
      kind: 'input',
      input: { requestId: '0'.repeat(32) },
      premise: '- A terminal waits at a password prompt',
      context: '- Ferretry types it there',
    } as Partial<AgendaItem>);
    await draw(input, { inputForm: <form data-fake-input="" /> });
    expect(one('.fy-card [data-agenda-input-form] [data-fake-input]')).toBeDefined();
    expect(root().querySelector('[data-agenda-quick-replies]')).toBeNull();
    expect(root().querySelector('[data-agenda-dismiss]')).toBeNull();
  });
});

describe('moving through the items', () => {
  test('‹ and › page, and are disabled at the ends', async () => {
    const spy = await draw(richItem);
    await interact(() => one<HTMLButtonElement>('[aria-label="Previous item"]').click());
    await interact(() => one<HTMLButtonElement>('[aria-label="Next item"]').click());
    expect([spy.previous, spy.next]).toEqual([1, 1]);
    await view?.unmount();
    await draw(richItem, { onPrevious: undefined, onNext: undefined });
    expect(one<HTMLButtonElement>('[aria-label="Previous item"]').disabled).toBe(true);
    expect(one<HTMLButtonElement>('[aria-label="Next item"]').disabled).toBe(true);
  });

  test('✕ and Esc go back to the chat', async () => {
    const spy = await draw(richItem);
    await interact(() => one<HTMLButtonElement>('[data-agenda-close]').click());
    await press('Escape');
    expect(spy.closed).toBe(2);
    expect(spy.next).toBe(0);
  });

  test('hands focus to itself so the keys work, and again for another item', async () => {
    await draw(richItem);
    expect(document.activeElement).toBe(one('[data-agenda-view]'));
  });
});

describe('the keys', () => {
  test('← ↑ → answer with the item’s own answers where there is one (→ has none here)', async () => {
    const spy = await draw(richItem);
    await press('ArrowRight');
    await press('ArrowLeft');
    await press('ArrowUp');
    expect(spy.acted.map(action => (action as { response?: { choice?: string } }).response?.choice)).toEqual([
      'Postgres',
      'SQLite',
    ]);
  });

  test('do nothing while the item is busy, with a modifier, or for a key it does not own', async () => {
    const busy = await draw(richItem, { busy: true });
    await press('ArrowRight');
    await press('ArrowDown');
    expect(busy.acted).toEqual([]);
    await view?.unmount();
    const spy = await draw(richItem);
    await press('ArrowRight', { metaKey: true });
    await press('Escape', { ctrlKey: true });
    await press('ArrowLeft', { altKey: true });
    await press('x');
    expect(spy.acted).toEqual([]);
    expect(spy.closed).toBe(0);
  });

  test('stay out of a button, which keeps its own keys', async () => {
    const spy = await draw(richItem);
    await press('ArrowRight', {}, one('[data-agenda-option="SQLite"]'));
    await press('Escape', {}, one('[data-agenda-option="Postgres"]'));
    await press('ArrowDown', {}, one('[aria-label="Next item"]'));
    expect(spy.acted).toEqual([]);
    expect(spy.closed).toBe(0);
  });
});

describe('the answer row', () => {
  test('tags the recommended chip, and a tap answers', async () => {
    const spy = await draw(richItem);
    const chip = one<HTMLButtonElement>(
      '.fy-item-view__dock [data-agenda-quick-replies] [data-agenda-option="SQLite"]',
    );
    expect(chip.hasAttribute('data-recommended')).toBe(true);
    expect(chip.getAttribute('aria-label')).toContain('SQLite, recommended');
    await interact(() => chip.click());
    expect(spy.acted).toHaveLength(1);
    expect(spy.acted[0]).toMatchObject({ kind: 'respond', response: { choice: 'SQLite' } });
  });

  test('says an item with its ferret is being waited on', async () => {
    await draw(agendaItem('A9', { ask: { kind: 'permission' }, waitingOn: 'ferret' } as Partial<AgendaItem>));
    expect(root().textContent).toContain('With Zoe — it will update this.');
  });

  test('says what the machine refused', async () => {
    await draw(richItem, { error: 'No.' });
    expect(one('[role="alert"]').textContent).toBe('Not sent: No.');
  });
});

describe('What I need from you', () => {
  const need = (): HTMLElement => one('[data-agenda-need]');
  const lead = (): string => one('[data-agenda-need-lead]').textContent ?? '';
  const chips = (): string[] =>
    [...root().querySelectorAll('[data-agenda-quick-replies] .fy-qr__chip')].map(each => each.textContent ?? '');
  const several = agendaItem('A5', {
    title: 'Plan the launch',
    subject: 'Three things to settle for the launch',
    ask: { kind: 'open-question' },
    kind: 'reply',
    questions: [
      {
        question: 'Which day should it ship?',
        options: [{ label: 'Monday' }, { label: 'Friday' }],
        recommended: 'Monday',
      },
      { question: 'OK to restart the build box?' },
      { question: 'Your work email?' },
    ],
  } as Partial<AgendaItem>);

  test('sits directly under the premise and context, before every optional section', async () => {
    await draw(richItem);
    const card = one('.fy-card');
    const order = [...card.querySelectorAll('[data-agenda-situation], [data-agenda-need], [data-agenda-section]')]
      .map(
        each =>
          each.getAttribute('data-agenda-section') ?? (each.hasAttribute('data-agenda-need') ? 'need' : 'situation'),
      )
      .filter(name => name !== 'premise' && name !== 'context');
    expect(order.slice(0, 2)).toEqual(['situation', 'need']);
    expect(need().querySelector('h4')?.textContent).toBe('What I need from you');
  });

  test('a choice: the options and what each means inside it, the options as the buttons, "Pick one option."', async () => {
    await draw(
      agendaItem('A47', {
        ...richItem,
        ask: {
          kind: 'multiple-choice',
          options: [
            { label: 'SQLite', description: 'One file, no server' },
            { label: 'Postgres', description: 'Another service to run' },
          ],
        },
      } as Partial<AgendaItem>),
    );
    expect(need().getAttribute('data-agenda-need')).toBe('choice');
    expect(need().querySelector('[data-agenda-options]')?.textContent).toContain('One file, no server');
    expect(lead()).toBe('Pick one option.');
    expect(chips()).toEqual(['←SQLite', '→Postgres']);
  });

  test('several questions: a numbered list of each answer wanted, no buttons, no swipes, "Reply with your answers below"', async () => {
    const spy = await draw(several);
    expect(need().getAttribute('data-agenda-need')).toBe('answers');
    const wanted = [...need().querySelectorAll('[data-agenda-wanted-answer]')].map(each => each.textContent ?? '');
    expect(wanted).toHaveLength(3);
    expect(wanted[0]).toContain('1.');
    expect(wanted[0]).toContain('Which day should it ship?');
    // An option a question was raised with before the rule is said in words, never a button.
    expect(wanted[0]).toContain('Monday / Friday');
    expect(wanted[0]).toContain('Suggested: Monday');
    expect(wanted[2]).toContain('Your work email?');
    expect(lead()).toBe('Reply with your answers below, numbered.');
    expect(root().querySelector('[data-agenda-pick], [data-agenda-send-answers], [data-agenda-option]')).toBeNull();
    expect(root().querySelector('[data-agenda-quick-replies]')).toBeNull();
    await pressKey(one('.fy-item-view'), 'ArrowRight');
    await pressKey(one('.fy-item-view'), 'ArrowLeft');
    expect(spy.acted).toEqual([]);
  });

  test('an open question: the question alone, no buttons, "Type your answer below."', async () => {
    await draw(
      agendaItem('A6', {
        kind: 'reply',
        ask: { kind: 'open-question' },
        subject: 'What should the welcome email say?',
        answers: [{ direction: 'right', does: 'done', label: 'Done' }],
      } as Partial<AgendaItem>),
    );
    expect(need().getAttribute('data-agenda-need')).toBe('reply');
    expect(lead()).toBe('Type your answer below.');
    expect(root().querySelector('[data-agenda-quick-replies]')).toBeNull();
    expect(one('[data-agenda-dock]').childElementCount).toBe(0);
  });

  test('a to-do: its steps numbered and ticked inside it, then one Mark as done', async () => {
    const spy = await draw(
      agendaItem('A4', {
        kind: 'task',
        ask: { kind: 'task' },
        steps: ['Open it', 'Rotate it'],
        answers: [
          { direction: 'left', does: 'needs-info', label: 'Need more info' },
          { direction: 'right', does: 'done', label: 'Mark as done' },
        ],
      } as Partial<AgendaItem>),
    );
    expect(need().getAttribute('data-agenda-need')).toBe('todo');
    expect(need().querySelectorAll('[data-agenda-tick]')).toHaveLength(2);
    expect(root().querySelector('[data-agenda-section="steps"]')).toBeNull();
    expect(lead()).toBe('Do these steps, then tap Mark as done.');
    expect(chips()).toEqual(['→Mark as done']);
    await interact(() => one<HTMLInputElement>('[data-agenda-tick="0"]').click());
    expect(spy.progress).toEqual([[0, true]]);
  });

  test('an info card: the message and one Got it', async () => {
    await draw(agendaItem('A8', { kind: 'info', subject: 'The nightly build is fixed' } as Partial<AgendaItem>));
    expect(need().getAttribute('data-agenda-need')).toBe('info');
    expect(lead()).toContain('Got it');
    expect(chips()).toEqual(['→Got it']);
  });

  test('a permission: what it does inside it, and Approve or Deny', async () => {
    await draw(
      agendaItem('A9', {
        kind: 'permission',
        ask: { kind: 'permission' },
        subject: 'Delete the old backups?',
        impact: 'Frees 40 GB; they cannot be restored',
      } as Partial<AgendaItem>),
    );
    expect(need().getAttribute('data-agenda-need')).toBe('approval');
    expect(one('[data-agenda-need-effect]').textContent).toContain('Frees 40 GB');
    expect(root().querySelector('[data-agenda-section="impact"]')).toBeNull();
    expect(lead()).toBe('Approve or deny.');
    expect(chips()).toEqual(['←Deny', '→Approve']);
  });

  test('a review: what to review inside it, Approve, and Request changes that puts the owner in the composer', async () => {
    const asked: string[] = [];
    await draw(
      agendaItem('A10', {
        kind: 'review',
        ask: { kind: 'answer-review' },
        subject: 'Is the new sign-in page right?',
        links: [{ label: 'Preview', target: 'https://example.test/preview' }],
      } as Partial<AgendaItem>),
    );
    expect(need().getAttribute('data-agenda-need')).toBe('review');
    expect(one<HTMLAnchorElement>('[data-agenda-need-review] a').href).toBe('https://example.test/preview');
    expect(root().querySelector('[data-agenda-section="links"]')).toBeNull();
    expect(lead()).toBe('Review it, then approve or request changes.');
    // With no composer to put the owner in, Request changes is not a button: the line says to type them.
    expect(chips()).toEqual(['→Approve']);
    expect(asked).toEqual([]);
  });

  test('leads with the ask itself, even where the header says it too: the question, or what is approved or done', async () => {
    const asks: readonly [Partial<AgendaItem>, string][] = [
      [
        { kind: 'choice', ask: choices('EU', 'US'), subject: 'Which region should the deploy use?' },
        'Which region should the deploy use?',
      ],
      [
        {
          kind: 'choice',
          ask: choices('EU', 'US'),
          subject: 'Pick a region',
          questions: [{ question: 'Which region should the deploy use?', options: [{ label: 'EU' }, { label: 'US' }] }],
        },
        'Which region should the deploy use?',
      ],
      [
        { kind: 'permission', ask: { kind: 'permission' }, subject: 'Delete the old backups?' },
        'Delete the old backups?',
      ],
      [
        { kind: 'task', ask: { kind: 'task' }, subject: 'Sign in to the work account', steps: ['Open it'] },
        'Sign in to the work account',
      ],
      [
        { kind: 'review', ask: { kind: 'answer-review' }, subject: 'Is the sign-in page right?' },
        'Is the sign-in page right?',
      ],
      [
        { kind: 'reply', ask: { kind: 'open-question' }, subject: 'What should the email say?' },
        'What should the email say?',
      ],
      [{ kind: 'info', subject: 'The nightly build is fixed' }, 'The nightly build is fixed'],
    ];
    for (const [patch, ask] of asks) {
      await view?.unmount();
      view = null;
      await draw(agendaItem('A20', { title: 'Short title', ...patch } as Partial<AgendaItem>));
      const first = need().children[1];
      expect(first?.hasAttribute('data-agenda-question-line')).toBe(true);
      expect(first?.textContent).toBe(ask);
      expect(need().lastElementChild?.hasAttribute('data-agenda-need-lead')).toBe(true);
    }
  });

  test('a several-question card leads with its numbered list, not a line', async () => {
    await draw(several);
    expect(need().querySelector('[data-agenda-question-line]')).toBeNull();
    expect(need().children[1]?.hasAttribute('data-agenda-wanted')).toBe(true);
  });

  test('says no instruction on an item that cannot be answered here', async () => {
    await draw(richItem, { settled: <p>Answered.</p> });
    expect(root().querySelector('[data-agenda-need]')).not.toBeNull();
    expect(root().querySelector('[data-agenda-need-lead]')).toBeNull();
  });
});

describe('Request changes, with a composer at hand', () => {
  const scope = { daemonId: 'daemon-rc' as DaemonId, sessionId: 'session-rc' };
  const review = agendaItem('A11', {
    kind: 'review',
    ask: { kind: 'answer-review' },
    subject: 'Is the new sign-in page right?',
  } as Partial<AgendaItem>);
  const composer = (draft: string) => {
    const replaced: string[] = [];
    const dispose = registerComposerQuoteTarget({
      ...scope,
      draft: () => draft,
      replaceDraft: next => replaced.push(next),
    });
    return { replaced, dispose };
  };
  const requestChanges = () =>
    interact(() =>
      must(
        root().querySelector<HTMLButtonElement>('[data-agenda-option="Request changes"]'),
        'Request changes',
      ).click(),
    );

  test('puts the owner in the composer when it is empty, and sends nothing', async () => {
    const box = composer('  ');
    const spy = await draw(review, { quoteScope: scope });
    await requestChanges();
    expect(box.replaced).toEqual(['  ']);
    expect(spy.acted).toEqual([]);
    box.dispose();
  });

  test('sends what the composer holds as the change asked for', async () => {
    const box = composer('Make the button bigger');
    const spy = await draw(review, { quoteScope: scope });
    await requestChanges();
    expect(spy.acted).toEqual([
      {
        kind: 'respond',
        label: 'Request changes',
        response: { kind: 'answer-review', verdict: 'clarify', clarification: 'Make the button bigger' },
      },
    ]);
    expect(box.replaced).toEqual([]);
    box.dispose();
  });
});

describe('an item raised before the shapes', () => {
  test('a question with steps is a mix: answered in words, its steps and impact still drawn below', async () => {
    const spy = await draw(
      agendaItem('A12', {
        kind: 'choice',
        ask: choices('Now', 'Later'),
        steps: ['Open it', 'Try it'],
        impact: 'The release waits',
      } as Partial<AgendaItem>),
    );
    expect(one('[data-agenda-need]').getAttribute('data-agenda-need')).toBe('answers');
    expect(one('[data-agenda-wanted]').textContent).toContain('Have you done the steps below?');
    expect(root().querySelectorAll('[data-agenda-section="steps"] [data-agenda-tick]')).toHaveLength(2);
    expect(one('[data-agenda-section="impact"]').textContent).toContain('The release waits');
    expect(root().querySelector('[data-agenda-quick-replies]')).toBeNull();
    await interact(() => one<HTMLInputElement>('[data-agenda-tick="1"]').click());
    expect(spy.progress).toEqual([[1, true]]);
  });
});

describe('a change to the Ferretry config', () => {
  const confirms = {
    path: 'warden.yaml',
    etag: 'a'.repeat(64),
    changes: ['the Warden may now spend on AI investigations'],
  };

  test('is drawn before the premise, and the premise is left out, when the item confirms one', async () => {
    await draw({ ...richItem, confirms } as AgendaItem);
    expect(root().querySelector('[data-agenda-confirms="warden.yaml"]')).not.toBeNull();
    expect(root().textContent).not.toContain('The board keeps every finished item');
  });

  test('is not drawn, and the premise stays, for an item that confirms nothing', async () => {
    await draw(richItem);
    expect(root().querySelector('[data-agenda-confirms]')).toBeNull();
    expect(root().textContent).toContain('The board keeps every finished item');
  });
});

describe('the Inbox’s item view', () => {
  test('names ✕ as the host asks: "Back to the chat" unless it is somewhere else', async () => {
    await draw(richItem);
    const closeLabel = (): string | null | undefined =>
      view?.container.querySelector('[data-agenda-close]')?.getAttribute('aria-label');
    expect(closeLabel()).toBe('Back to the chat');
    await view?.unmount();
    view = null;
    await draw(richItem, { closeLabel: 'Back to the Inbox' });
    expect(closeLabel()).toBe('Back to the Inbox');
  });
});

describe('a paste plan', () => {
  test('draws its form in place of the answer row, and not on a settled card', async () => {
    const notice = agendaItem('A9', {
      kind: 'permission',
      copyPlan: { planId: 'b'.repeat(32) },
    } as Partial<AgendaItem>);
    await draw(notice, { planForm: <form data-fake-plan="" /> });
    expect(one('.fy-card [data-agenda-plan-form] [data-fake-plan]')).toBeDefined();
    expect(root().querySelector('[data-agenda-quick-replies]')).toBeNull();
    await view?.unmount();

    await draw(notice, { planForm: <form data-fake-plan="" />, settled: <p>Resolved.</p> });
    expect(root().querySelector('[data-agenda-plan-form]')).toBeNull();
  });
});

describe('a question the owner replied to', () => {
  const asked = agendaItem('A163', {
    subject: 'Which database should keep the board’s finished items?',
    ask: choices('SQLite', 'Postgres'),
    questionAnswer: 'WAL is the write-ahead log: SQLite appends to it before changing the file.',
    parked: { reason: 'replied', at: '2026-08-01T11:50:00.000Z' },
  } as unknown as Partial<AgendaItem>);

  test('shows the ferret’s answer above its own options, which stay live, with no Got it', async () => {
    const spy = await draw(asked, { parkedNote: <p data-parked-note="">Replied — waiting on Zoe</p> });
    const answer = one('.fy-card [data-agenda-question-answer]');
    expect(answer.textContent).toContain('Answer to your question');
    expect(answer.textContent).toContain('WAL is the write-ahead log');
    const need = one('[data-agenda-need]');
    expect(answer.compareDocumentPosition(need) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(one('[data-parked-note]').textContent).toBe('Replied — waiting on Zoe');
    const buttons = [...root().querySelectorAll<HTMLButtonElement>('[data-agenda-quick-replies] button')];
    expect(buttons.map(button => button.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('SQLite')]),
    );
    expect(buttons.some(button => /got it/i.test(button.textContent ?? ''))).toBe(false);
    await interact(() =>
      must(
        buttons.find(button => /SQLite/.test(button.textContent ?? '')),
        'SQLite',
      ).click(),
    );
    expect(spy.acted).toHaveLength(1);
  });

  test('draws no answer block when the ferret has not answered yet', async () => {
    const { questionAnswer: _gone, ...bare } = asked as AgendaItem & { questionAnswer?: string };
    await draw(bare as AgendaItem);
    expect(root().querySelector('[data-agenda-question-answer]')).toBeNull();
  });
});

describe('a form card', () => {
  const form = agendaItem('A60', {
    kind: 'form',
    ask: { kind: 'open-question' },
    fields: [
      {
        id: '1',
        type: 'one',
        label: 'Which region?',
        name: 'Region',
        options: [{ label: 'EU', description: 'data stays in Europe' }, { label: 'US' }],
        recommended: ['EU'],
      },
      {
        id: '2',
        type: 'many',
        label: 'Which alerts?',
        name: 'Alerts',
        options: [{ label: 'Page' }, { label: 'Mail' }],
      },
      { id: '3', type: 'yesno', label: 'OK to restart?', name: 'Restart' },
      { id: '4', type: 'text', label: 'Anything else?', required: false },
    ],
  } as unknown as Partial<AgendaItem>);

  test('draws radios, checkboxes, Yes/No and a pointer to the reply box, with the recommendation already picked', async () => {
    await draw(form, { formKey: 'view-test' });
    expect(root().querySelectorAll('[data-agenda-form-field]')).toHaveLength(4);
    const radios = [...root().querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.map(radio => radio.value)).toEqual(['EU', 'US']);
    expect(radios.map(radio => radio.checked)).toEqual([true, false]);
    expect(root().querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
    expect(root().querySelectorAll('[data-agenda-form-yesno] button')).toHaveLength(2);
    expect(one('[data-agenda-form-text]').textContent).toBe('Type it below.');
    expect(root().textContent).toContain('data stays in Europe');
    expect(root().textContent).toContain('Recommended');
  });

  test('says its ask once: the header has it, the box does not repeat it', async () => {
    await draw(form, { formKey: 'view-test' });
    expect(root().querySelector('[data-agenda-question-line]')).toBeNull();
    expect(root().querySelector('[data-agenda-need="form"]')).not.toBeNull();
  });

  test('has no answer buttons to swipe, but Not needed is still there', async () => {
    await draw(form, { formKey: 'view-test' });
    expect(root().querySelector('[data-agenda-quick-replies] button')).toBeNull();
    expect(one('[data-agenda-dismiss]').textContent).toContain('Not needed');
  });

  test('picking changes the form: a radio replaces, a checkbox adds, Yes/No presses', async () => {
    await draw(form, { formKey: 'view-test-pick' });
    const [eu, us] = [...root().querySelectorAll<HTMLInputElement>('input[type="radio"]')] as [
      HTMLInputElement,
      HTMLInputElement,
    ];
    await interact(() => us.click());
    expect([eu.checked, us.checked]).toEqual([false, true]);
    const [page] = [...root().querySelectorAll<HTMLInputElement>('input[type="checkbox"]')] as [HTMLInputElement];
    await interact(() => page.click());
    expect(page.checked).toBe(true);
    const yes = must(root().querySelector<HTMLButtonElement>('[data-agenda-form-yesno] button'), 'yes');
    await interact(() => yes.click());
    expect(yes.getAttribute('aria-pressed')).toBe('true');
  });

  test('without a form key it only reads: no controls, and it says where to answer', async () => {
    await draw(form);
    expect(root().querySelector('input')).toBeNull();
    expect(root().querySelector('[data-agenda-form-yesno]')).toBeNull();
    expect(root().querySelector('[data-agenda-form-options]')).not.toBeNull();
    expect(root().textContent).toContain('Open this in the Inbox');
  });
});
