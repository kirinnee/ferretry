/**
 * ONE ANSWER ROW, WHATEVER THE ITEM (&B165; docs/agenda.md § One model: the agenda asks, the card shows). The owner said
 * "cards have no actions" eight times while each fix patched one screen; every kind of item is drawn here with one card
 * ask and with two, and each must show exactly ONE row of answer buttons, no "Card &F…" heading and no words that make
 * the card the one asking. A new kind, or a new path that draws a second row, fails here.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { type AgendaGate, type AgendaItem, ownAskDigest } from '@ferretry/protocol';
import { Markdown } from '../../../src/components/markdown.tsx';
import { AgendaCard } from '../../../src/features/agenda/agenda-card.tsx';
import { AgendaCardsList } from '../../../src/features/agenda/agenda-cards-list.tsx';
import { AgendaItemView } from '../../../src/features/agenda/agenda-item-view.tsx';
import { kindWord } from '../../../src/lib/agenda-answers.ts';
import type { InboxAction } from '../../../src/lib/agenda-inbox.ts';
import type { HistoryEvent } from '../../../src/lib/agenda-history.ts';
import {
  itemAskPlan,
  itemAskWord,
  itemCardAsks,
  itemSwipeTargets,
  typedCardAsk,
} from '../../../src/lib/agenda-item-sections.ts';
import { agendaItem, choices } from '../../support/agenda-inbox.tsx';
import { type Mounted, mount, must } from '../../support/dom.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const tryIt = (cardId: string, title: string): AgendaGate => ({
  cardId,
  laneId: 'released',
  laneName: 'Released',
  entry: 4,
  projectId: 'p1',
  cardTitle: title,
  options: [
    { id: 'done', label: 'Done', outcome: 'close' },
    { id: 'not-good', label: 'Not good', outcome: 'reopen-with-agenda' },
  ],
});
const first = tryIt('F12', 'Badge colour');
const second = tryIt('F13', 'Badge shape');

/**
 * Who the item's ONE ask is. `card`: the item asks nothing of its own, or closes itself (a to-do, an info), so its card ask is
 * the answer row. `own-row`: it asks its own question on buttons (a choice, a permission, a review): those are the one row,
 * and the card ask waits as "Next". `own-words`: it asks in words (a reply, a form): typed words answer it, there is no row,
 * and the card ask waits as "Next" — a try-it's Done / Not good is never squeezed in beside a ferret's question (&B165).
 */
type OneAsk = 'card' | 'own-row' | 'own-words';

/** Every kind of item an agenda holds, as the owner meets it. */
const KINDS: readonly (readonly [string, Partial<AgendaItem>, OneAsk])[] = [
  ['a choice', { kind: 'choice', subject: 'Which colour?', ask: choices('Blue', 'Green') }, 'own-row'],
  ['a yes or no', { kind: 'yesno', subject: 'Ship it?', ask: choices('No', 'Yes') }, 'own-row'],
  ['a permission', { kind: 'permission', subject: 'May I deploy?', ask: { kind: 'permission' } }, 'own-row'],
  ['a review', { kind: 'review', subject: 'Is the migration safe?' }, 'own-row'],
  ['a reply, one question', { kind: 'reply', subject: 'Which shade?', ask: { kind: 'open-question' } }, 'own-words'],
  [
    'a reply, several questions',
    {
      kind: 'reply',
      subject: 'Three things',
      ask: { kind: 'open-question' },
      questions: [{ question: 'One?' }, { question: 'Two?' }, { question: 'Three?' }],
    },
    'own-words',
  ],
  ['a to-do', { kind: 'task', subject: 'Rotate the key', ask: { kind: 'task' } }, 'card'],
  [
    'a form whose subject repeats the card',
    {
      kind: 'form',
      subject: 'Badge colour',
      ask: { kind: 'open-question' },
      fields: [{ id: 'shade', type: 'text', label: 'Which shade?' }],
    },
    'own-words',
  ],
  ['an info', { kind: 'info', subject: 'The build is green' }, 'card'],
  [
    'the agenda the daemon opened for the card',
    {
      kind: 'reply',
      subject: 'Try it: Badge colour',
      ask: { kind: 'open-question' },
      raisedBy: 'daemon',
      source: 'task',
      sourceRef: 'card-agenda:F12',
      task: { id: 'F12' },
    },
    'card',
  ],
  [
    'a daemon try-it whose ask line is the first step',
    { kind: 'reply', subject: 'Try it: Open the badge.', ask: { kind: 'open-question' } },
    'card',
  ],
] as const;

