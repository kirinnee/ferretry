import { describe, expect, it } from 'bun:test';
import { type BoardMachineData, NO_BOARD_FILTERS, NO_DATE_RANGE } from '../../../app/lib/board-model.ts';
import {
  ARCHIVE_PAGE,
  activeFilterCount,
  archivePage,
  archiveRows,
  buildTree,
  taskPlaces,
  flattenTree,
  laneNames,
  listRows,
  parseBoardView,
} from '../../../app/lib/board-view.ts';
import { COUNTS, boardTask, laneSetFor, laptop, OTHER_PROJECT, PROJECT } from './board-support.ts';
import { mergeBoardAt as mergeBoard } from './board-support.ts';

const data = (tasks: ReturnType<typeof boardTask>[]): BoardMachineData => ({
  daemonId: laptop.daemonId,
  machine: 'laptop',
  version: '4.110.0',
  cards: tasks,
  laneSets: new Map([
    [PROJECT, laneSetFor()],
    [OTHER_PROJECT, null],
  ]),
  counts: COUNTS,
  quarantined: [],
});

const model = (tasks: ReturnType<typeof boardTask>[]) => mergeBoard([data(tasks)], NO_BOARD_FILTERS);

describe('parsing', () => {
  it('falls back to Kanban', () => {
    expect(parseBoardView('list')).toBe('list');
    expect(parseBoardView('nope')).toBe('kanban');
    expect(parseBoardView(null)).toBe('kanban');
  });
});

describe('the Table', () => {
  const tasks = [
    boardTask('F1', { activity: 'active', laneId: 'review', lastTouchedAt: '2026-08-01T10:00:00.000Z' }),
    boardTask('F2', { activity: 'stale', laneId: 'implement', lastTouchedAt: '2026-08-01T05:00:00.000Z' }),
    boardTask('F3', { activity: 'stale', laneId: 'implement', lastTouchedAt: '2026-08-01T01:00:00.000Z' }),
    boardTask('F4', { activity: 'orphaned', laneId: 'todo', lastTouchedAt: '2026-08-01T09:00:00.000Z' }),
    boardTask('F5', { activity: 'idle', laneId: 'ghost-lane', lastTouchedAt: '2026-08-01T09:00:00.000Z' }),
  ];

  it('walks the board in lane order and keeps unplaced cards, named by their lane id', () => {
    const rows = listRows(model(tasks));
    expect(rows.map(row => row.card.task.id)).toEqual(['F4', 'F2', 'F3', 'F1', 'F5']);
    expect(rows[0]?.laneName).toBe('Todo');
    const unplaced = rows[4];
    expect(unplaced?.laneName).toBe('ghost-lane');
    expect(unplaced?.category).toBeNull();
  });
});

describe('the Tree', () => {
  const lead = boardTask('F10');
  const child = boardTask('F11', { parent: { id: 'F10' } });
  const grandchild = boardTask('F12', { parent: { id: 'F11' } });
  const orphan = boardTask('F13', { parent: { id: 'F99' } });
  const rows = flattenTree(buildTree(model([lead, child, grandchild, orphan]).cards));

  it('indents children under their lead', () => {
    expect(rows.map(row => [row.card.task.id, row.depth, row.childCount])).toEqual([
      ['F10', 0, 1],
      ['F11', 1, 1],
      ['F12', 2, 0],
      ['F13', 0, 0],
    ]);
  });

  it('keeps several children of one lead in the order given', () => {
    const second = boardTask('F14', { parent: { id: 'F10' } });
    const ids = flattenTree(buildTree(model([lead, child, second]).cards)).map(row => row.card.task.id);
    expect(ids).toEqual(['F10', 'F11', 'F14']);
  });

  it('draws a card whose lead is out of view as a root, marked detached', () => {
    expect(rows.find(row => row.card.task.id === 'F13')?.detached).toBe(true);
    expect(rows.find(row => row.card.task.id === 'F10')?.detached).toBe(false);
  });

  it('survives a parent cycle without drawing a card twice', () => {
    const a = boardTask('F20', { parent: { id: 'F21' } });
    const b = boardTask('F21', { parent: { id: 'F20' } });
    expect(flattenTree(buildTree(model([a, b]).cards))).toEqual([]);
  });
});

