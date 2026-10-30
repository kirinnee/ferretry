import { afterEach, describe, expect, it } from 'bun:test';
import { boardOk } from '@ferretry/protocol';
import { BoardPage, type BoardPageProps } from '../../../src/features/board/board-page.tsx';
import { PhoneKanban } from '../../../src/features/board/board-phone.tsx';
import type { BoardCardEnv } from '../../../src/features/board/board-views.tsx';
import { ferretNamer } from '../../../src/lib/board-present.ts';
import { DaemonBoardStore } from '../../../src/lib/board-store.ts';
import { cardPlaces } from '../../../src/lib/board-view.ts';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';
import {
  boardAnswer,
  boardModelOf,
  COUNTS,
  card,
  fakeEnvironment,
  fakePort,
  flush,
  laneSetFor,
  laptop,
  OTHER_PROJECT,
  PROJECT,
} from '../board-support.ts';

const NOW = Date.parse('2026-08-01T10:04:00.000Z');
const LEAD = 'mvuc7tsf-0c3d50df';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const OPEN = [
  card('F1', { title: 'Plan the thing', laneId: 'plan', owner: LEAD }),
  card('F2', { title: 'Build the thing', laneId: 'implement', owner: LEAD }),
  card('F3', { title: 'Review the thing', laneId: 'review' }),
  card('F4', { title: 'Try the thing', laneId: 'tested', activity: 'idle' }),
];

interface Phone {
  readonly acts: { id: string; request: unknown }[];
  readonly searches: string[];
  readonly root: HTMLElement;
}

const open = async (search = '', props: Partial<BoardPageProps> = {}): Promise<Phone> => {
  const acts: Phone['acts'] = [];
  const searches: string[] = [];
  const port = fakePort({
    board: async () =>
      boardAnswer(OPEN, {
        projectId: PROJECT,
        laneSet: laneSetFor(),
        counts: { ...COUNTS, toTest: 1, stale: 2, orphaned: 3 },
      }),
    projects: async () => [{ id: PROJECT, name: 'ferretry', path: null, laneSet: laneSetFor() }],
  });
  const store = new DaemonBoardStore(port, fakeEnvironment());
  store.act = async (_daemon, id, request) => {
    acts.push({ id, request });
    return boardOk(card(id));
  };
  view = await mount(
    <BoardPage
      agenda={{ respond: async () => undefined }}
      callsigns={new Map([[LEAD, 'denisha']])}
      machines={[{ connection: laptop, name: 'laptop' }]}
      now={NOW}
      onNavigate={() => undefined}
      onSearch={next => void searches.push(next)}
      phone
      search={search}
      store={store}
      {...props}
    />,
  );
  await interact(() => flush());
  return { acts, searches, root: view.container };
};

const titles = (root: HTMLElement) => [...root.querySelectorAll('.fy-board-card__title')].map(node => node.textContent);
const chips = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('[role="tab"]')];
const chipNamed = (root: HTMLElement, name: string) =>
  must(
    chips(root).find(chip => chip.getAttribute('aria-label')?.startsWith(`${name},`)),
    name,
  );
const click = (root: HTMLElement, selector: string) =>
  interact(() => must(root.querySelector<HTMLElement>(selector), selector).click());
const key = (target: Element, name: string) =>
  interact(() => target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })));
const pointer = (target: Element, type: 'pointerdown' | 'pointerup', x: number, y: number) =>
  interact(() =>
    target.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true })),
  );
const swipe = async (root: HTMLElement, from: readonly [number, number], to: readonly [number, number]) => {
  const panel = must(root.querySelector('[role="tabpanel"]'), 'the lane');
  await pointer(panel, 'pointerdown', from[0], from[1]);
  await pointer(panel, 'pointerup', to[0], to[1]);
};
const pick = (root: HTMLElement, selector: string, value: string) => {
  const select = must(root.querySelector<HTMLSelectElement>(selector), selector);
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, value);
  return interact(() => select.dispatchEvent(new Event('change', { bubbles: true })));
};