const draw = async (
  item: AgendaItem,
  typedAnswer: boolean,
  history: readonly HistoryEvent[] = [],
): Promise<HTMLElement> => {
  view = await mount(
    <AgendaItemView
      busy={false}
      error={null}
      ferret="Zoe"
      history={history}
      howToTestFor={() => '1. Open the badge.\n2. See it is blue.'}
      item={item}
      itemKey={`laptop/sess-1/${item.id}`}
      now={Date.parse('2026-08-01T12:00:00.000Z')}
      onAct={() => undefined}
      onClose={() => undefined}
      position={{ index: 0, total: 1 }}
      renderProse={text => <Markdown text={text} />}
      swipeable={false}
      {...(typedAnswer ? { typedAnswer } : {})}
    />,
  );
  return must(view.container, 'the view');
};

/** Every button that answers (the offer's words included, which must never become one): Done, Good, Not good or Blue. */
const answerButtons = (root: HTMLElement, label: string): readonly Element[] =>
  [...root.querySelectorAll('button')].filter(
    button =>
      (button.textContent ?? '').replace(/[←→↑↓]/gu, '').trim() === label || button.getAttribute('title') === label,
  );

/** The rows of answer buttons drawn anywhere in the view, its dock included: each a row holding at least one answer. */
const answerRows = (root: HTMLElement): readonly Element[] => {
  const buttons = [...root.querySelectorAll('[data-agenda-option], [data-agenda-answer-option]')];
  return [
    ...new Set(buttons.map(button => button.closest('[data-agenda-quick-replies], [data-agenda-try-taps]') ?? button)),
  ];
};

describe('every kind of item shows ONE answer row, however many card asks it carries', () => {
  for (const typedAnswer of [false, true]) {
    for (const [name, fields, one] of KINDS) {
      for (const asks of [[first], [first, second]]) {
        test(`${name}, ${asks.length === 1 ? 'one card ask' : 'two card asks'}${typedAnswer ? ', in the Inbox' : ''}`, async () => {
          const root = await draw(
            agendaItem('A9', {
              title: 'Badge colour',
              ...fields,
              gateAttached: asks[0],
              cardAsks: asks.map(gate => ({ gate, at: '2026-08-01T11:00:00.000Z' })),
            } as unknown as Partial<AgendaItem>),
            typedAnswer,
          );
          // ONE row at most, and it is the item's one ask: the card ask's, or the item's own question's — never both.
          expect(answerRows(root)).toHaveLength(one === 'own-words' ? 0 : 1);
          expect(root.querySelectorAll('[data-agenda-card-ask]')).toHaveLength(one === 'card' ? 1 : 0);
          if (one !== 'card') {
            // A question of its own is never answered Done / Good / Not good: the try-it waits, named on one line.
            for (const label of ['Done', 'Good', 'Not good']) expect(answerButtons(root, label)).toHaveLength(0);
            expect(root.querySelector('[data-agenda-card-ask-later]')).not.toBeNull();
          }
          expect(root.textContent).not.toMatch(/your answer for the card|card asks?\b|\bCard &F\d+\s*:/iu);
          // Each card is named at most once as the one this is about, never as the one asking.
          for (const gate of asks) {
            expect(root.textContent?.split(`&${gate.cardId} ${gate.cardTitle}`).length ?? 0).toBeLessThanOrEqual(2);
          }
          // No "type your answer" line beside buttons a card ask drew, or beside the item's own row.
          if (root.querySelector('[data-agenda-card-ask]') !== null || one === 'own-row') {
            expect(root.textContent).not.toContain('Type your answer below.');
          }
        });
      }
    }
  }
});

