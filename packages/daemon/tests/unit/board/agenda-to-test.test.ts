import { describe, it } from 'bun:test';
import should from 'should';
import { AgendaToTestLanes } from '../../../src/lib/board/index.ts';
import { card, lanes } from './support.ts';

const MACHINE = 'machine-1';
const laneSet = lanes();

const readerOf = (cards: Readonly<Record<string, ReturnType<typeof card> | 'broken'>>) => async (id: string) => {
  const found = cards[id];
  if (found === 'broken') throw new Error('board unreadable');
  return found === undefined ? undefined : { task: found, laneSet };
};

describe('AgendaToTestLanes', () => {
  const reads = new AgendaToTestLanes(
    readerOf({
      F1: card({ id: 'F1', laneId: 'released' }),
      F2: card({ id: 'F2', laneId: 'implement' }),
      F3: 'broken',
    }),
    () => MACHINE,
  );

  it('should be true only for a card in the lane a release enters', async () => {
    // Act
    const results = [
      await reads.inToTest({ id: 'F1' }),
      await reads.inToTest({ id: 'F1', machineId: MACHINE }),
      await reads.inToTest({ id: 'F2' }),
    ];

    // Assert
    should(results).deepEqual([true, true, false]);
  });

  it('should be false for a foreign machine, an unknown card, a broken board and a board with no lanes', async () => {
    // Arrange
    const unlaned = new AgendaToTestLanes(
      async id => ({ task: card({ id, laneId: 'released' }), laneSet: null }),
      () => MACHINE,
    );

    // Act
    const results = [
      await reads.inToTest({ id: 'F1', machineId: 'machine-2' }),
      await reads.inToTest({ id: 'F9' }),
      await reads.inToTest({ id: 'F3' }),
      await unlaned.inToTest({ id: 'F1' }),
    ];

    // Assert
    should(results).deepEqual([false, false, false, false]);
  });
});