describe('Board on a phone — the lane strip', () => {
  it('shows the lanes as chips with their counts, opens on the first lane with a card, and lists only that lane', async () => {
    const { root } = await open();
    expect(chips(root).map(chip => chip.getAttribute('aria-label'))).toEqual([
      'Todo, 0 cards',
      'Plan/Design, 1 card',
      'Implement, 1 card',
      'Review/CI, 1 card',
      'Merged, 0 cards',
      'Released, 0 cards',
      'To test, 1 card',
    ]);
    expect(chipNamed(root, 'Plan/Design').getAttribute('aria-selected')).toBe('true');
    expect(titles(root)).toEqual(['Plan the thing']);
    expect(root.querySelector('.fy-board-kanban')).toBeNull();
  });

  it('shows the lane the URL names, and falls back when the board has no such lane', async () => {
    expect(titles((await open('at=review')).root)).toEqual(['Review the thing']);
    await view?.unmount();
    expect(titles((await open('at=gone')).root)).toEqual(['Plan the thing']);
  });

  it('writes a tapped chip to the URL, keeping the view and the filters', async () => {
    const { root, searches } = await open('kind=bug');
    await interact(() => chipNamed(root, 'Implement').click());
    const written = new URLSearchParams(searches[0]);
    expect(written.get('at')).toBe('implement');
    expect(written.get('kind')).toBe('bug');
  });

  it('keeps the lane in the URL when a filter changes', async () => {
    const { root, searches } = await open('at=review');
    await interact(() => must(root.querySelector<HTMLElement>('.fy-board-filters__toggle'), 'Filters').click());
    await pick(document.body, '[data-filter="kind"]', 'bug');
    expect(new URLSearchParams(searches[0]).get('at')).toBe('review');
    expect(new URLSearchParams(searches[0]).get('kind')).toBe('bug');
  });

  it('switches lane with the arrow keys, Home and End, and stops at the ends', async () => {
    const { root, searches } = await open('at=implement');
    const selected = () => must(root.querySelector('[role="tab"][aria-selected="true"]'), 'the chip');
    await key(selected(), 'ArrowRight');
    await key(selected(), 'ArrowLeft');
    await key(selected(), 'Home');
    await key(selected(), 'End');
    expect(searches.map(search => new URLSearchParams(search).get('at'))).toEqual(['review', 'plan', 'todo', 'tested']);
    await key(selected(), 'x');
    expect(searches).toHaveLength(4);
  });

  it('does not move past the last lane', async () => {
    const { root, searches } = await open('at=tested');
    await key(must(root.querySelector('[role="tab"][aria-selected="true"]'), 'the chip'), 'ArrowRight');
    expect(searches).toEqual([]);
  });

  it('gives only the chosen chip a tab stop', async () => {
    const { root } = await open('at=review');
    expect(chips(root).filter(chip => chip.tabIndex === 0)).toEqual([chipNamed(root, 'Review/CI')]);
  });

  it('swipes left to the next lane and right to the previous one', async () => {
    const first = await open('at=implement');
    await swipe(first.root, [300, 400], [200, 410]);
    expect(first.searches.map(search => new URLSearchParams(search).get('at'))).toEqual(['review']);
    await view?.unmount();

    const second = await open('at=implement');
    await swipe(second.root, [100, 400], [220, 390]);
    expect(second.searches.map(search => new URLSearchParams(search).get('at'))).toEqual(['plan']);
  });

  it('ignores a short drag and a mostly vertical one', async () => {
    const { root, searches } = await open('at=implement');
    await swipe(root, [300, 400], [270, 400]);
    await swipe(root, [300, 300], [230, 520]);
    expect(searches).toEqual([]);
  });

  it('does not follow the card link a swipe ended on, and follows the next tap', async () => {
    const opened: string[] = [];
    const { root } = await open('at=implement', { onNavigate: to => void opened.push(to) });
    const link = () => must(root.querySelector<HTMLElement>('[role="tabpanel"] a'), 'the card link');
    await swipe(root, [300, 400], [200, 410]);
    await interact(() => link().click());
    expect(opened).toEqual([]);
    await interact(() => link().click());
    expect(opened).toHaveLength(1);
  });

  it('forgets a drag the browser cancelled, so the next lift does not swipe', async () => {
    const { root, searches } = await open('at=implement');
    const panel = must(root.querySelector('[role="tabpanel"]'), 'the lane');
    await pointer(panel, 'pointerdown', 300, 400);
    await interact(() => void panel.dispatchEvent(new Event('pointercancel', { bubbles: true })));
    await pointer(panel, 'pointerup', 200, 410);
    expect(searches).toEqual([]);
  });

  it('says "Nothing here" for a lane with no card', async () => {
    const { root } = await open('at=todo');
    expect(root.querySelector('.fy-board-lane__empty')?.textContent).toBe('Nothing here');
  });

  it('gives each project its own strip under a heading, with the machine when several', async () => {
    const model = await boardModelOf([
      card('F1', { laneId: 'plan' }),
      card('F2', { laneId: 'plan', projectId: OTHER_PROJECT }),
    ]);
    const env: BoardCardEnv = {
      names: ferretNamer(new Map()),
      now: NOW,
      showMachine: false,
      hrefFor: entry => `/d/laptop/board/${entry.task.id}`,
      onNavigate: () => undefined,
      movesFor: () => undefined,
      places: cardPlaces(model),
      dragging: null,
      touch: true,
    };
    view = await mount(
      <PhoneKanban
        at={null}
        env={env}
        hideClosed
        model={{ ...model, multiMachine: true }}
        onLane={() => undefined}
        projectName={group => (group.projectId === OTHER_PROJECT ? 'other' : 'ferretry')}
      />,
    );
    expect([...view.container.querySelectorAll('.fy-board-project__head')].map(node => node.textContent)).toEqual([
      'ferretrylaptop',
      'otherlaptop',
    ]);
    expect(view.container.querySelectorAll('[role="tablist"]')).toHaveLength(2);
  });

  it('draws cards with no drag handle: a finger scrolls, it does not drag', async () => {
    const { root } = await open('at=tested');
    expect(root.querySelector('.fy-board-card[draggable="true"]')).toBeNull();
  });
});