const carrying = (fields: Partial<AgendaItem>, asks: readonly AgendaGate[] = [first]): AgendaItem =>
  agendaItem('A9', {
    title: 'Badge colour',
    ...fields,
    gateAttached: asks[0],
    cardAsks: asks.map(gate => ({ gate, at: '2026-08-01T11:00:00.000Z' })),
  } as unknown as Partial<AgendaItem>);

describe('the one answer row holds after the owner wrote a reply (&B155: nothing is shown back about the words)', () => {
  const said: readonly HistoryEvent[] = [
    { kind: 'owner', key: 'o1', at: Date.parse('2026-08-01T11:30:00.000Z'), text: 'works now' },
  ];
  for (const typedAnswer of [false, true]) {
    for (const [name, fields, one] of KINDS) {
      test(`${name}${typedAnswer ? ', in the Inbox' : ''}: no prompt about the words, and the same one row`, async () => {
        const root = await draw(carrying(fields), typedAnswer, said);
        expect(answerRows(root)).toHaveLength(one === 'own-words' ? 0 : 1);
        expect(answerButtons(root, 'Done').length + answerButtons(root, 'Good').length).toBe(one === 'card' ? 1 : 0);
        expect(root.querySelector('[data-agenda-reply-offer]')).toBeNull();
        expect(root.textContent).not.toMatch(/If that is your answer/u);
      });
    }
  }
});

describe('typed words answer a card ask only when it is the item’s whole ask', () => {
  test('several questions whose subject repeats the card keep the composer for the ferret', () => {
    const item = carrying({
      kind: 'reply',
      subject: 'Badge colour',
      ask: { kind: 'open-question' },
      questions: [{ question: 'Which shade?' }, { question: 'Should keyboard focus change?' }],
    });
    expect(typedCardAsk(item)).toBeUndefined();
  });

  test('a form keeps its own sender', () => {
    const item = carrying({
      kind: 'form',
      subject: 'Badge colour',
      ask: { kind: 'open-question' },
      fields: [{ id: 'shade', type: 'text', label: 'Which shade?' }],
    } as unknown as Partial<AgendaItem>);
    expect(typedCardAsk(item)).toBeUndefined();
  });

  test('the agenda the daemon opened for the card hands its composer to the card ask', () => {
    const item = carrying({
      kind: 'reply',
      subject: 'Try it: Badge colour',
      ask: { kind: 'open-question' },
      raisedBy: 'daemon',
      source: 'task',
      sourceRef: 'card-agenda:F12',
      task: { id: 'F12' },
    } as unknown as Partial<AgendaItem>);
    expect(typedCardAsk(item)?.gate.cardId).toBe('F12');
  });
});

describe('an item with buttons of its own asks its card ask first', () => {
  test('a to-do shows the card ask it cannot be done without, and holds its own Done', async () => {
    const root = await draw(carrying({ kind: 'task', subject: 'Rotate the key', ask: { kind: 'task' } }), false);
    expect(root.querySelector('[data-agenda-card-ask="gate:F12:released:4"]')).not.toBeNull();
    expect(root.querySelector('[data-agenda-own-row-held]')).not.toBeNull();
    expect(answerButtons(root, 'Done')).toHaveLength(1);
    expect(answerButtons(root, 'Done')[0]?.closest('[data-agenda-card-ask]')).not.toBeNull();
  });

  test('a second card ask is named as next, never drawn as a row of its own', async () => {
    const root = await draw(
      carrying({ kind: 'task', subject: 'Rotate the key', ask: { kind: 'task' } }, [first, second]),
      false,
    );
    expect(root.querySelectorAll('[data-agenda-card-ask]')).toHaveLength(1);
    expect(root.querySelector('[data-agenda-card-ask-later="gate:F13:released:4"]')).not.toBeNull();
  });
});

