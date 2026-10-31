import { afterEach, describe, expect, it } from 'bun:test';
import { BoardCard, type BoardCardMoves } from '../../../src/features/board/board-card.tsx';
import { BoardLane } from '../../../src/features/board/board-lane.tsx';
import { moveChoices } from '../../../src/lib/board-move.ts';
import { ferretNamer } from '../../../src/lib/board-present.ts';
import { interact, type Mounted, mount, must, pressKey } from '../../support/dom.ts';
import { boardModelOf, card, laneSetFor } from '../board-support.ts';

const NOW = Date.parse('2026-08-01T10:04:00.000Z');
const names = ferretNamer(new Map([['mvuc7tsf-0c3d50df', 'denisha']]));

let view: Mounted | null = null;
const release = async (): Promise<void> => {
  await view?.unmount();
  view = null;
};
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const cardOf = async (extra: Record<string, unknown> = {}) => {
  const model = await boardModelOf([card('F412', { title: 'Wire the board page', ...extra })]);
  return must(model.cards[0], 'a card');
};

const moves = (log: string[] = [], overrides: Partial<BoardCardMoves> = {}): BoardCardMoves => ({
  choices: moveChoices(laneSetFor(), 'review'),
  onMove: (_card, laneId) => void log.push(`move:${laneId}`),
  closeLaneId: 'closed',
  reworkLaneId: 'implement',
  onDragStart: target => void log.push(`start:${target.task.id}`),
  onDragEnd: () => void log.push('end'),
  ...overrides,
});

const dragEvent = (type: string) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const data = new Map<string, string>();
  Object.defineProperty(event, 'dataTransfer', {
    value: { effectAllowed: '', dropEffect: '', setData: (key: string, value: string) => data.set(key, value) },
  });
  return { event, data };
};

const draw = async (props: Partial<Parameters<typeof BoardCard>[0]> = {}) => {
  const task = await cardOf();
  view = await mount(
    <ul>
      <BoardCard
        card={task}
        category="review"
        density="page"
        href="/d/laptop/board/F412"
        names={names}
        now={NOW}
        showMachine={false}
        {...props}
      />
    </ul>,
  );
  return view.container;
};