describe('Board on a phone — counts and filters', () => {
  it('opens the matching cards as a list when a count is tapped', async () => {
    for (const [count, activity] of [
      ['to_test', 'to_test'],
      ['stale', 'stale'],
      ['orphaned', 'orphaned'],
    ] as const) {
      const { root, searches } = await open('at=review&sort=age');
      await click(root, `[data-count="${count}"]`);
      const written = new URLSearchParams(searches[0]);
      expect(written.get('view')).toBe('list');
      expect(written.get('activity')).toBe(activity);
      expect(written.get('sort')).toBe('age');
      await view?.unmount();
    }
  });

  it('lifts the filter, staying where it is, when the same count is tapped again', async () => {
    const { root, searches } = await open('view=list&activity=stale');
    await click(root, '[data-count="stale"]');
    const written = new URLSearchParams(searches[0]);
    expect(written.get('activity')).toBeNull();
    expect(written.get('view')).toBe('list');
  });

  it('keeps the filters out of the page until the Filters button opens them in a sheet', async () => {
    const { root } = await open();
    expect(root.querySelector('.fy-board-filters__row')).toBeNull();
    expect(document.querySelector('[data-bottom-sheet="board-filter-sheet"]')).toBeNull();

    await click(root, '.fy-board-filters__toggle');
    const sheet = must(document.querySelector('[data-bottom-sheet="board-filter-sheet"]'), 'the sheet');
    const dialog = must(sheet.querySelector('[role="dialog"]'), 'the dialog');
    expect(dialog.textContent).toContain('Filters');
    expect(dialog.querySelector('[data-filter="project"]')).not.toBeNull();
    expect(dialog.querySelector('[data-filter="activity"]')).not.toBeNull();
    expect(dialog.querySelector('[data-filter="mine"]')).not.toBeNull();
  });

  it('writes a choice made in the sheet to the URL as it is picked', async () => {
    const { root, searches } = await open();
    await click(root, '.fy-board-filters__toggle');
    await pick(document.body, '[data-filter="activity"]', 'stale');
    expect(new URLSearchParams(searches[0]).get('activity')).toBe('stale');
  });

  it('counts the active filters on the button, clears them all, and closes on Done', async () => {
    const { root, searches } = await open('kind=bug&mine=1');
    expect(root.querySelector('.fy-board-filters__n')?.textContent).toBe('2');
    await click(root, '.fy-board-filters__clear');
    expect(searches[0]).toBe('');

    await click(root, '.fy-board-filters__toggle');
    const sheet = must(document.querySelector('[data-bottom-sheet="board-filter-sheet"]'), 'the sheet');
    expect(sheet.getAttribute('aria-hidden')).toBeNull();
    const done = must(
      [...sheet.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Done'),
      'Done',
    );
    await interact(() => done.click());
    expect(document.querySelector('[data-bottom-sheet="board-filter-sheet"]')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
  });
});

describe('Board on a phone — rows waiting to be tested', () => {
  it('puts ✓ Works and ✗ Not good right on the row', async () => {
    const { root } = await open('at=tested');
    const row = must(root.querySelector('[data-task="F4"]'), 'the To test row');
    const buttons = [...row.querySelectorAll<HTMLButtonElement>('.fy-board-verdict')];
    expect(buttons.map(button => button.textContent)).toEqual(['Works', 'Not good']);
    expect(buttons.map(button => button.getAttribute('aria-label'))).toEqual([
      'Works: close Try the thing',
      'Not good: send back Try the thing',
    ]);
  });

  it('closes the card in one tap on Works', async () => {
    const { root, acts } = await open('at=tested');
    await click(root, '[data-task="F4"] [data-verdict="works"]');
    expect(acts).toEqual([{ id: 'F4', request: { action: 'move', to: 'closed' } }]);
  });

  it('slides the reason box up on Not good, and sends the card back only with a reason', async () => {
    const { root, acts } = await open('at=tested');
    await click(root, '[data-task="F4"] [data-verdict="not-good"]');
    expect(acts).toEqual([]);
    const scrim = must(root.querySelector('.fy-board__scrim'), 'the reason box');
    expect(scrim.hasAttribute('data-phone')).toBe(true);
    expect(scrim.textContent).toContain('Move Try the thing back to Implement');

    const input = must(scrim.querySelector<HTMLInputElement>('input'), 'the reason');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'The button is dead');
    await interact(() => input.dispatchEvent(new Event('input', { bubbles: true })));
    await interact(() => must(scrim.querySelector<HTMLButtonElement>('button[type="submit"]'), 'submit').click());
    await interact(() => flush());
    expect(acts).toEqual([{ id: 'F4', request: { action: 'move', to: 'implement', reason: 'The button is dead' } }]);
  });

  it('links the row to the full-screen card, which this page does not draw', async () => {
    const { root } = await open('at=tested');
    expect(root.querySelector('[data-task="F4"] a')?.getAttribute('href')).toBe(
      `/d/${encodeURIComponent('daemon/laptop')}/board/F4`,
    );
  });
});