describe('an item that asks a question of its own answers THAT question (&B165 finding 1)', () => {
  test('a ferret’s question keeps its reply box; the try-it on the same card is one "Next" line, never a second ask', async () => {
    const root = await draw(
      carrying({
        kind: 'reply',
        subject: 'Should a capacity request wait for the owner?',
        ask: { kind: 'open-question' },
      }),
      false,
    );
    expect(answerRows(root)).toHaveLength(0);
    expect(root.querySelector('[data-agenda-card-ask]')).toBeNull();
    expect(root.textContent).toContain('Type your answer below.');
    for (const label of ['Done', 'Good', 'Not good']) expect(answerButtons(root, label)).toHaveLength(0);
    expect(root.querySelector('[data-agenda-card-ask-later="gate:F12:released:4"]')?.textContent).toContain(
      '&F12 Badge colour',
    );
    // One "What I need from you", and the question said ONCE.
    expect(root.querySelectorAll('[data-agenda-need]')).toHaveLength(1);
    expect(root.textContent?.split('Should a capacity request wait for the owner?').length).toBeLessThanOrEqual(3);
  });

  test('a choice keeps its own buttons; the try-it waits behind them', async () => {
    const root = await draw(
      carrying({ kind: 'choice', subject: 'Which colour?', ask: choices('Blue', 'Green') }, [first, second]),
      false,
    );
    expect(answerRows(root)).toHaveLength(1);
    expect(answerButtons(root, 'Blue')).toHaveLength(1);
    expect(root.querySelectorAll('[data-agenda-card-ask]')).toHaveLength(0);
    expect(root.querySelector('[data-agenda-card-ask-later="gate:F12:released:4"]')).not.toBeNull();
    expect(root.querySelector('[data-agenda-card-ask-later="gate:F13:released:4"]')).not.toBeNull();
  });
});

describe('every swipe surface answers the same ask', () => {
  test('a card-owned agenda swipes to its card ask, marked for that ask', () => {
    const targets = itemSwipeTargets(
      carrying({
        kind: 'reply',
        subject: 'Try it: Badge colour',
        ask: { kind: 'open-question' },
        raisedBy: 'daemon',
        source: 'task',
        sourceRef: 'card-agenda:F12',
        task: { id: 'F12' },
      } as unknown as Partial<AgendaItem>),
    );
    const actions = Object.values(targets).flatMap(target => (target?.action == null ? [] : [target.action]));
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) expect(action).toEqual(expect.objectContaining({ gate: true }));
  });

  test('an item with no card ask swipes to its own answers', () => {
    const targets = itemSwipeTargets(
      agendaItem('A9', { kind: 'choice', subject: 'Which?', ask: choices('Blue', 'Green') }),
    );
    const actions = Object.values(targets).flatMap(target => (target?.action == null ? [] : [target.action]));
    for (const action of actions) expect(action).not.toEqual(expect.objectContaining({ gate: true }));
  });
});

/** The agenda the daemon opened for F12, as it stores it: the subject it wrote kept beside it (`generatedSubject`). */
const daemonsOwn: Partial<AgendaItem> = {
  kind: 'reply',
  subject: 'Try it: Badge colour',
  generatedSubject: 'Try it: Badge colour',
  ask: { kind: 'open-question' },
  raisedBy: 'daemon',
  source: 'task',
  sourceRef: 'card-agenda:F12',
  task: { id: 'F12' },
} as unknown as Partial<AgendaItem>;

/** `count` edits of the context alone, as the daemon keeps them: the newest few, a subject rewrite long gone. */
const contextEdits = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    at: `2026-08-01T12:${String(index).padStart(2, '0')}:00.000Z`,
    by: 'agent' as const,
    changed: ['context' as const],
    previous: { context: `round ${String(index)}` },
  }));