describe('BoardCard', () => {
  it('draws the title and one meta line of segments', async () => {
    const root = await draw();
    expect(root.querySelector('.fy-board-card__title')?.textContent).toBe('Wire the board page');
    const segments = [...root.querySelectorAll('.fy-board-seg')].map(node => node.getAttribute('data-seg'));
    expect(segments).toEqual(['ref', 'activity', 'people']);
    expect(root.querySelector('[data-seg="ref"]')?.textContent).toBe('&F412');
    const li = must(root.querySelector('li'), 'the card');
    expect(li.dataset.activity).toBe('active');
    expect(li.dataset.category).toBe('review');
    expect(li.dataset.density).toBe('page');
    expect(li.dataset.task).toBe('F412');
  });

  it('draws the summary as one line under the title, and How to test as a marker', async () => {
    const task = await cardOf({ summary: 'Cards say how to test them', howToTest: '1. Open it' });
    view = await mount(
      <ul>
        <BoardCard card={task} category="verify" density="page" href="/x" names={names} now={NOW} showMachine={false} />
      </ul>,
    );
    const root = view.container;
    expect(root.querySelector('.fy-board-card__title')?.nextElementSibling?.className).toBe('fy-board-card__summary');
    expect(root.querySelector('.fy-board-card__summary')?.textContent).toBe('Cards say how to test them');
    expect(root.querySelector('[data-seg="test"]')?.textContent).toBe('How to test');
  });

  it('says quietly when a card to test has no test steps, and leaves the summary out of the side density', async () => {
    const task = await cardOf({ summary: 'Cards say how to test them' });
    view = await mount(
      <ul>
        <BoardCard card={task} category="verify" density="side" href="/x" names={names} now={NOW} showMachine={false} />
      </ul>,
    );
    const root = view.container;
    expect(root.querySelector('.fy-board-card__summary')).toBeNull();
    expect(root.querySelector('[data-seg="test"]')?.textContent).toBe('no test steps');
    expect(root.querySelector('[data-seg="test"]')?.getAttribute('data-tone')).toBe('quiet');
  });

  it('keeps one short line in the side density, without the optional segments', async () => {
    const root = await draw({ density: 'side', showMachine: true });
    expect([...root.querySelectorAll('.fy-board-seg')].map(node => node.getAttribute('data-seg'))).toEqual([
      'ref',
      'activity',
    ]);
    expect(must(root.querySelector('li'), 'the card').dataset.density).toBe('side');
  });

  it('adds the machine only when several are on the board, and the lane and depth when asked', async () => {
    const root = await draw({ showMachine: true, lane: 'Review/CI', depth: 2 });
    expect([...root.querySelectorAll('.fy-board-seg')].map(node => node.getAttribute('data-seg'))).toEqual([
      'lane',
      'ref',
      'activity',
      'people',
      'machine',
    ]);
    const li = must(root.querySelector('li'), 'the card');
    expect(li.dataset.depth).toBe('2');
    expect(li.style.getPropertyValue('--fy-board-depth')).toBe('2');
  });

  it('uses the summary in the tooltip when there is one', async () => {
    const withSummary = await cardOf({ summary: 'the long story' });
    const root = await draw({ card: withSummary });
    expect(root.querySelector('a')?.getAttribute('title')).toBe('Wire the board page — the long story');
    await release();
    const plain = await draw();
    expect(plain.querySelector('a')?.getAttribute('title')).toBe('Wire the board page');
  });

  it('is a link to its detail that navigates in the app on a plain click', async () => {
    const seen: string[] = [];
    const root = await draw({ onNavigate: to => void seen.push(to) });
    const link = must(root.querySelector('a'), 'the link');
    expect(link.getAttribute('href')).toBe('/d/laptop/board/F412');
    await interact(() => link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })));
    expect(seen).toEqual(['/d/laptop/board/F412']);
  });

  it('is not draggable and has no menu without moves', async () => {
    const root = await draw();
    expect(must(root.querySelector('li'), 'the card').getAttribute('draggable')).toBe('false');
    expect(root.querySelector('.fy-board-card__more')).toBeNull();
  });

  it('starts and ends a drag when it can be moved', async () => {
    const log: string[] = [];
    const root = await draw({ moves: moves(log), dragging: true });
    const li = must(root.querySelector('li'), 'the card');
    expect(li.getAttribute('draggable')).toBe('true');
    expect(li.hasAttribute('data-dragging')).toBe(true);
    const start = dragEvent('dragstart');
    await interact(() => li.dispatchEvent(start.event));
    expect(start.data.get('text/plain')).toContain('F412');
    await interact(() => li.dispatchEvent(dragEvent('dragend').event));
    expect(log).toEqual(['start:F412', 'end']);
  });

  it('opens a Move to… menu that marks moves back and sends the pick', async () => {
    const log: string[] = [];
    const root = await draw({ moves: moves(log) });
    const open = must(root.querySelector<HTMLButtonElement>('.fy-board-card__more'), 'the menu button');
    expect(open.getAttribute('aria-label')).toBe('Move Wire the board page to…');
    expect(root.querySelector('[role="menu"]')).toBeNull();
    await interact(() => open.click());
    const items = [...root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(items.map(item => item.textContent)).toEqual([
      'Todo',
      'Plan/Design',
      'Implement',
      'Merged',
      'Released',
      'To test',
      'Closed',
    ]);
    expect(items.map(item => item.hasAttribute('data-backward'))).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
    await interact(() => must(items[2], 'Implement').click());
    expect(log).toEqual(['move:implement']);
    expect(root.querySelector('[role="menu"]')).toBeNull();
  });

  it('closes the menu on Escape and when focus leaves it, and has none without choices', async () => {
    const root = await draw({ moves: moves() });
    const open = () => must(root.querySelector<HTMLButtonElement>('.fy-board-card__more'), 'the menu button');
    await interact(() => open().click());
    await interact(() => pressKey(open(), 'Escape'));
    expect(root.querySelector('[role="menu"]')).toBeNull();
    await interact(() => pressKey(open(), 'Escape'));
    await interact(() => open().click());
    await interact(() =>
      open().dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body })),
    );
    expect(root.querySelector('[role="menu"]')).toBeNull();
    await release();
    const bare = await draw({ moves: moves([], { choices: [] }) });
    expect(bare.querySelector('.fy-board-card__more')).toBeNull();
  });

  it('offers Done and Not good on a card waiting to be tried', async () => {
    const log: string[] = [];
    const root = await draw({ category: 'verify', moves: moves(log) });
    const works = must(root.querySelector<HTMLButtonElement>('[data-verdict="works"]'), 'Works');
    const notGood = must(root.querySelector<HTMLButtonElement>('[data-verdict="not-good"]'), 'Not good');
    expect(works.textContent).toBe('Done');
    expect(works.title).toMatch(/^Mark .* done and close it$/u);
    expect(notGood.textContent).toBe('Not good');
    await interact(() => works.click());
    await interact(() => notGood.click());
    expect(log).toEqual(['move:closed', 'move:implement']);
  });

  it('leaves out a verdict button whose lane the project does not have, and all of them off the verify lane', async () => {
    const onlyClose = await draw({ category: 'verify', moves: moves([], { reworkLaneId: null }) });
    expect(onlyClose.querySelector('[data-verdict="not-good"]')).toBeNull();
    expect(onlyClose.querySelector('[data-verdict="works"]')).not.toBeNull();
    await release();
    const onlyRework = await draw({ category: 'verify', moves: moves([], { closeLaneId: null }) });
    expect(onlyRework.querySelector('[data-verdict="works"]')).toBeNull();
    expect(onlyRework.querySelector('[data-verdict="not-good"]')).not.toBeNull();
    await release();
    const neither = await draw({ category: 'verify', moves: moves([], { closeLaneId: null, reworkLaneId: null }) });
    expect(neither.querySelector('.fy-board-card__verdict')).toBeNull();
    await release();
    const elsewhere = await draw({ moves: moves() });
    expect(elsewhere.querySelector('.fy-board-card__verdict')).toBeNull();
    await release();
    const side = await draw({ category: 'verify', density: 'side', moves: moves() });
    expect(side.querySelector('.fy-board-card__verdict [data-verdict="not-good"]')).not.toBeNull();
  });

  it('closes a card waiting to be tried with the shared Done, in place of Close, and keeps Not good', async () => {
    const log: string[] = [];
    const done = {
      done: { kind: 'done', laneId: 'closed' } as const,
      press: () => void log.push('done'),
      atRelease: false,
    };
    const root = await draw({ category: 'verify', done, moves: moves(log) });
    expect(root.querySelector('[data-verdict="works"]')).toBeNull();
    const button = must(root.querySelector<HTMLButtonElement>('.fy-board-card__verdict .fy-board-done'), 'Done');
    expect(button.textContent).toContain('Done');
    await interact(() => button.click());
    await interact(() => must(root.querySelector<HTMLButtonElement>('[data-verdict="not-good"]'), 'Not good').click());
    expect(log).toEqual(['done', 'move:implement']);
    await release();
    const touch = await draw({ category: 'verify', done, moves: moves(), touch: true });
    expect(touch.querySelector('.fy-board-card__verdict .fy-board-done')).not.toBeNull();
  });

  it('keeps a Done verdict button when the card has no Done control to offer', async () => {
    const reopen = { done: { kind: 'reopen', laneId: 'implement' } as const, press: () => undefined, atRelease: false };
    const root = await draw({ category: 'verify', done: reopen, moves: moves() });
    expect(root.querySelector('[data-verdict="works"]')).not.toBeNull();
    expect(root.querySelector('.fy-board-done')).toBeNull();
  });

  it('gives a Released card its own Done row, and none where Done does not apply', async () => {
    const log: string[] = [];
    const done = {
      done: { kind: 'done', laneId: 'closed' } as const,
      press: () => void log.push('done'),
      atRelease: true,
    };
    const root = await draw({ category: 'shipped', done, moves: moves() });
    await interact(() =>
      must(root.querySelector<HTMLButtonElement>('.fy-board-card__verdict .fy-board-done'), 'Done').click(),
    );
    expect(log).toEqual(['done']);
    await release();
    const merged = await draw({ category: 'shipped', done: { ...done, atRelease: false }, moves: moves() });
    expect(merged.querySelector('.fy-board-done')).toBeNull();
    await release();
    const side = await draw({ category: 'shipped', density: 'side', done, moves: moves() });
    expect(side.querySelector('.fy-board-card__verdict .fy-board-done')).not.toBeNull();
    await release();
    const bare = await draw({ category: 'shipped' });
    expect(bare.querySelector('.fy-board-done')).toBeNull();
  });

  it('puts Done (or Reopen) first in the ⋯ menu, even when there are no lanes to move to', async () => {
    const log: string[] = [];
    const done = {
      done: { kind: 'done', laneId: 'closed' } as const,
      press: () => void log.push('done'),
      atRelease: false,
    };
    const root = await draw({ done, moves: moves(log) });
    await interact(() =>
      must(root.querySelector<HTMLButtonElement>('.fy-board-card__more'), 'the menu button').click(),
    );
    const first = must(root.querySelector<HTMLButtonElement>('[role="menuitem"]'), 'the first item');
    expect(first.textContent).toBe('Done');
    expect(first.dataset.done).toBe('done');
    await interact(() => first.click());
    expect(log).toEqual(['done']);
    expect(root.querySelector('[role="menu"]')).toBeNull();
    await release();
    const reopen = {
      done: { kind: 'reopen', laneId: 'implement' } as const,
      press: () => void log.push('reopen'),
      atRelease: false,
    };
    const closed = await draw({ category: 'closed', done: reopen, moves: moves([], { choices: [] }) });
    await interact(() =>
      must(closed.querySelector<HTMLButtonElement>('.fy-board-card__more'), 'the menu button').click(),
    );
    const only = [...closed.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(only.map(item => item.textContent)).toEqual(['Reopen']);
    await interact(() => must(only[0], 'Reopen').click());
    expect(log).toEqual(['done', 'reopen']);
  });

  it('marks a card whose lane is unknown as unplaced', async () => {
    const root = await draw({ category: null });
    expect(must(root.querySelector('li'), 'the card').dataset.category).toBe('unplaced');
  });
});

