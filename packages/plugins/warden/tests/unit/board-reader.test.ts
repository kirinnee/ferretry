import { describe, expect, test } from 'bun:test';
import type { FerretId } from '@ferretry/core-ferrets/contract';
import type { BoardApi, CardView, FocusCard } from '@ferretry/plugin-board/contract';
import { fakeBoard } from '@ferretry/plugin-board/contract/testing';
import { boardReader } from '../../daemon/board.ts';
import { lanes, PROJECT } from '../support/board.ts';
import { cardView } from './board-fixtures.ts';

const cardsOf = (count: number, from = 1): CardView[] =>
  Array.from({ length: count }, (_, each) =>
    cardView({ id: `F${String(from + each)}`, owner: 'lead', assignee: 'worker' }, { activity: 'orphaned' }),
  );

/** Board's contract with the reads the reader uses: the orphaned cards in one read, the classic lanes, some focus cards. */
const boardOf = (
  cards: readonly CardView[],
  options: { readonly focus?: Readonly<Record<string, FocusCard>> } = {},
): { readonly board: BoardApi; readonly reads: string[] } => {
  const reads: string[] = [];
  const board: BoardApi = {
    ...fakeBoard(),
    orphanedCards: async () => {
      reads.push('orphanedCards');
      return { cards, laneSets: [lanes(PROJECT)] };
    },
    cardsPage: async () => {
      reads.push('cardsPage');
      throw new Error('the Warden reads one snapshot, not pages');
    },
    laneSets: async () => {
      reads.push('laneSets');
      throw new Error('the Warden takes the lanes from the snapshot, or from the focus card');
    },
    focusOf: async ferret => options.focus?.[ferret],
  };
  return { board, reads };
};

const nobodyIsAHelper = { isHelper: async () => false };

describe('the Warden’s board reader', () => {
  test('reads every orphaned card in one call, however many there are (more than a page of 500)', async () => {
    // Arrange
    const { board, reads } = boardOf(cardsOf(1203));

    // Act
    const read = await boardReader(board, nobodyIsAHelper).read();

    // Assert
    expect(read?.views.map(view => view.id)).toEqual(cardsOf(1203).map(view => view.id));
    expect(reads).toEqual(['orphanedCards']);
  });

  test('a card that leaves or joins the orphaned set between reads cannot make the read skip or repeat another', async () => {
    // Arrange: a board that changes after every read it answers (a ferret picks up the first card; a new card is orphaned)
    let orphaned = cardsOf(600);
    const board: BoardApi = {
      ...fakeBoard(),
      orphanedCards: async () => {
        const snapshot = { cards: orphaned, laneSets: [lanes(PROJECT)] };
        orphaned = [...cardsOf(1, 1000), ...orphaned.slice(1)];
        return snapshot;
      },
      cardsPage: async () => {
        throw new Error('paging is what skipped and repeated cards');
      },
    };

    // Act
    const read = await boardReader(board, nobodyIsAHelper).read();

    // Assert: exactly the snapshot, each card once
    const ids = read?.views.map(view => view.id) ?? [];
    expect(ids).toEqual(cardsOf(600).map(view => view.id));
    expect(new Set(ids).size).toBe(600);
  });

  test('names each lane from the snapshot’s lane sets, by project', async () => {
    // Arrange
    const { board } = boardOf(cardsOf(1));

    // Act
    const read = await boardReader(board, nobodyIsAHelper).read();

    // Assert
    expect(read?.laneSets.get(PROJECT)?.lanes.find(lane => lane.id === 'implement')?.name).toBe('Implement');
  });

  test('a read that fails is not a read: the sweep must not take the unseen cards as recovered', async () => {
    // Arrange
    const board: BoardApi = {
      ...fakeBoard(),
      orphanedCards: async () => {
        throw new Error('the board went away');
      },
    };

    // Act / Assert
    await expect(boardReader(board, nobodyIsAHelper).read()).rejects.toThrow('the board went away');
  });

  test('a ferret’s focus card comes with the lane set that came back with it, and a helper is marked', async () => {
    // Arrange
    const card = cardView({ id: 'F7', owner: 'lead', assignee: 'worker' });
    const focus: FocusCard = { card, laneSet: lanes(PROJECT) };
    const { board, reads } = boardOf([], { focus: { worker: focus, lead: focus } });
    const reader = boardReader(board, { isHelper: async ferret => ferret === 'worker' });

    // Act
    const lead = await reader.focusCard('lead');
    const worker = await reader.focusCard('worker');

    // Assert
    expect(lead?.task.id).toBe('F7');
    expect(lead?.laneSet?.projectId).toBe(PROJECT);
    expect(lead).not.toHaveProperty('subFerret');
    expect(worker?.subFerret).toBe(true);
    expect(reads).toEqual([]);
  });

  test('a focus card whose board has no lane set carries none', async () => {
    // Arrange
    const card = cardView({ id: 'F7', owner: 'lead', assignee: 'worker' });
    const { board } = boardOf([], { focus: { lead: { card, laneSet: null } } });

    // Act
    const lead = await boardReader(board, nobodyIsAHelper).focusCard('lead');

    // Assert
    expect(lead?.laneSet).toBeNull();
  });

  test('a ferret with no focus card gets none', async () => {
    // Arrange
    const { board } = boardOf([]);

    // Act / Assert
    expect(await boardReader(board, nobodyIsAHelper).focusCard('nobody' as FerretId)).toBeUndefined();
  });
});