describe('a question a ferret puts on the daemon’s agenda is the item’s own', () => {
  test('the daemon’s own line is said once, by the ask', () => {
    expect(itemAskPlan(carrying(daemonsOwn), [...itemCardAsks(carrying(daemonsOwn))]).ownLine).toBe(false);
    expect(typedCardAsk(carrying(daemonsOwn))?.gate.cardId).toBe('F12');
  });

  test('a subject a ferret rewrote stays on screen, and typed words answer the ferret, not the card', async () => {
    const item = carrying({
      ...daemonsOwn,
      subject: 'Should the badge also change keyboard focus?',
    } as unknown as Partial<AgendaItem>);
    expect(typedCardAsk(item)).toBeUndefined();
    const root = await draw(item, true);
    expect(root.querySelector('[data-agenda-question-line]')?.textContent).toContain('keyboard focus');
  });

  test('a rewrite stays the ferret’s after ten more edits pushed it out of the revisions', () => {
    const item = carrying({
      ...daemonsOwn,
      subject: 'Should the badge also change keyboard focus?',
      revisions: contextEdits(10),
    } as unknown as Partial<AgendaItem>);
    expect(itemAskPlan(item, itemCardAsks(item)).ownLine).toBe(true);
    expect(typedCardAsk(item)).toBeUndefined();
  });

  test('an agenda from before the daemon kept its subject is read by its words', () => {
    const { generatedSubject: _generated, ...legacy } = daemonsOwn as Partial<AgendaItem> & {
      generatedSubject?: string;
    };
    expect(itemAskPlan(carrying(legacy), [...itemCardAsks(carrying(legacy))]).ownLine).toBe(false);
    const rewritten = carrying({ ...legacy, subject: 'Should the badge also change keyboard focus?' });
    expect(itemAskPlan(rewritten, itemCardAsks(rewritten)).ownLine).toBe(true);
    expect(typedCardAsk(rewritten)).toBeUndefined();
  });
});

const plan = (cardId: string, title: string): AgendaGate => ({
  cardId,
  laneId: 'plan',
  laneName: 'Plan',
  entry: 1,
  projectId: 'p1',
  cardTitle: title,
  options: [{ id: 'ok', label: 'OK to build', outcome: 'next' }],
});

describe('Not yet on one approval leaves the next reachable', () => {
  test('the ask the owner deferred waits behind the one still waiting', () => {
    const [f12, f13] = [plan('F12', 'Badge colour'), plan('F13', 'Badge shape')];
    const item = agendaItem('A9', {
      kind: 'reply',
      subject: 'Two plans',
      generatedSubject: 'Two plans',
      raisedBy: 'daemon',
      source: 'task',
      sourceRef: 'card-agenda:F12',
      ask: { kind: 'open-question' },
      cardAsks: [
        { gate: f12, at: '2026-08-01T11:00:00.000Z', notYet: { at: '2026-08-01T11:30:00.000Z' } },
        { gate: f13, at: '2026-08-01T11:00:00.000Z' },
      ],
    } as unknown as Partial<AgendaItem>);
    const asked = itemAskPlan(item, itemCardAsks(item));
    expect(asked.asks.map(ask => ask.gate.cardId)).toEqual(['F13']);
    expect(asked.later.map(ask => ask.gate.cardId)).toEqual(['F12']);
  });
});

describe('a refused answer is said beside the one ask', () => {
  test('a choice carrying a card ask shows why the try-it answer did not land', async () => {
    view = await mount(
      <AgendaItemView
        busy={false}
        error="card moved on"
        ferret="Zoe"
        history={[]}
        item={carrying({ kind: 'choice', subject: 'Which colour?', ask: choices('Blue', 'Green') })}
        itemKey="laptop/sess-1/A9"
        now={Date.parse('2026-08-01T12:00:00.000Z')}
        onAct={() => undefined}
        onClose={() => undefined}
        position={{ index: 0, total: 1 }}
        renderProse={text => <Markdown text={text} />}
        swipeable={false}
      />,
    );
    // The item asks its own question, so the answer row is its own and the error is said beside THAT: once.
    expect(view.container.querySelector('[data-agenda-card-ask]')).toBeNull();
    expect(view.container.textContent?.split('card moved on').length).toBe(2);
  });
});

