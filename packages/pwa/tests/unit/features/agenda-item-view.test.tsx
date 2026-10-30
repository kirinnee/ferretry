import { afterEach, describe, expect, test } from 'bun:test';
import type { AgendaItem } from '@ferretry/protocol';
import { agendaAnswerMessage } from '@ferretry/protocol';
import { AgendaItemView, type AgendaItemViewProps } from '../../../src/features/agenda/agenda-item-view.tsx';
import { type HistoryEvent, itemHistory } from '../../../src/lib/agenda-history.ts';
import type { InboxAction } from '../../../src/lib/agenda-inbox.ts';
import type { TranscriptEntry } from '../../../src/lib/session-screens.ts';
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
  premise: '- The board keeps every finished item\n- Reads are rare',
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

describe('the item view', () => {
  test('is a dialog laid over the message list, with the top, ONE scrolling body and the quick replies as its three parts', async () => {
    await draw(richItem);
    const section = one('section');
    expect(section.getAttribute('role')).toBe('dialog');
    expect(section.getAttribute('aria-modal')).toBe('true');
    expect(section.getAttribute('data-agenda-view')).toBe('A47');
    expect([...section.children].map(child => child.tagName)).toEqual(['HEADER', 'DIV', 'DIV']);
    expect(root().querySelectorAll('.fy-item-view__body')).toHaveLength(1);
    expect(section.lastElementChild?.hasAttribute('data-agenda-quick-replies')).toBe(true);
    expect(root().querySelector('textarea, input[type="text"]')).toBeNull();
  });

  test('puts the title, the short ask, where it stands and the pager in the sticky top', async () => {
    await draw(richItem);
    const top = one('[data-agenda-top]');
    expect(top.querySelector('[data-agenda-title]')?.textContent).toContain('Database for the board');
    expect(top.querySelector('[data-agenda-ask]')?.textContent).toContain('Which database');
    expect(top.querySelector('[data-agenda-where]')?.textContent).toBe('2 of 3');
    expect(top.querySelector('[data-agenda-body]')).toBeNull();
  });

  test('reads like a conversation: what is going on, why, decided, still open, a terms table, then history', async () => {
    const entries: TranscriptEntry[] = [
      {
        id: 'u1',
        kind: 'user',
        text: agendaAnswerMessage({ id: 'A47', quote: 'Which database' } as never, 'SQLite'),
        at: NOW - 1_000,
      } as TranscriptEntry,
    ];
    await draw(richItem, {}, itemHistory(richItem, entries));
    const body = one('[data-agenda-body]');
    const text = body.textContent ?? '';
    for (const part of [
      'The board keeps every finished item',
      'Postgres means another service',
      'Finished items are kept',
      'Which engine',
    ]) {
      expect(text).toContain(part);
    }
    const table = must(body.querySelector('table[data-agenda-terms]'), 'the terms table');
    expect([...table.querySelectorAll('thead th')].map(head => head.textContent)).toEqual(['Term', 'Meaning']);
    expect([...table.querySelectorAll('tbody th')].map(term => term.textContent)).toEqual(['WAL', 'ACID']);
    const history = must(body.querySelector('[data-agenda-history]'), 'the history');
    expect(history.querySelector('[data-agenda-history-latest]')?.textContent).toContain('SQLite');
    expect(history.querySelector('[data-agenda-history-toggle]')?.getAttribute('aria-expanded')).toBe('false');
    expect(body.lastElementChild?.contains(history)).toBe(true);
  });

  test('leaves the history out when there is none', async () => {
    await draw(richItem);
    expect(root().querySelector('[data-agenda-history]')).toBeNull();
  });

  test('hands focus to itself so the keys work, and again for another item', async () => {
    await draw(richItem);
    expect(document.activeElement).toBe(one('section'));
    one<HTMLElement>('section').blur();
    await view?.render(
      <AgendaItemView
        busy={false}
        error={null}
        ferret="Zoe"
        history={[]}
        item={agendaItem('A48', { ask: { kind: 'permission' } } as Partial<AgendaItem>)}
        onAct={() => undefined}
        onClose={() => undefined}
        position={{ index: 0, total: 1 }}
        renderProse={text => text}
        swipeable={false}
      />,
    );
    expect(document.activeElement).toBe(one('section'));
  });
});

