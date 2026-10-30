import { afterEach, describe, expect, test } from 'bun:test';
import type { AttentionItem } from '@ferretry/protocol';
import { agendaAnswerMessage } from '@ferretry/protocol';
import {
  AttentionItemView,
  type AttentionItemViewProps,
} from '../../../src/features/attention/attention-item-view.tsx';
import { type HistoryEvent, itemHistory } from '../../../src/lib/agenda-history.ts';
import type { InboxAction } from '../../../src/lib/attention-inbox.ts';
import type { TranscriptEntry } from '../../../src/lib/session-screens.ts';
import { attentionItem, choices } from '../../support/attention-inbox.tsx';
import { interact, type Mounted, mount, must, pressKey } from '../../support/dom.ts';
import { typeInto } from '../../support/learning-dom.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const NOW = Date.parse('2026-08-01T12:00:00.000Z');

const richItem = attentionItem('A47', {
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
} as unknown as Partial<AttentionItem>);

interface Spy {
  readonly acted: { action: InboxAction; note: string }[];
  readonly sent: string[];
  closed: number;
  replied: number;
  previous: number;
  next: number;
  progress: [number, boolean][];
}

const draw = async (
  item: AttentionItem,
  extra: Partial<AttentionItemViewProps> = {},
  history: readonly HistoryEvent[] = [],
): Promise<Spy> => {
  const spy: Spy = { acted: [], sent: [], closed: 0, replied: 0, previous: 0, next: 0, progress: [] };
  view = await mount(
    <AttentionItemView
      busy={false}
      error={null}
      ferret="Zoe"
      history={history}
      item={item}
      now={NOW}
      onAct={(action, note) => spy.acted.push({ action, note })}
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
      onReply={() => {
        spy.replied += 1;
      }}
      onSend={async text => {
        spy.sent.push(text);
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
  test('is a dialog laid over the chat, with the top, ONE scrolling body and the bar as its three parts', async () => {
    await draw(richItem);
    const section = one('section');
    expect(section.getAttribute('role')).toBe('dialog');
    expect(section.getAttribute('aria-modal')).toBe('true');
    expect(section.getAttribute('data-agenda-view')).toBe('A47');
    expect([...section.children].map(child => child.tagName)).toEqual(['HEADER', 'DIV', 'FOOTER']);
    expect(root().querySelectorAll('[data-agenda-body]')).toHaveLength(1);
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
    const table = must(body.querySelector('table[data-attention-terms]'), 'the terms table');
    expect([...table.querySelectorAll('thead th')].map(head => head.textContent)).toEqual(['Term', 'Meaning']);
    expect([...table.querySelectorAll('tbody th')].map(term => term.textContent)).toEqual(['WAL', 'ACID']);
    const history = must(body.querySelector('[data-agenda-history]'), 'the history');
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
      <AttentionItemView
        busy={false}
        error={null}
        ferret="Zoe"
        history={[]}
        item={attentionItem('A48', { ask: { kind: 'permission' } } as Partial<AttentionItem>)}
        onAct={() => undefined}
        onClose={() => undefined}
        onReply={() => undefined}
        onSend={async () => undefined}
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
    expect(spy.acted.map(entry => (entry.action as { response?: { choice?: string } }).response?.choice)).toEqual([
      'SQLite',
      'Postgres',
    ]);
    expect(spy.acted.every(entry => entry.note === '')).toBe(true);
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

  test('stay out of a field and a button, which keep their own keys', async () => {
    const spy = await draw(richItem);
    await press('ArrowRight', {}, one('[data-agenda-field]'));
    await press('Escape', {}, one('[data-agenda-field]'));
    await press('ArrowLeft', {}, one('[data-agenda-add-reply]'));
    expect(spy.acted).toEqual([]);
    expect(spy.closed).toBe(0);
  });
});

describe('the action bar', () => {
  test('sends the typed text as a reply about the item, and answers with it as the note', async () => {
    const spy = await draw(richItem);
    await typeInto(one<HTMLTextAreaElement>('[data-agenda-field]'), 'on staging first');
    await interact(() =>
      must(
        [...root().querySelectorAll<HTMLButtonElement>('[data-attention-answer]')].find(
          button => button.dataset.attentionOption === 'SQLite',
        ),
        'SQLite',
      ).click(),
    );
    expect(spy.acted[0]?.note).toBe('on staging first');
    await typeInto(one<HTMLTextAreaElement>('[data-agenda-field]'), 'and a reply');
    await interact(() => one<HTMLButtonElement>('[data-agenda-send]').click());
    expect(spy.sent).toEqual(['and a reply']);
  });

  test('"Add to reply" is the bar’s own', async () => {
    const spy = await draw(richItem);
    await interact(() => one<HTMLButtonElement>('[data-agenda-add-reply]').click());
    expect(spy.replied).toBe(1);
  });
});

describe('several questions', () => {
  const several = attentionItem('A5', {
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
  } as Partial<AttentionItem>);
  const pick = (label: string) =>
    interact(() => must(root().querySelector<HTMLButtonElement>(`[data-attention-pick="${label}"]`), label).click());
  const send = () => one<HTMLButtonElement>('[data-attention-send-answers]');

  test('collect a pick for each, then send them as ONE answer carrying the typed text', async () => {
    const spy = await draw(several);
    expect(send().disabled).toBe(true);
    await pick('Friday');
    expect(send().disabled).toBe(false);
    await pick('Kit');
    await typeInto(one<HTMLTextAreaElement>('[data-agenda-field]'), 'thanks');
    await interact(() => send().click());
    expect(spy.acted).toHaveLength(1);
    expect(spy.acted[0]?.note).toBe('thanks');
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
      <AttentionItemView
        busy
        error={null}
        ferret="Zoe"
        history={[]}
        item={several}
        onAct={(action, note) => spy.acted.push({ action, note })}
        onClose={() => undefined}
        onReply={() => undefined}
        onSend={async () => undefined}
        position={{ index: 0, total: 1 }}
        renderProse={text => text}
        swipeable={false}
      />,
    );
    await interact(() => send().click());
    expect(spy.acted).toEqual([]);
  });
});

describe('several questions without a recommendation', () => {
  test('still draw their pickers', async () => {
    await draw(
      attentionItem('A6', {
        ask: { kind: 'open-question' },
        questions: [
          { question: 'Which day should it ship?', options: [{ label: 'Monday' }] },
          { question: 'Who should announce it?', options: [{ label: 'Zoe' }] },
        ],
      } as Partial<AttentionItem>),
    );
    expect(root().querySelectorAll('[data-attention-pick]')).toHaveLength(2);
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
    await draw({ ...richItem, confirms } as AttentionItem);
    expect(root().querySelector('[data-attention-confirms="warden.yaml"]')).not.toBeNull();
    expect(root().textContent).not.toContain('The board keeps every finished item');
  });

  test('is not drawn, and the premise stays, for an item that confirms nothing', async () => {
    await draw(richItem);
    expect(root().querySelector('[data-attention-confirms]')).toBeNull();
    expect(root().textContent).toContain('The board keeps every finished item');
  });
});