describe('the compact card answers the same ask', () => {
  test('a choice carrying a try-it shows its own Blue / Green; a to-do shows the try-it’s answers, each marked for it', async () => {
    const acted: InboxAction[] = [];
    view = await mount(
      <AgendaCard
        item={carrying({ kind: 'choice', subject: 'Which colour?', ask: choices('Blue', 'Green') })}
        onAct={action => acted.push(action)}
      />,
    );
    let root = must(view.container, 'the card');
    expect(root.querySelector('[data-agenda-option="Blue"]')).not.toBeNull();
    expect(root.querySelector('[data-agenda-option="Done"]')).toBeNull();
    await view.unmount();
    view = await mount(
      <AgendaCard
        item={carrying({ kind: 'task', subject: 'Rotate the key', ask: { kind: 'task' } })}
        onAct={action => acted.push(action)}
      />,
    );
    root = must(view.container, 'the card');
    expect(root.querySelector('[data-agenda-card-ask-ref]')?.textContent).toContain('&F12');
    expect(root.querySelector('[data-agenda-own-row-held]')).not.toBeNull();
    const done = must(root.querySelector<HTMLElement>('[data-agenda-option="Done"]'), 'Done');
    done.click();
    expect(acted).toEqual([
      expect.objectContaining({ kind: 'respond', label: 'Done', gate: true, cardAsk: 'gate:F12:released:4' }),
    ]);
    expect(root.textContent).not.toMatch(/card asks?\b|your answer for the card|\bCard &F\d+\s*:/iu);
  });
});

describe('only a provably generated ask line is said once by the card ask', () => {
  const quoting =
    (steps: string): ((id: string) => string) =>
    () =>
      steps;

  test('a ferret’s question that a step quotes stays the item’s own, and typed words answer the ferret', () => {
    const item = carrying({ kind: 'reply', subject: 'Can I remove the old badge?', ask: { kind: 'open-question' } });
    const steps = quoting('1. Open Settings.\n2. Confirm the dialog reads "Can I remove the old badge?"');
    expect(itemAskPlan(item, itemCardAsks(item, steps)).ownLine).toBe(true);
    expect(typedCardAsk(item, steps)).toBeUndefined();
  });

  test('a reply with steps to say were done keeps its composer', () => {
    const item = carrying({
      kind: 'reply',
      subject: 'Try it: Badge colour',
      ask: { kind: 'open-question' },
      steps: ['Restart the daemon'],
    } as unknown as Partial<AgendaItem>);
    expect(typedCardAsk(item)).toBeUndefined();
  });

  test('the daemon’s “Try it: <first step>” line, even cut at its first sentence, is said once', () => {
    const item = carrying({ kind: 'reply', subject: 'Try it: Open the badge.', ask: { kind: 'open-question' } });
    const steps = quoting('1. Open the badge. Then wait a second.\n2. See it is blue.');
    expect(itemAskPlan(item, itemCardAsks(item, steps)).ownLine).toBe(false);
    expect(typedCardAsk(item, steps)?.gate.cardId).toBe('F12');
  });

  test('“Try it:” followed by anything else is the item’s own', () => {
    const item = carrying({
      kind: 'reply',
      subject: 'Try it: and tell me if the shade is right',
      ask: { kind: 'open-question' },
    });
    expect(itemAskPlan(item, itemCardAsks(item, quoting('1. Open the badge.'))).ownLine).toBe(true);
  });
});

