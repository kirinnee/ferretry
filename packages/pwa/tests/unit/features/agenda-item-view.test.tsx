import { afterEach, describe, expect, test } from 'bun:test';
import type { AgendaItem } from '@ferretry/protocol';
import { Markdown } from '../../../src/components/markdown.tsx';
import { AgendaItemView, type AgendaItemViewProps } from '../../../src/features/agenda/agenda-item-view.tsx';
import type { HistoryEvent } from '../../../src/lib/agenda-history.ts';
import { DISMISS_ACTION, type InboxAction } from '../../../src/lib/agenda-inbox.ts';
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

describe('the item view snooze control', () => {
  test('draws no clock when it is given nothing to snooze with', async () => {
    await draw(richItem);
    expect(root().querySelector('[data-agenda-snooze]')).toBeNull();
  });

  test('puts a clock in the head pager that snoozes, and is off while busy', async () => {
    const snoozed: string[] = [];
    await draw(richItem, { onSnooze: until => snoozed.push(until) });
    const clock = one<HTMLButtonElement>('[data-agenda-top] .fy-item-view__pager [data-agenda-snooze]');
    expect(clock.className).toBe('fy-item-view__step');
    await interact(() => clock.click());
    await interact(() => must(root().querySelector<HTMLElement>('[role="menuitem"]'), '1 hour').click());
    expect(snoozed).toEqual([new Date(NOW + 3_600_000).toISOString()]);
    await view?.unmount();
    view = null;
    await draw(richItem, { onSnooze: () => undefined, busy: true });
    expect(one<HTMLButtonElement>('[data-agenda-snooze]').disabled).toBe(true);
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
    ]);
    // The answer row is IN the card, not a strip of its own above the composer.
    expect(one('.fy-card [data-agenda-quick-replies]')).toBeDefined();
    expect(root().querySelectorAll('[data-agenda-quick-replies]')).toHaveLength(1);
  });

  test('says the title, then the item’s ask as its one-line description', async () => {
    await draw(richItem);
    expect(one('[data-agenda-title]').textContent).toBe('Database for the board');
    expect(one('.fy-item-view__head [data-agenda-ask]').textContent).toBe(
      'Which database should keep the board’s finished items?',
    );
  });

  test('falls back to the why for an old item whose title is its ask', async () => {
    await draw(agendaItem('A3', { subject: 'Ship it?', why: 'The release is due.' } as Partial<AgendaItem>));
    expect(one('[data-agenda-title]').textContent).toBe('Ship it?');
    expect(one('[data-agenda-ask]').textContent).toBe('The release is due.');
  });

  test('draws premise and context as ONE panel, labelled Premise and Context — never "Why now"', async () => {
    await draw(richItem);
    const panel = one('.fy-card [data-agenda-situation]');
    expect([...panel.querySelectorAll('h4')].map(label => label.textContent)).toEqual(['Premise', 'Context']);
    expect(panel.querySelectorAll('li')).toHaveLength(3);
    const text = root().textContent ?? '';
    expect(text).not.toMatch(/why now|what’s going on|what's going on|why it matters/iu);
  });

  test('teaches nothing: no hint line under the type, no ⋯ menu, no ⓘ', async () => {
    await draw(richItem);
    expect(one('.fy-card__top [data-agenda-type]').textContent).toBe('Decision');
    const text = root().textContent ?? '';
    expect(text).not.toContain('it is yours to decide');
    expect(text).not.toContain('⋯');
    expect(root().querySelector('[data-agenda-info], [aria-haspopup="menu"]:not([data-agenda-snooze])')).toBeNull();
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
    const chips = [...root().querySelectorAll('.fy-card .fy-qr__row > button')];
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
  test('is a small pill in the card’s top bar, never a button in the answer row', async () => {
    const spy = await draw(richItem);
    const pill = one<HTMLButtonElement>('.fy-card__top [data-agenda-dismiss]');
    expect(pill.textContent).toBe('↓Not needed');
    expect(root().querySelector('.fy-qr [data-agenda-dismiss]')).toBeNull();
    await interact(() => pill.click());
    expect(spy.acted).toEqual([DISMISS_ACTION]);
  });

  test('is the ↓ key and the ↓ swipe on the answer row; ‹ › still leave without dismissing', async () => {
    const spy = await draw(richItem);
    await press('ArrowDown');
    const row = one<HTMLElement>('[data-agenda-quick-replies]');
    const touch = (type: string, y: number): PointerEvent =>
      new PointerEvent(type, { bubbles: true, clientX: 200, clientY: y, pointerId: 5, pointerType: 'touch' });
    await interact(() => row.dispatchEvent(touch('pointerdown', 100)));
    await interact(() => row.dispatchEvent(touch('pointermove', 300)));
    await interact(() => row.dispatchEvent(touch('pointerup', 300)));
    expect(spy.acted.map(action => action.kind)).toEqual(['dismiss', 'dismiss']);
    await interact(() => one<HTMLButtonElement>('[aria-label="Next item"]').click());
    expect([spy.next, spy.acted.length]).toEqual([1, 2]);
  });

  describe('the pull down over the card’s top bar', () => {
    const pointer = (type: string, y: number, init: PointerEventInit = {}): PointerEvent =>
      new PointerEvent(type, { bubbles: true, clientX: 200, clientY: y, pointerId: 3, pointerType: 'touch', ...init });
    const pull = async (to: number, init: PointerEventInit = {}): Promise<void> => {
      const top = one<HTMLElement>('[data-agenda-card-top]');
      await interact(() => top.dispatchEvent(pointer('pointerdown', 100, init)));
      await interact(() => top.dispatchEvent(pointer('pointerup', to, init)));
    };

    test('a clear pull down on touch is Not needed', async () => {
      const spy = await draw(richItem);
      await pull(300);
      expect(spy.acted).toEqual([DISMISS_ACTION]);
      expect([spy.next, spy.closed]).toEqual([0, 0]);
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
      expect(spy.acted).toEqual([]);
      await view?.unmount();
      const still = await draw(richItem, { swipeable: false });
      await pull(300);
      expect(still.acted).toEqual([]);
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
    const chip = one<HTMLButtonElement>('.fy-card [data-agenda-quick-replies] [data-agenda-option="SQLite"]');
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

describe('several questions', () => {
  const several = agendaItem('A5', {
    title: 'Plan the launch',
    recommendation: { decision: 'Ship Monday', why: 'The team is in.' },
    ask: { kind: 'open-question' },
    questions: [
      {
        question: 'Which day should it ship?',
        options: [{ label: 'Monday' }, { label: 'Friday' }],
        recommended: 'Monday',
      },
      { question: 'Who should announce it?', options: [{ label: 'Zoe' }, { label: 'Kit' }] },
    ],
  } as Partial<AgendaItem>);
  const pick = (label: string) =>
    interact(() => must(root().querySelector<HTMLButtonElement>(`[data-agenda-pick="${label}"]`), label).click());
  const send = () => one<HTMLButtonElement>('[data-agenda-send-answers]');

  test('collect a pick for each, then send them as ONE answer', async () => {
    const spy = await draw(several);
    expect(send().disabled).toBe(true);
    await pick('Friday');
    expect(send().disabled).toBe(true);
    await pick('Kit');
    expect(send().disabled).toBe(false);
    await interact(() => send().click());
    expect(spy.acted).toHaveLength(1);
    expect(send().disabled).toBe(true);
  });

  test('picking the same answer again clears it', async () => {
    await draw(several);
    await pick('Friday');
    await pick('Friday');
    expect(send().disabled).toBe(true);
  });

  test('send nothing while busy', async () => {
    const spy = await draw(several);
    await pick('Friday');
    await view?.render(
      <AgendaItemView
        busy
        error={null}
        ferret="Zoe"
        history={[]}
        item={several}
        onAct={action => spy.acted.push(action)}
        onClose={() => undefined}
        position={{ index: 0, total: 1 }}
        renderProse={text => text}
        swipeable={false}
      />,
    );
    await interact(() => send().click());
    expect(spy.acted).toEqual([]);
  });
});

describe('several questions, drawn once each', () => {
  const asked = agendaItem('A5', {
    title: 'Plan the launch',
    ask: { kind: 'open-question' },
    questions: [
      {
        question: 'Which day should it ship?',
        options: [{ label: 'Monday' }, { label: 'Friday' }],
        recommended: 'Monday',
        why: 'The team is in.',
      },
      {
        question: 'Who should announce it?',
        options: [{ label: 'Zoe' }, { label: 'Kit' }],
        recommended: 'Zoe',
      },
    ],
  } as Partial<AgendaItem>);
  const count = (text: string, part: string): number => text.split(part).length - 1;

  test('each question and its reason appear once, with no boilerplate about the message box', async () => {
    await draw(asked);
    const text = one('.fy-item-view__body').textContent ?? '';
    expect(count(text, 'Which day should it ship?')).toBe(1);
    expect(count(text, 'Who should announce it?')).toBe(1);
    expect(count(text, 'The team is in.')).toBe(1);
    expect(text).not.toContain('message box');
    expect(root().querySelector('[data-agenda-composer-hint]')).toBeNull();
  });

  test('tags "Recommended" on the matching option of each question, and offers "All recommended"', async () => {
    const spy = await draw(asked);
    const monday = one('[data-agenda-pick="Monday"]');
    expect(monday.getAttribute('aria-label')).toBe('Monday, recommended');
    expect(one('[data-agenda-pick="Friday"]').getAttribute('aria-label')).toBe('Friday');
    await interact(() => one<HTMLButtonElement>('[data-agenda-use-recommended]').click());
    expect(one('[data-agenda-pick="Monday"]').getAttribute('aria-pressed')).toBe('true');
    expect(one('[data-agenda-pick="Zoe"]').getAttribute('aria-pressed')).toBe('true');
    await interact(() => one<HTMLButtonElement>('[data-agenda-send-answers]').click());
    expect(spy.acted).toHaveLength(1);
    expect(spy.acted[0]).toMatchObject({ kind: 'respond' });
  });

  test('offers no "All recommended" when a question has no recommendation', async () => {
    await draw(
      agendaItem('A6', {
        ask: { kind: 'open-question' },
        questions: [
          { question: 'Which day?', options: [{ label: 'Monday' }], recommended: 'Monday' },
          { question: 'Who?', options: [{ label: 'Zoe' }] },
        ],
      } as Partial<AgendaItem>),
    );
    expect(root().querySelector('[data-agenda-use-recommended]')).toBeNull();
    expect(one<HTMLButtonElement>('[data-agenda-send-answers]').disabled).toBe(true);
  });

  test('has no "Send answers" for questions that have no options: they are answered in the composer', async () => {
    await draw(
      agendaItem('A7', {
        ask: { kind: 'open-question' },
        questions: [{ question: 'Which day?' }, { question: 'Who?' }],
      } as Partial<AgendaItem>),
    );
    expect(root().querySelector('[data-agenda-send-answers]')).toBeNull();
    expect(root().querySelector('[data-agenda-quick-replies]')).toBeNull();
    const text = one('.fy-item-view__body').textContent ?? '';
    expect(count(text, 'Which day?')).toBe(1);
    expect(count(text, 'Who?')).toBe(1);
  });
});

describe('several questions without a recommendation', () => {
  test('still draw their pickers', async () => {
    await draw(
      agendaItem('A6', {
        ask: { kind: 'open-question' },
        questions: [
          { question: 'Which day should it ship?', options: [{ label: 'Monday' }] },
          { question: 'Who should announce it?', options: [{ label: 'Zoe' }] },
        ],
      } as Partial<AgendaItem>),
    );
    expect(root().querySelectorAll('[data-agenda-pick]')).toHaveLength(2);
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
