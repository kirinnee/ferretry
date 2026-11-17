import { describe, it } from 'bun:test';
import should from 'should';
import { BoardService, gateCardsOf, stillBuilding, BoardIndex } from '../../../daemon/lib/board/index.ts';
import { card, MACHINE, MemoryBoardStore, world } from './support.ts';

const COUNT = 50;
const fixture = () =>
  Array.from({ length: COUNT }, (_, i) =>
    card({
      id: `F${i + 1}`,
      dependsOn: i > 0 && i % 5 === 0 ? [{ task: { id: `F${i}` }, until: 'shipped' as const }] : [],
      parent: i % 7 === 0 && i > 0 ? { id: 'F1' } : null,
    }),
  );

describe('the gate card list', () => {
  it('should derive the board once for 50 cards and match the per-card path', async () => {
    // Arrange
    const store = new MemoryBoardStore(fixture());
    const service = new BoardService(world({ store }));
    const counts = { names: 0, audience: 0, blocked: 0 };

    // Act: the single pass, with every per-card port counted
    const { views, laneSets } = await service.sweepBoard();
    const snapshot = await service.snapshot();
    const passed = await gateCardsOf({
      views,
      cards: snapshot.cards,
      laneSets,
      machineId: MACHINE,
      projectName: async () => {
        counts.names += 1;
        return 'Board';
      },
      audienceOf: async stored => {
        counts.audience += 1;
        return await service.audienceOf(stored);
      },
      blockedByOf: async stored => {
        counts.blocked += 1;
        return (await service.card(stored.id)).card.blockedBy;
      },
    });

    // Assert: one project name, no per-card derivation, and the same cards the per-card path builds
    should(counts.names).equal(1);
    should(counts.blocked).equal(0);
    should(passed).have.length(COUNT);
    const index = new BoardIndex(snapshot.cards, MACHINE);
    for (const entry of passed) {
      const response = await service.card(entry.task.id);
      should(entry.laneSet).eql(response.laneSet);
      should(entry.blockedBy).eql(response.card.blockedBy);
      should(entry.building).equal(stillBuilding(entry.task, index, snapshot.laneSets));
    }
  });

  it('should read Asks once, ask for one project name and derive no card on its own for 3000 cards', async () => {
    // Arrange: 3000 cards over 30 projects, with the Asks link counted (one call is one whole-board read of every ledger)
    const cards = Array.from({ length: 3000 }, (_, i) => card({ id: `F${i + 1}`, projectId: `p${i % 30}` as never }));
    const calls = { asks: 0, names: 0, blocked: 0 };
    const store = new MemoryBoardStore(cards);
    const service = new BoardService(
      world({
        store,
        asks: {
          asksFor: async () => {
            calls.asks += 1;
            return new Map();
          },
        },
      }),
    );

    // Act
    const { views, laneSets } = await service.sweepBoard();
    const snapshot = await service.snapshot();
    const passed = await gateCardsOf({
      views,
      cards: snapshot.cards,
      laneSets,
      machineId: MACHINE,
      projectName: async () => {
        calls.names += 1;
        return 'Board';
      },
      audienceOf: async stored => await service.audienceOf(stored),
      blockedByOf: async () => {
        calls.blocked += 1;
        return [];
      },
    });

    // Assert: O(cards) work, one derivation: not one whole-board read per card
    should(passed).have.length(3000);
    should(calls.asks).equal(1);
    should(calls.names).equal(30);
    should(calls.blocked).equal(0);
  });

  it('should derive a card the sweep has no view for on its own', async () => {
    // Arrange
    const store = new MemoryBoardStore(fixture());
    const service = new BoardService(world({ store }));
    const snapshot = await service.snapshot();
    let blocked = 0;

    // Act
    const passed = await gateCardsOf({
      views: [],
      cards: snapshot.cards,
      laneSets: snapshot.laneSets,
      machineId: MACHINE,
      projectName: async () => undefined,
      audienceOf: async stored => await service.audienceOf(stored),
      blockedByOf: async () => {
        blocked += 1;
        return [];
      },
    });

    // Assert
    should(blocked).equal(COUNT);
    should(passed).have.length(COUNT);
  });
});