describe('the Archive', () => {
  const closed = [
    boardTask('F1', { title: 'Old thing', lastTouchedAt: '2026-07-01T00:00:00.000Z', summary: 'about widgets' }),
    boardTask('F2', { title: 'New thing', lastTouchedAt: '2026-07-03T00:00:00.000Z' }),
    boardTask('F3', { title: 'No touch', lastTouchedAt: null, createdAt: '2026-07-02T00:00:00.000Z' }),
  ];
  const tasks = model(closed).cards;

  it('lists newest first, falling back to when the card was created', () => {
    expect(archiveRows(tasks, '').map(entry => entry.task.id)).toEqual(['F2', 'F3', 'F1']);
  });

  it('searches id, title and summary, ignoring case', () => {
    expect(archiveRows(tasks, ' WIDGET ').map(entry => entry.task.id)).toEqual(['F1']);
    expect(archiveRows(tasks, 'f2').map(entry => entry.task.id)).toEqual(['F2']);
    expect(archiveRows(tasks, 'zzz')).toEqual([]);
  });

  it('breaks a tie by key so the order never jitters', () => {
    const same = model([
      boardTask('F5', { lastTouchedAt: '2026-07-01T00:00:00.000Z' }),
      boardTask('F4', { lastTouchedAt: '2026-07-01T00:00:00.000Z' }),
    ]);
    expect(archiveRows(same.cards, '').map(entry => entry.task.id)).toEqual(['F4', 'F5']);
  });

  it('pages in blocks of ARCHIVE_PAGE', () => {
    const rows = Array.from({ length: ARCHIVE_PAGE * 2 + 3 }, (_, index) => index);
    expect(archivePage(rows, 1)).toEqual({ shown: rows.slice(0, ARCHIVE_PAGE), remaining: ARCHIVE_PAGE + 3 });
    expect(archivePage(rows, 3)).toEqual({ shown: rows, remaining: 0 });
    expect(archivePage(rows, 0).shown).toHaveLength(ARCHIVE_PAGE);
  });
});

describe('filters', () => {
  it('counts only the filters that narrow beyond the defaults', () => {
    expect(activeFilterCount(NO_BOARD_FILTERS)).toBe(0);
    expect(
      activeFilterCount({
        ...NO_BOARD_FILTERS,
        project: PROJECT,
        machine: laptop.daemonId,
        ferret: 'x',
        kind: 'bug',
        pr: 'open',
        state: 'closed',
        activity: 'stale',
        mine: true,
        lane: 'Todo',
        created: { preset: 'today', from: null, to: null },
        touched: { preset: null, from: '2026-07-01', to: null },
      }),
    ).toBe(11);
    expect(activeFilterCount({ ...NO_BOARD_FILTERS, touched: { ...NO_DATE_RANGE, to: '2026-07-01' } })).toBe(1);
  });

  it('offers each lane name once, in the order first met', () => {
    expect(laneNames(model([boardTask('F1')]))).toEqual([
      'Todo',
      'Plan/Design',
      'Implement',
      'Review/CI',
      'Merged',
      'Released',
      'To test',
      'Closed',
    ]);
    expect(
      laneNames(mergeBoard([data([boardTask('F1'), boardTask('F2', { projectId: OTHER_PROJECT })])], NO_BOARD_FILTERS)),
    ).toHaveLength(8);
  });
});

describe('places', () => {
  const placed = model([boardTask('F1', { laneId: 'review' }), boardTask('F2', { laneId: 'ghost' })]);

  it('finds the lane a card sits in, or none for an unplaced one', () => {
    const places = taskPlaces(placed);
    const [first, second] = placed.cards;
    expect(places.get(first?.key ?? '')).toMatchObject({ laneName: 'Review/CI', category: 'review' });
    expect(places.get(second?.key ?? '')).toMatchObject({ laneName: 'ghost', category: null });
  });
});