describe('a notice about several cards answers as one form', () => {
  const cards = [
    { task: { id: 'B1' }, line: '&B1 Fix the badge is waiting in Review/CI, but no ferret is assigned.' },
    { task: { id: 'B2' }, line: '&B2 Tidy the docs is waiting in Implement, but no ferret is assigned.' },
  ] as const;
  const actions = {
    cardPath: (id: string) => `/board/${id}`,
    chatPath: (id: string) => `/session/${id}`,
    open: () => undefined,
    openChat: () => undefined,
    start: async () => ({ ok: true as const, note: 'Started.' }),
    close: async () => ({ ok: true as const, note: 'Closed.' }),
  };

  for (const surface of ['the item view', 'the compact card'] as const) {
    test(`${surface}: ONE answer row (the form's Send), no per-card buttons and no second Got it`, async () => {
      const item = agendaItem('A9', {
        kind: 'info',
        notice: true,
        subject: 'These cards are waiting',
        cards,
      } as unknown as Partial<AgendaItem>);
      const form = <AgendaCardsList actions={actions as never} cards={cards as never} />;
      view = await mount(
        surface === 'the item view' ? (
          <AgendaItemView
            busy={false}
            cardsForm={form}
            error={null}
            ferret="Zoe"
            history={[]}
            item={item}
            itemKey="laptop/sess-1/A9"
            now={Date.parse('2026-08-01T12:00:00.000Z')}
            onAct={() => undefined}
            onClose={() => undefined}
            position={{ index: 0, total: 1 }}
            renderProse={text => <Markdown text={text} />}
            swipeable={false}
          />
        ) : (
          <AgendaCard cardsForm={form} item={item} onAct={() => undefined} />
        ),
      );
      const root = must(view.container, 'the view');
      expect(answerRows(root)).toHaveLength(1);
      expect(root.querySelector('[data-agenda-clear]')).toBeNull();
      expect(root.querySelectorAll('[data-agenda-cards-send]')).toHaveLength(1);
      expect(root.querySelectorAll('[data-agenda-card-row] button')).toHaveLength(0);
    });
  }
});

describe('a notice about cards swipes to nothing: its one form is the answer', () => {
  test('no swipe or key answers Got it past the picks', () => {
    const item = agendaItem('A9', {
      kind: 'info',
      notice: true,
      subject: 'These cards are waiting',
      cards: [{ task: { id: 'B1' }, line: '&B1 is waiting.' }],
    } as unknown as Partial<AgendaItem>);
    expect(itemSwipeTargets(item)).toEqual({});
  });
});

describe('a card agenda from before the daemon recorded its own subject', () => {
  test('a question added after the “Try it:” opening stays the item’s own: typed words answer the ferret', () => {
    const item = carrying({
      ...daemonsOwn,
      subject: 'Try it: Badge colour. Should keyboard focus change too?',
    } as unknown as Partial<AgendaItem>);
    expect(itemAskPlan(item, itemCardAsks(item)).ownLine).toBe(true);
    expect(typedCardAsk(item)).toBeUndefined();
  });

  test('its own line, the lane’s words and the card title, is still said once by the ask', () => {
    const item = carrying(daemonsOwn);
    expect(itemAskPlan(item, itemCardAsks(item)).ownLine).toBe(false);
  });
});

