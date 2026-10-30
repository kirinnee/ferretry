import { afterEach, describe, expect, it } from 'bun:test';
import {
  ArchiveView,
  type BoardCardEnv,
  DependenciesView,
  KanbanView,
  ListView,
  TreeView,
} from '../../../src/features/board/board-views.tsx';
import { ferretNamer } from '../../../src/lib/board-present.ts';
import { cardPlaces } from '../../../src/lib/board-view.ts';
import type { BoardModel } from '../../../src/lib/board-model.ts';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';
import { boardModelOf, card, OTHER_PROJECT } from '../board-support.ts';

const NOW = Date.parse('2026-08-01T10:04:00.000Z');

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const envOf = (model: BoardModel, extra: Partial<BoardCardEnv> = {}): BoardCardEnv => ({
  names: ferretNamer(new Map()),
  now: NOW,
  showMachine: false,
  hrefFor: entry => `/d/laptop/board/${entry.task.id}`,
  onNavigate: () => undefined,
  movesFor: () => undefined,
  places: cardPlaces(model),
  dragging: null,
  ...extra,
});

const ids = (root: HTMLElement, selector = '.fy-board-card') =>
  [...root.querySelectorAll<HTMLElement>(selector)].map(node => node.dataset.task);

describe('KanbanView', () => {
  const cards = [
    card('F1', { laneId: 'todo' }),
    card('F2', { laneId: 'implement' }),
    card('F3', { laneId: 'implement' }),
    card('F9', { laneId: 'ghost' }),
  ];

  it('draws a lane per lane of the set, with its cards, "Nothing here" when empty and an Unplaced lane', async () => {
    const model = await boardModelOf(cards);
    view = await mount(
      <KanbanView
        env={envOf(model)}
        hideClosed={false}
        model={model}
        onDropCard={() => undefined}
        projectName={() => 'ferretry'}
      />,
    );
    const root = view.container;
    expect([...root.querySelectorAll('.fy-board-lane__name')].map(node => node.textContent)).toEqual([
      'Todo',
      'Plan/Design',
      'Implement',
      'Review/CI',
      'Merged',
      'Released',
      'Manually tested',
      'Closed',
      'Unplaced',
    ]);
    expect(root.querySelectorAll('.fy-board-lane__empty').length).toBe(6);
    expect(root.querySelector('.fy-board-project__head')).toBeNull();
    expect(ids(root)).toEqual(['F1', 'F2', 'F3', 'F9']);
  });

  it('hides the Closed lane when closed work is hidden', async () => {
    const model = await boardModelOf(cards);
    view = await mount(
      <KanbanView
        env={envOf(model)}
        hideClosed
        model={model}
        onDropCard={() => undefined}
        projectName={() => 'ferretry'}
      />,
    );
    expect([...view.container.querySelectorAll('.fy-board-lane__name')].map(node => node.textContent)).not.toContain(
      'Closed',
    );
  });

  it('gives each project its own row of lanes under a heading, with the machine when several', async () => {
    const model = await boardModelOf([card('F1'), card('F2', { projectId: OTHER_PROJECT })]);
    view = await mount(
      <KanbanView
        env={envOf(model)}
        hideClosed
        model={{ ...model, multiMachine: true }}
        onDropCard={() => undefined}
        projectName={group => (group.projectId === OTHER_PROJECT ? 'other' : 'ferretry')}
      />,
    );
    expect([...view.container.querySelectorAll('.fy-board-project__head')].map(node => node.textContent)).toEqual([
      'ferretrylaptop',
      'otherlaptop',
    ]);
  });

  it('takes a drop on a lane of the board the card came from, never on its own lane', async () => {
    const model = await boardModelOf(cards);
    const group = must(model.groups[0], 'the group');
    const dropped: string[] = [];
    const env = envOf(model, { dragging: { cardKey: must(model.cards[1], 'F2').key, groupKey: group.key } });
    view = await mount(
      <KanbanView
        env={env}
        hideClosed={false}
        model={model}
        onDropCard={(key, lane) => void dropped.push(`${key === group.key}:${lane}`)}
        projectName={() => 'p'}
      />,
    );
    const lanes = [...view.container.querySelectorAll<HTMLElement>('.fy-board-lane')];
    expect(lanes.filter(lane => lane.dataset.drop === 'ready').length).toBe(7);
    const implement = must(
      lanes.find(lane => lane.getAttribute('aria-label')?.startsWith('Implement')),
      'Implement',
    );
    expect(implement.dataset.drop).toBeUndefined();
    const review = must(
      lanes.find(lane => lane.getAttribute('aria-label')?.startsWith('Review')),
      'Review',
    );
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: {} });
    await interact(() => review.dispatchEvent(drop));
    expect(dropped).toEqual(['true:review']);
  });

  it('does not take a drop from another board', async () => {
    const model = await boardModelOf(cards);
    const env = envOf(model, { dragging: { cardKey: 'x', groupKey: 'another' } });
    view = await mount(
      <KanbanView env={env} hideClosed={false} model={model} onDropCard={() => undefined} projectName={() => 'p'} />,
    );
    expect(view.container.querySelectorAll('[data-drop]').length).toBe(0);
  });

  it('shows a "Works → Close" target while dragging with closed work hidden', async () => {
    const model = await boardModelOf(cards);
    const group = must(model.groups[0], 'the group');
    const dropped: string[] = [];
    const env = envOf(model, { dragging: { cardKey: must(model.cards[1], 'F2').key, groupKey: group.key } });
    view = await mount(
      <KanbanView
        env={env}
        hideClosed
        model={model}
        onDropCard={(_key, lane) => void dropped.push(lane)}
        projectName={() => 'p'}
      />,
    );
    const target = must(view.container.querySelector<HTMLElement>('[data-variant="target"]'), 'the target');
    expect(target.getAttribute('aria-label')).toBe('✓ Works → Close, 0 cards');
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: {} });
    await interact(() => target.dispatchEvent(drop));
    expect(dropped).toEqual(['closed']);
  });

  it('shows no target when nothing is dragged', async () => {
    const model = await boardModelOf(cards);
    view = await mount(
      <KanbanView env={envOf(model)} hideClosed model={model} onDropCard={() => undefined} projectName={() => 'p'} />,
    );
    expect(view.container.querySelector('[data-variant="target"]')).toBeNull();
  });
});

