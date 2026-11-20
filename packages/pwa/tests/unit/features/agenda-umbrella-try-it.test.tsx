/**
 * THE LIVE BUG (&B165 v4): an umbrella card, &C50 "Split fyd.ts …", whose try-it an OLDER daemon (before this change) raised.
 * It rendered a "CARD &C50: YOUR ANSWER FOR THE CARD" box, "Type your answer below." AND Not good / Done buttons — three
 * asks for one thing. The item is built here exactly as that daemon sends it (the `gateAttached` mirror, with or without
 * `cardAsks`, no `generatedSubject`, a reply ask whose prompt is "Type your answer below."), and the owner must meet ONE
 * "What I need from you" with ONE answer row and none of the card's wording.
 *
 * Also pinned here, the finished item (the state said once, no ask box) and the one word list and detail agree on.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { AgendaGate, AgendaItem } from '@ferretry/protocol';
import { Markdown } from '../../../src/components/markdown.tsx';
import { AgendaItemView } from '../../../src/features/agenda/agenda-item-view.tsx';
import { AgendaSettled } from '../../../src/features/agenda/agenda-settled.tsx';
import { itemCardKind } from '../../../src/lib/card-kind.ts';
import { agendaItem } from '../../support/agenda-inbox.tsx';
import { type Mounted, mount, must } from '../../support/dom.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const TITLE = 'Split fyd.ts into modules';
const gate: AgendaGate = {
  cardId: 'C50',
  laneId: 'tested',
  laneName: 'Try it',
  entry: 7,
  projectId: 'p1',
  cardTitle: TITLE,
  options: [
    { id: 'done', label: 'Done', outcome: 'close' },
    { id: 'not-good', label: 'Not good', outcome: 'reopen-with-agenda' },
  ],
};
const STEPS = '1. Run `fy daemon status`.\n2. See every module answer.';

/** What an older daemon sent: the daemon's own agenda for the card, "Try it: <title>", the gate mirrored. */
const olderDaemon = (extra: Partial<AgendaItem> = {}): AgendaItem =>
  agendaItem('A436', {
    title: TITLE,
    subject: `Try it: ${TITLE}`,
    kind: 'reply',
    ask: { kind: 'open-question' },
    raisedBy: 'daemon',
    raisedBySession: null,
    raisedByName: null,
    source: 'task',
    sourceRef: 'card-agenda:C50',
    task: { id: 'C50' },
    gateAttached: gate,
    ...extra,
  } as unknown as Partial<AgendaItem>);

const VARIANTS: readonly (readonly [string, AgendaItem])[] = [
  ['the gate mirror alone', olderDaemon()],
  [
    'the mirror and cardAsks, no generatedSubject',
    olderDaemon({ cardAsks: [{ gate, at: '2026-08-01T11:00:00.000Z' }] } as unknown as Partial<AgendaItem>),
  ],
  [
    'the mirror, cardAsks that carry the steps',
    olderDaemon({
      cardAsks: [{ gate, at: '2026-08-01T11:00:00.000Z', howToTest: STEPS }],
    } as unknown as Partial<AgendaItem>),
  ],
];