describe('the item’s own question answered: its try-it takes over as the item’s ask, in the same item (&B165 review)', () => {
  const asked: Partial<AgendaItem> = {
    kind: 'reply',
    subject: 'Should a capacity request wait for the owner?',
    ask: { kind: 'open-question' },
  } as unknown as Partial<AgendaItem>;
  /** The same thread once the owner replied to its question: the digest the daemon stored at that moment. */
  const repliedTo = (fields: Partial<AgendaItem>): AgendaItem => {
    const open = carrying(fields);
    return { ...open, ownAskRepliedTo: ownAskDigest(open) } as AgendaItem;
  };

  test('open: the question is the one ask and the try-it waits as one "Next" line', async () => {
    const item = carrying(asked);
    expect(itemAskPlan(item, itemCardAsks(item))).toMatchObject({ ownFirst: true, ownAnswered: false, asks: [] });
    const root = await draw(item, false);
    expect(root.textContent).toContain('Type your answer below.');
    expect(root.querySelector('[data-agenda-card-ask-later]')).not.toBeNull();
    for (const label of ['Done', 'Good', 'Not good']) expect(answerButtons(root, label)).toHaveLength(0);
  });

  test('answered in words: the try-it is the ask — its buttons, no old question, no "Next" line', async () => {
    const item = repliedTo(asked);
    const plan = itemAskPlan(item, itemCardAsks(item));
    expect(plan).toMatchObject({ ownFirst: false, ownAnswered: true, ownLine: false });
    expect(plan.asks.map(ask => ask.gate.cardId)).toEqual(['F12']);
    const root = await draw(item, false);
    expect(root.querySelector('[data-agenda-card-ask="gate:F12:released:4"]')).not.toBeNull();
    expect(answerButtons(root, 'Done')).toHaveLength(1);
    expect(answerButtons(root, 'Not good')).toHaveLength(1);
    expect(root.querySelector('[data-agenda-card-ask-later]')).toBeNull();
    expect(root.textContent).not.toContain('Should a capacity request wait for the owner?');
    expect(root.textContent).not.toContain('Type your answer below.');
    // Still ONE answer row and one "What I need from you".
    expect(answerRows(root)).toHaveLength(1);
    expect(root.querySelectorAll('[data-agenda-need]')).toHaveLength(1);
  });

  test('answered, in the Inbox: Good is one tap and the words typed below are Not good', async () => {
    const item = repliedTo(asked);
    const root = await draw(item, true);
    expect(answerButtons(root, 'Good')).toHaveLength(1);
    expect(root.querySelector('[data-agenda-typed-lead]')).not.toBeNull();
    expect(typedCardAsk(item)?.gate.cardId).toBe('F12');
  });

  test('a permission the owner already approved, whose card reached its try-it later: Good / Not good, never the old Yes', async () => {
    const item = carrying({
      kind: 'permission',
      subject: 'May I deploy?',
      ask: { kind: 'permission' },
      ownerAnswer: {
        at: '2026-08-01T11:30:00.000Z',
        response: { kind: 'permission', decision: 'approve' },
        request: 1,
      },
    } as unknown as Partial<AgendaItem>);
    const plan = itemAskPlan(item, itemCardAsks(item));
    expect(plan).toMatchObject({ ownFirst: false, ownAnswered: true });
    const root = await draw(item, false);
    expect(root.querySelector('[data-agenda-card-ask="gate:F12:released:4"]')).not.toBeNull();
    expect(answerButtons(root, 'Done')).toHaveLength(1);
    expect(answerButtons(root, 'Not good')).toHaveLength(1);
    expect(answerButtons(root, 'Approve')).toHaveLength(0);
    expect(root.textContent).not.toContain('May I deploy?');
    expect(answerRows(root)).toHaveLength(1);
  });

  test('the list and the open item say the same word: a Test once the try-it is the ask, a Question before', () => {
    const open = carrying(asked);
    const answered = repliedTo(asked);
    expect(itemAskWord(open)).toBeUndefined();
    expect(itemAskWord(answered)).toBe('Test');
  });

  test('a reply that changed after the owner answered is a new question: the old answer does not answer it', () => {
    const stale = { ...repliedTo(asked), subject: 'Should it also wait for a second owner?' } as AgendaItem;
    expect(itemAskPlan(stale, itemCardAsks(stale))).toMatchObject({ ownFirst: true, ownAnswered: false });
  });
});

/** The steps the daemon stores on the ask it puts on an item: the list row reads them there, with no board in hand. */
const HOW_TO_TEST = '1. Open the badge.\n2. See it is blue.';

describe('the Inbox list and the open item say the same word for every kind (&B165 screenshot finding 7)', () => {
  for (const [name, fields] of KINDS) {
    for (const asks of [[], [first]] as const) {
      test(`${name}${asks.length === 0 ? '' : ', with a try-it'}`, async () => {
        const item = agendaItem('A9', {
          title: 'Badge colour',
          ...fields,
          ...(asks.length === 0
            ? {}
            : {
                gateAttached: asks[0],
                cardAsks: asks.map(gate => ({ gate, at: '2026-08-01T11:00:00.000Z', howToTest: HOW_TO_TEST })),
              }),
        } as unknown as Partial<AgendaItem>);
        const root = await draw(item, false);
        const chip = root.querySelector('[data-agenda-type]')?.textContent;
        // The list row's word: a card to try is a Test, anything else its kind's own word.
        expect(chip).toBe(itemAskWord(item) ?? kindWord(item));
      });
    }
  }
});