describe('ListView', () => {
  const cards = [
    card('F1', { activity: 'active', laneId: 'review' }),
    card('F2', { activity: 'stale', laneId: 'implement' }),
  ];

  it('lists every card with its lane, stale first, and sorts on request', async () => {
    const model = await boardModelOf(cards);
    const sorts: string[] = [];
    view = await mount(
      <ListView env={envOf(model)} model={model} onSort={sort => void sorts.push(sort)} sort="stale" />,
    );
    const root = view.container;
    expect(ids(root)).toEqual(['F2', 'F1']);
    expect(root.querySelector('[data-task="F2"] [data-seg="lane"]')?.textContent).toBe('Implement');
    expect(root.querySelector('[data-sort="stale"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(root.querySelector('[data-sort="lane"]')?.getAttribute('aria-pressed')).toBe('false');
    await interact(() => must(root.querySelector<HTMLButtonElement>('[data-sort="touched"]'), 'Last touched').click());
    expect(sorts).toEqual(['touched']);
  });

  it('says so when no card matches', async () => {
    const model = await boardModelOf([]);
    view = await mount(<ListView env={envOf(model)} model={model} onSort={() => undefined} sort="lane" />);
    expect(view.container.querySelector('.fy-board-empty')?.textContent).toBe('No cards match.');
  });
});

describe('TreeView', () => {
  it('indents a lead’s children under it', async () => {
    const model = await boardModelOf([card('F10'), card('F11', { parent: { id: 'F10' } })]);
    view = await mount(<TreeView env={envOf(model)} model={model} />);
    expect(ids(view.container)).toEqual(['F10', 'F11']);
    expect(view.container.querySelector('[data-task="F11"]')?.getAttribute('data-depth')).toBe('1');
  });

  it('names the lane id when a card’s lane is unknown, and says so when empty', async () => {
    const unplaced = await boardModelOf([card('F1', { laneId: 'ghost' })]);
    view = await mount(<TreeView env={envOf(unplaced, { places: new Map() })} model={unplaced} />);
    expect(view.container.querySelector('[data-seg="lane"]')?.textContent).toBe('ghost');
    await view.unmount();
    const empty = await boardModelOf([]);
    view = await mount(<TreeView env={envOf(empty)} model={empty} />);
    expect(view.container.querySelector('.fy-board-empty')?.textContent).toBe('No cards match.');
  });
});

describe('DependenciesView', () => {
  it('lists the cards that wait on, or are waited on by, another', async () => {
    const model = await boardModelOf([
      card('F1', { blockedBy: [{ id: 'F2' }, { id: 'F3' }] }),
      card('F2', { blocks: [{ id: 'F1' }] }),
      card('F4'),
    ]);
    view = await mount(<DependenciesView env={envOf(model)} model={model} />);
    expect(ids(view.container)).toEqual(['F1', 'F2']);
    expect(view.container.querySelector('[data-dep="blocked-by"]')?.textContent).toBe('⛓ waits on &F2, &F3');
    expect(view.container.querySelector('[data-dep="blocks"]')?.textContent).toBe('unblocks &F1');
  });

  it('names the lane id for a card with no place, and says so when nothing depends on anything', async () => {
    const model = await boardModelOf([card('F1', { blockedBy: [{ id: 'F2' }], laneId: 'ghost' })]);
    view = await mount(<DependenciesView env={envOf(model, { places: new Map() })} model={model} />);
    expect(view.container.querySelector('[data-seg="lane"]')?.textContent).toBe('ghost');
    await view.unmount();
    const none = await boardModelOf([card('F9')]);
    view = await mount(<DependenciesView env={envOf(none)} model={none} />);
    expect(view.container.querySelector('.fy-board-empty')?.textContent).toBe('No card depends on another.');
  });
});

describe('ArchiveView', () => {
  const props = async (extra: Partial<Parameters<typeof ArchiveView>[0]> = {}) => {
    const model = await boardModelOf([card('F1'), card('F2')]);
    return {
      shown: model.cards,
      remaining: 0,
      total: 2,
      query: '',
      onQuery: () => undefined,
      onMore: () => undefined,
      loading: false,
      env: envOf(model),
      ...extra,
    };
  };

  it('lists closed cards and offers no "more" when everything is shown', async () => {
    view = await mount(<ArchiveView {...await props()} />);
    expect(ids(view.container)).toEqual(['F1', 'F2']);
    expect(view.container.querySelector('.fy-board-archive__more')).toBeNull();
  });

  it('searches, and pages with the number left', async () => {
    const seen: string[] = [];
    let more = 0;
    view = await mount(
      <ArchiveView
        {...await props({
          remaining: 40,
          total: 65,
          onQuery: query => void seen.push(query),
          onMore: () => {
            more += 1;
          },
        })}
      />,
    );
    const search = must(
      view.container.querySelector<HTMLInputElement>('input[aria-label="Search the archive"]'),
      'the search',
    );
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(search, 'widget');
    await interact(() => search.dispatchEvent(new Event('input', { bubbles: true })));
    expect(seen).toEqual(['widget']);
    const button = must(view.container.querySelector<HTMLButtonElement>('.fy-board-archive__more'), 'Show more');
    expect(button.textContent).toBe('Show 25 more · 40 left of 65');
    await interact(() => button.click());
    expect(more).toBe(1);
  });

  it('says why it is empty', async () => {
    view = await mount(<ArchiveView {...await props({ shown: [], total: 0, loading: true })} />);
    expect(view.container.querySelector('.fy-board-empty')?.textContent).toBe('Reading the archive…');
    await view.render(<ArchiveView {...await props({ shown: [], total: 0 })} />);
    expect(view.container.querySelector('.fy-board-empty')?.textContent).toBe('Nothing closed yet.');
    await view.render(<ArchiveView {...await props({ shown: [], total: 0, query: 'zzz' })} />);
    expect(view.container.querySelector('.fy-board-empty')?.textContent).toBe('No archived card matches.');
  });

  it('shows the last page’s remainder, not a full page', async () => {
    view = await mount(<ArchiveView {...await props({ remaining: 3, total: 28 })} />);
    expect(view.container.querySelector('.fy-board-archive__more')?.textContent).toBe('Show 3 more · 3 left of 28');
  });
});