describe('BoardLane', () => {
  const lane = (props: Partial<Parameters<typeof BoardLane>[0]> = {}) => (
    <BoardLane category="active" count={2} density="page" name="Implement" {...props}>
      <li>one</li>
      <li>two</li>
    </BoardLane>
  );

  it('names itself with its count and folds away from its header', async () => {
    view = await mount(lane());
    const section = must(view.container.querySelector('section'), 'the lane');
    expect(section.getAttribute('aria-label')).toBe('Implement, 2 cards');
    expect(section.dataset.category).toBe('active');
    expect(view.container.querySelectorAll('li')).toHaveLength(2);
    const toggle = must(view.container.querySelector<HTMLButtonElement>('.fy-board-lane__toggle'), 'the toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await interact(() => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(view.container.querySelectorAll('li')).toHaveLength(0);
    await interact(() => toggle.click());
    expect(view.container.querySelectorAll('li')).toHaveLength(2);
  });

  it('says "card" for one, starts folded when asked, and is unplaced with no category', async () => {
    view = await mount(lane({ count: 1, defaultCollapsed: true, category: null }));
    const section = must(view.container.querySelector('section'), 'the lane');
    expect(section.getAttribute('aria-label')).toBe('Implement, 1 card');
    expect(section.dataset.category).toBe('unplaced');
    expect(view.container.querySelectorAll('li')).toHaveLength(0);
  });

  it('takes a drop only while it accepts one', async () => {
    const dropped: string[] = [];
    view = await mount(lane({ onDropCard: () => void dropped.push('drop') }));
    const section = must(view.container.querySelector('section'), 'the lane');
    expect(section.dataset.drop).toBeUndefined();
    await interact(() => section.dispatchEvent(dragEvent('dragover').event));
    await interact(() => section.dispatchEvent(dragEvent('drop').event));
    expect(dropped).toEqual([]);

    await view.render(lane({ accepts: true, onDropCard: () => void dropped.push('drop') }));
    expect(section.dataset.drop).toBe('ready');
    await interact(() => section.dispatchEvent(dragEvent('dragover').event));
    expect(section.dataset.drop).toBe('over');
    await interact(() => section.dispatchEvent(dragEvent('dragleave').event));
    expect(section.dataset.drop).toBe('ready');
    await interact(() => section.dispatchEvent(dragEvent('dragover').event));
    await interact(() => section.dispatchEvent(dragEvent('drop').event));
    expect(dropped).toEqual(['drop']);
    expect(section.dataset.drop).toBe('ready');
  });

  it('does not accept a drop it has no handler for', async () => {
    view = await mount(lane({ accepts: true }));
    expect(must(view.container.querySelector('section'), 'the lane').dataset.drop).toBeUndefined();
  });
});
