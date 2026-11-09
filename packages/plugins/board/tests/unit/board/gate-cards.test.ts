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
