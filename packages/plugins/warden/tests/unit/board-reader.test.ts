import { describe, expect, test } from 'bun:test';
import type { FerretId } from '@ferretry/core-ferrets/contract';
import type { BoardApi, CardView } from '@ferretry/plugin-board/contract';
import { fakeBoard } from '@ferretry/plugin-board/contract/testing';
import { boardReader } from '../../daemon/board.ts';
import { lanes, PROJECT } from '../support/board.ts';
import { cardView } from './board-fixtures.ts';

const cardsOf = (count: number): CardView[] =>
  Array.from({ length: count }, (_, each) =>
    cardView({ id: `F${String(each + 1)}`, owner: 'lead', assignee: 'worker' }, { activity: 'orphaned' }),
  );

/** Board's contract with the reads the reader uses: pages of `pageSize`, the classic lanes, and some focus cards. */
const boardOf = (
  cards: readonly CardView[],
  options: { readonly pageSize?: number; readonly focus?: Readonly<Record<string, CardView>> } = {},
): { readonly board: BoardApi; readonly queries: unknown[] } => {
  const queries: unknown[] = [];
  const board: BoardApi = {
    ...fakeBoard(),
    cardsPage: async query => {
      queries.push(query);
      const start = query.cursor === undefined ? 0 : Number(query.cursor);
      const end = start + Math.min(query.limit, options.pageSize ?? 500);
      return { cards: cards.slice(start, end), nextCursor: end < cards.length ? String(end) : null };
    },
    laneSets: async () => [lanes(PROJECT)],
    focusOf: async ferret => options.focus?.[ferret],
  };
  return { board, queries };
};

const nobodyIsAHelper = { isHelper: async () => false };

describe('the Warden’s board reader', () => {
  test('reads every page of orphaned cards, asking for open orphaned cards at the largest page', async () => {
    // Arrange
    const { board, queries } = boardOf(cardsOf(1203));

    // Act
    const read = await boardReader(board, nobodyIsAHelper).read();

    // Assert
    expect(read?.views.map(view => view.id)).toEqual(cardsOf(1203).map(view => view.id));
    expect(queries).toHaveLength(3);
    expect(queries[0]).toEqual({ state: 'open', activity: 'orphaned', limit: 500 });
    expect(queries[1]).toEqual({ state: 'open', activity: 'orphaned', limit: 500, cursor: '500' });
  });

  test('names each lane from Board’s lane sets, by project', async () => {
    // Arrange
    const { board } = boardOf(cardsOf(1));

    // Act
    const read = await boardReader(board, nobodyIsAHelper).read();

    // Assert
    expect(read?.laneSets.get(PROJECT)?.lanes.find(lane => lane.id === 'implement')?.name).toBe('Implement');
  });

  test('a read that stops half way is not a read: the sweep must not take the unseen cards as recovered', async () => {
    // Arrange
    let page = 0;
    const board: BoardApi = {
      ...fakeBoard(),
      cardsPage: async () => {
        page += 1;
        if (page === 2) throw new Error('the board went away');
        return { cards: cardsOf(1), nextCursor: '1' };
      },
    };

    // Act / Assert
    await expect(boardReader(board, nobodyIsAHelper).read()).rejects.toThrow('the board went away');
  });

  test('a cursor that never ends is refused, not read for ever', async () => {
    // Arrange
    const board: BoardApi = { ...fakeBoard(), cardsPage: async () => ({ cards: cardsOf(1), nextCursor: 'same' }) };

    // Act / Assert
    await expect(boardReader(board, nobodyIsAHelper).read()).rejects.toThrow('cursor it had already given');
  });

  test('a ferret’s focus card comes with its lane set, and a helper is marked', async () => {
    // Arrange
    const focus = cardView({ id: 'F7', owner: 'lead', assignee: 'worker' });
    const { board } = boardOf([], { focus: { worker: focus, lead: focus } });
    const reader = boardReader(board, { isHelper: async ferret => ferret === 'worker' });

    // Act
    const lead = await reader.focusCard('lead');
    const worker = await reader.focusCard('worker');

    // Assert
    expect(lead?.task.id).toBe('F7');
    expect(lead?.laneSet?.projectId).toBe(PROJECT);
    expect(lead).not.toHaveProperty('subFerret');
    expect(worker?.subFerret).toBe(true);
  });

  test('a ferret with no focus card gets none', async () => {
    // Arrange
    const { board } = boardOf([]);

    // Act / Assert
    expect(await boardReader(board, nobodyIsAHelper).focusCard('nobody' as FerretId)).toBeUndefined();
  });
});
