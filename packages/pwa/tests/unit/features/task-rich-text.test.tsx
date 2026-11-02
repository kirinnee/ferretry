import { afterEach, describe, expect, it } from 'bun:test';
import { type ToTestAnswers, ToTestList } from '../../../src/features/agenda/to-test-rows.tsx';
import { BoardCard } from '../../../src/features/board/board-card.tsx';
import { TableView } from '../../../src/features/board/board-table.tsx';
import type { BoardCardEnv } from '../../../src/features/board/board-views.tsx';
import { BoardDetail } from '../../../src/features/board/detail/board-detail.tsx';
import { ferretNamer } from '../../../src/lib/board-present.ts';
import { cardPlaces } from '../../../src/lib/board-view.ts';
import type { ToTestCard } from '../../../src/lib/to-test-inbox.ts';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';
import { boardModelOf, card, flush } from '../board-support.ts';
import { detailProps } from './board-detail-support.tsx';

/** The shape the owner screenshotted: a label directly above a numbered list that starts at 4, with no blank line. */
const LABEL_THEN_LIST = '2FA codes\n4. Run `fy auth --totp` → **6 digits**\n5. Enter it';
const HOW_TO_TEST =
  '## Setup\n1. Open Settings › Devices\n2. Run `fy pair` → code shown\n\n2FA codes\n4. Run `fy auth --totp` → **6 digits**\n5. Enter it';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

/** The label and the list are two nodes: a paragraph that says only the label, then an `<ol>` that starts at 4. */
const expectSeparate = (root: ParentNode): void => {
  const list = must(root.querySelector('ol[start="4"]'), 'the list that starts at 4');
  expect(list.querySelectorAll('li')).toHaveLength(2);
  expect(list.querySelector('li code')?.textContent).toBe('fy auth --totp');
  expect(list.querySelector('li strong')?.textContent).toBe('6 digits');
  expect(list.textContent).toContain('→');
  const label = must(list.previousElementSibling, 'the label above the list');
  expect(label.tagName).toBe('P');
  expect(label.textContent?.trim()).toBe('2FA codes');
};

describe('task text — one fixture on every surface', () => {
  it('card detail: ask, clarification and brief draw label and list apart, the summary keeps its inline marks', async () => {
    const harness = detailProps({
      task: card('F1', {
        ask: { text: LABEL_THEN_LIST, source: 'session:mvuc7tsf-0c3d50df' },
        clarifications: [
          {
            text: LABEL_THEN_LIST,
            source: 'session:mvuc7tsf-0c3d50df',
            at: '2026-08-01T09:30:00.000Z',
            by: { kind: 'owner' },
          },
        ],
        summary: 'Run `fy auth` → **6 digits**',
        brief: LABEL_THEN_LIST,
      }),
    });
    view = await mount(<BoardDetail {...harness.props} />);
    await interact(() => flush());
    const root = view.container;
    for (const selector of ['.fy-board-detail__ask', '.fy-board-detail__clarified', '[data-section="brief"]'])
      expectSeparate(must(root.querySelector(selector), selector));
    const summary = must(root.querySelector('[data-section="summary"]'), 'the summary');
    expect(summary.querySelector('code')?.textContent).toBe('fy auth');
    expect(summary.querySelector('strong')?.textContent).toBe('6 digits');
  });

  it('card detail: How to test keeps the sub-heading, the section label and the written numbers', async () => {
    const harness = detailProps({ task: card('F1', { laneId: 'tested', title: 'Try it', howToTest: HOW_TO_TEST }) });
    view = await mount(<BoardDetail {...harness.props} />);
    await interact(() => flush());
    const section = must(view.container.querySelector('[data-section="how-to-test"]'), 'How to test');
    expect(section.querySelector('.fy-board-test__lead')?.textContent).toBe('Setup');
    expect(section.querySelector('.fy-board-test__section')?.textContent?.trim()).toBe('2FA codes');
    expect([...section.querySelectorAll('.fy-board-test__n')].map(n => n.textContent)).toEqual(['1', '2', '4', '5']);
    expect(section.querySelectorAll('.fy-board-test__step code')).toHaveLength(2);
    expect(section.querySelector('[data-test-steps]')?.getAttribute('data-test-steps')).toBe('4');
  });

  it('the Try-it card draws the same steps, ticks and section label', async () => {
    const row = {
      key: 'to-test:F1',
      card: { key: 'F1', daemonId: 'd1', machine: 'box', task: { id: 'F1', title: 'Try it', shippedIn: null } },
      group: {},
      doneLaneId: 'closed',
      notGoodLaneId: 'implement',
      howToTest: HOW_TO_TEST,
      taskName: null,
      since: null,
      snoozedUntil: null,
    } as unknown as ToTestCard;
    const answers: ToTestAnswers = {
      answerFor: () => ({ pressed: null, error: null }) as never,
      done: () => undefined,
      notGood: () => undefined,
      snooze: () => undefined,
    };
    view = await mount(<ToTestList answers={answers} now={undefined} onNavigate={() => undefined} rows={[row]} />);
    const root = view.container;
    expect(root.querySelector('.fy-board-test__section')?.textContent?.trim()).toBe('2FA codes');
    expect([...root.querySelectorAll('.fy-board-test__n')].map(n => n.textContent)).toEqual(['1', '2', '4', '5']);
    expect(root.querySelectorAll('[data-test-tick]')).toHaveLength(4);
  });

  it('a Board card and a table row show the summary as one clean line, never the raw markers', async () => {
    const summary = 'Run `fy auth --totp` → **6 digits** and #tick';
    const model = await boardModelOf([card('F1', { laneId: 'implement', summary })]);
    const entry = must(model.cards[0], 'a card');
    view = await mount(
      <ul>
        <BoardCard
          card={entry}
          category="active"
          density="page"
          href="/d/laptop/board/F1"
          names={ferretNamer(new Map())}
          now={Date.parse('2026-08-01T10:04:00.000Z')}
          showMachine={false}
        />
      </ul>,
    );
    const line = must(view.container.querySelector('.fy-board-card__summary'), 'the card summary').textContent ?? '';
    expect(line).toBe('Run fy auth --totp → 6 digits and #tick');
    for (const marker of ['**', '`']) expect(line).not.toContain(marker);
    await view.unmount();
    const env: BoardCardEnv = {
      names: ferretNamer(new Map()),
      now: Date.parse('2026-08-01T10:04:00.000Z'),
      showMachine: false,
      hrefFor: item => `/d/laptop/board/${item.task.id}`,
      onNavigate: () => undefined,
      movesFor: () => undefined,
      places: cardPlaces(model),
      dragging: null,
    };
    view = await mount(<TableView env={env} model={model} onWindow={() => undefined} window="7d" />);
    const cell = must(view.container.querySelector('[data-task="F1"] .fy-board-table__summary-text'), 'the summary');
    expect(cell.textContent).toBe('Run fy auth --totp → 6 digits and #tick');
    expect(cell.textContent).not.toContain('**');
  });
});