const draw = async (item: AgendaItem, typedAnswer: boolean): Promise<HTMLElement> => {
  view = await mount(
    <AgendaItemView
      busy={false}
      error={null}
      ferret="Zoe"
      history={[]}
      howToTestFor={() => STEPS}
      item={item}
      itemKey="laptop/sess-1/A436"
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

const rows = (root: HTMLElement): readonly Element[] => [
  ...new Set(
    [...root.querySelectorAll('[data-agenda-option], [data-agenda-answer-option]')].map(
      button => button.closest('[data-agenda-quick-replies], [data-agenda-try-taps]') ?? button,
    ),
  ),
];

describe('an umbrella card’s try-it from an older daemon (&C50)', () => {
  for (const typedAnswer of [false, true]) {
    for (const [name, item] of VARIANTS) {
      test(`${name}${typedAnswer ? ', in the Inbox' : ''}: ONE block, ONE answer row, none of the card’s wording`, async () => {
        const root = await draw(item, typedAnswer);
        const text = root.textContent ?? '';
        // No "Card &C50" heading, no "your answer for the card", nothing that makes the card the one asking.
        expect(text).not.toMatch(/\bCard &C50\b/iu);
        expect(text).not.toMatch(/your answer for the card/iu);
        expect(text).not.toMatch(/card asks?\b/iu);
        // The one prompt is the buttons': "Type your answer below." never stands beside them.
        expect(rows(root).length).toBeGreaterThan(0);
        expect(text).not.toContain('Type your answer below.');
        // Exactly ONE row of answers, and exactly ONE "What I need from you".
        expect(rows(root)).toHaveLength(1);
        expect(root.querySelectorAll('[data-agenda-need]')).toHaveLength(1);
        expect(text.match(/What I need from you/gu)).toHaveLength(1);
        // The card is named once, as a plain line: never a second time as a heading.
        expect(root.querySelector('[data-agenda-card-ask-ref]')?.textContent).toBe(`For &C50 ${TITLE}`);
        expect(text.split(`&C50 ${TITLE}`).length).toBe(2);
      });
    }
  }

  test('in the Inbox the one answer is Good, with what is wrong typed in the box below — not two rows of buttons', async () => {
    const root = await draw(olderDaemon(), true);
    expect(root.querySelectorAll('[data-agenda-answer-option="Done"]')).toHaveLength(1);
    expect(root.querySelector('[data-agenda-answer-option="Not good"]')).toBeNull();
    expect(root.querySelector('[data-agenda-option="Not good"]')).toBeNull();
    // What typing does is said in the owner’s terms, never as the card moving.
    expect(root.textContent).toContain('Not good? Type what is wrong below and send.');
    expect(root.textContent).not.toContain('tries again');
    expect(root.textContent).not.toMatch(/the card (?:goes|stays)/iu);
  });

  test('outside the Inbox both answers are buttons in ONE row, Not good first', async () => {
    const root = await draw(olderDaemon(), false);
    const labels = [...root.querySelectorAll('[data-agenda-option]')].map(node =>
      node.getAttribute('data-agenda-option'),
    );
    expect(labels).toEqual(['Not good', 'Done']);
    expect(rows(root)).toHaveLength(1);
  });

  test('a daemon that wrote more than the title into the ask line keeps that line — and still shows ONE row', async () => {
    const root = await draw(
      olderDaemon({ subject: `Try it: ${TITLE}. Does every module still start?` } as never),
      false,
    );
    // The line says something the card does not, so it is the item's own question: answered in words, the try-it waits.
    expect(root.querySelector('[data-agenda-question-line]')?.textContent).toContain('Does every module still start?');
    expect(rows(root)).toHaveLength(0);
    expect(root.textContent).not.toMatch(/\bCard &C50\b|your answer for the card/iu);
    expect(root.querySelectorAll('[data-agenda-need]')).toHaveLength(1);
  });
});

describe('the word a try-it carries is the same in the list and in the open item', () => {
  test('Test in both, never Question in one and Test in the other', async () => {
    const item = olderDaemon();
    expect(itemCardKind(item).word).toBe('Test');
    const root = await draw(item, false);
    expect(root.querySelector('[data-agenda-stage]')?.textContent).toBe('Test');
  });

  test('an item that asks its own question keeps its own kind’s word in both', async () => {
    const item = agendaItem('A406', {
      subject: 'Should a capacity request wait for the owner?',
      kind: 'reply',
      ask: { kind: 'open-question' },
      gateAttached: gate,
    } as unknown as Partial<AgendaItem>);
    expect(itemCardKind(item).word).toBe('Question');
    const root = await draw(item, false);
    expect(root.querySelector('[data-agenda-stage]')?.textContent).toBe('Question');
  });
});

describe('a finished item', () => {
  const finished = (): AgendaItem =>
    olderDaemon({
      resolvedAt: '2026-08-01T11:55:00.000Z',
      resolvedBy: 'owner',
      resolution: 'answered',
      response: { kind: 'multiple-choice', choice: 'Done' },
      gateAttached: undefined,
    } as unknown as Partial<AgendaItem>);

  test('says how it ended ONCE, and has no "What I need from you" box to repeat its headline', async () => {
    const item = finished();
    view = await mount(
      <AgendaItemView
        busy={false}
        error={null}
        ferret="Zoe"
        history={[]}
        item={item}
        itemKey="laptop/sess-1/A436"
        now={Date.parse('2026-08-01T12:00:00.000Z')}
        onAct={() => undefined}
        onClose={() => undefined}
        position={{ index: 0, total: 1 }}
        renderProse={text => <Markdown text={text} />}
        settled={<AgendaSettled busy={false} error={null} ferret="Zoe" item={item} />}
        swipeable={false}
      />,
    );
    const root = must(view.container, 'the view');
    expect(root.querySelector('[data-agenda-need]')).toBeNull();
    expect(root.textContent).not.toContain('What I need from you');
    // The state is the settled line; the head draws no second "Done" chip, and no stage chip saying Done again.
    expect(root.querySelector('[data-agenda-state]')).toBeNull();
    expect(root.querySelector('[data-agenda-stage]')).toBeNull();
    expect(root.querySelectorAll('[data-agenda-settled]')).toHaveLength(1);
    expect(rows(root)).toHaveLength(0);
  });

  test('with no settled line of its own, the one chip says Done and nothing else repeats it', async () => {
    view = await mount(
      <AgendaItemView
        busy={false}
        error={null}
        ferret="Zoe"
        history={[]}
        item={finished()}
        itemKey="laptop/sess-1/A436"
        now={Date.parse('2026-08-01T12:00:00.000Z')}
        onAct={() => undefined}
        onClose={() => undefined}
        position={{ index: 0, total: 1 }}
        renderProse={text => <Markdown text={text} />}
        swipeable={false}
      />,
    );
    const root = must(view.container, 'the view');
    expect(root.querySelectorAll('[data-agenda-state]')).toHaveLength(1);
    expect(root.querySelector('[data-agenda-state]')?.textContent).toBe('Done');
    expect(root.querySelector('[data-agenda-stage]')).toBeNull();
    expect(root.querySelector('[data-agenda-need]')).toBeNull();
  });
});