describe('moving through the items', () => {
  test('‹ and › page, and are disabled at the ends', async () => {
    const spy = await draw(richItem);
    const previous = one<HTMLButtonElement>('[aria-label="Previous item"]');
    const next = one<HTMLButtonElement>('[aria-label="Next item"]');
    await interact(() => previous.click());
    await interact(() => next.click());
    expect([spy.previous, spy.next]).toEqual([1, 1]);
    await view?.unmount();
    await draw(richItem, { onPrevious: undefined, onNext: undefined });
    expect(one<HTMLButtonElement>('[aria-label="Previous item"]').disabled).toBe(true);
    expect(one<HTMLButtonElement>('[aria-label="Next item"]').disabled).toBe(true);
  });

  test('✕, Esc and ↓ all go back to the chat', async () => {
    const spy = await draw(richItem);
    await interact(() => one<HTMLButtonElement>('[data-agenda-close]').click());
    await press('Escape');
    await press('ArrowDown');
    expect(spy.closed).toBe(3);
  });
});

describe('the keys', () => {
  test('← and → answer with the item’s own answers, ↑ only where there is one', async () => {
    const spy = await draw(richItem);
    await press('ArrowRight');
    await press('ArrowLeft');
    await press('ArrowUp');
    expect(spy.acted.map(action => (action as { response?: { choice?: string } }).response?.choice)).toEqual([
      'SQLite',
      'Postgres',
    ]);
  });

  test('do nothing while the item is busy, with a modifier, or for a key it does not own', async () => {
    const busy = await draw(richItem, { busy: true });
    await press('ArrowRight');
    await press('Escape');
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
    await press('ArrowLeft', {}, one('[aria-label="Next item"]'));
    expect(spy.acted).toEqual([]);
    expect(spy.closed).toBe(0);
  });
});

describe('the quick replies', () => {
  test('sit under the body as chips, the recommended one tagged, and a tap answers', async () => {
    const spy = await draw(richItem);
    const chip = one<HTMLButtonElement>('[data-agenda-quick-replies] [data-agenda-option="SQLite"]');
    expect(chip.hasAttribute('data-recommended')).toBe(true);
    expect(chip.getAttribute('aria-label')).toContain('SQLite, recommended');
    await interact(() => chip.click());
    expect(spy.acted).toHaveLength(1);
    expect(spy.acted[0]).toMatchObject({ kind: 'respond', response: { choice: 'SQLite' } });
  });

  test('say an item with its ferret is being waited on', async () => {
    await draw(agendaItem('A9', { ask: { kind: 'permission' }, waitingOn: 'ferret' } as Partial<AgendaItem>));
    expect(root().textContent).toContain('With Zoe — it will update this.');
  });

  test('say what the machine refused', async () => {
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

describe('the ask', () => {
  test('a long ask is cut to one line in the top and said whole in the body', async () => {
    const long = 'Which database should keep every one of the board’s finished items for the next two years?';
    await draw(
      agendaItem('A10', { title: 'Database', subject: long, ask: { kind: 'permission' } } as Partial<AgendaItem>),
    );
    const top = one('[data-agenda-top]');
    expect(top.querySelector('[data-agenda-ask]')).not.toBeNull();
    expect(one('.fy-item-view__body').textContent).toContain(long);
  });

  test('a short ask is said once, in the top', async () => {
    await draw(
      agendaItem('A11', {
        title: 'Database',
        subject: 'Which engine?',
        ask: { kind: 'permission' },
      } as Partial<AgendaItem>),
    );
    expect(one('[data-agenda-top]').textContent).toContain('Which engine?');
    expect((one('.fy-item-view__body').textContent ?? '').split('Which engine?').length - 1).toBeLessThanOrEqual(1);
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

describe('the pull down over the head', () => {
  const pointer = (type: string, y: number, init: PointerEventInit = {}): PointerEvent =>
    new PointerEvent(type, { bubbles: true, clientX: 200, clientY: y, pointerId: 3, pointerType: 'touch', ...init });
  const pull = async (to: number, init: PointerEventInit = {}): Promise<void> => {
    const head = one<HTMLElement>('[data-agenda-top]');
    await interact(() => head.dispatchEvent(pointer('pointerdown', 100, init)));
    await interact(() => head.dispatchEvent(pointer('pointerup', to, init)));
  };

  test('a clear pull down on touch closes the view', async () => {
    const spy = await draw(richItem);
    await pull(300);
    expect(spy.closed).toBe(1);
  });

  test('a short pull, a mouse, a bar that does not swipe and a pointer it never saw close nothing', async () => {
    const spy = await draw(richItem);
    await pull(140);
    await pull(300, { pointerType: 'mouse' });
    const head = one<HTMLElement>('[data-agenda-top]');
    await interact(() => head.dispatchEvent(pointer('pointerdown', 100)));
    await interact(() => head.dispatchEvent(pointer('pointerup', 300, { pointerId: 9 })));
    await interact(() => head.dispatchEvent(pointer('pointercancel', 300)));
    await interact(() => head.dispatchEvent(pointer('pointerup', 300)));
    expect(spy.closed).toBe(0);
    await view?.unmount();
    const still = await draw(richItem, { swipeable: false });
    await pull(300);
    expect(still.closed).toBe(0);
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
