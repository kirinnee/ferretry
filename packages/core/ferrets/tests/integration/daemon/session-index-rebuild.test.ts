/**
 * `DaemonStorage.rebuildIndexYielding` over the real SQL index (BG-049): what the boot job `ferrets.index-rebuild` runs
 * when the cache file was lost. The unit tier proves the bounds (yields, lanes, stop); this tier runs every line of the
 * adapter against the real `StateSqliteIndex` and a state port.
 */
import { describe, it } from 'bun:test';
import type { StatePort } from '@ferretry/kernel/contract';
import should from 'should';
import {
  emptyCache,
  generatedFleet,
  restartWithCacheLost,
  sessionIdAt,
} from '../../support/daemon/index-rebuild-world.ts';
import { memoryStorage, RecordingLog } from '../../support/daemon/storage.ts';

const noYield = async (): Promise<void> => {};

describe('the session index rebuilt in slices', () => {
  it('should list every session again after the cache file was lost, an equal index to the one before', async () => {
    // Arrange
    const before = await generatedFleet(12);
    const listed = before.storage.listSessions();
    const lost = await restartWithCacheLost(before);
    should(lost.storage.listSessions()).deepEqual([]);

    // Act
    const result = await lost.storage.rebuildIndexYielding({ sliceSize: 5, yieldToLoop: noYield });

    // Assert
    should(result).deepEqual({
      surveyed: 12,
      missing: 12,
      rebuilt: 12,
      slices: 3,
      complete: true,
      failedSessionIds: [],
    });
    should(lost.storage.listSessions()).deepEqual(listed);
  });

  it('should take one session per slice when the slice size is nonsense', async () => {
    // Arrange
    const lost = await restartWithCacheLost(await generatedFleet(3));

    // Act
    const result = await lost.storage.rebuildIndexYielding({ sliceSize: 0, yieldToLoop: noYield });

    // Assert
    should(result.slices).equal(3);
    should(result.rebuilt).equal(3);
  });

  it('should do nothing when the index already holds every session', async () => {
    // Arrange
    const world = await generatedFleet(4);
    let yields = 0;

    // Act
    const result = await world.storage.rebuildIndexYielding({
      sliceSize: 2,
      yieldToLoop: async () => {
        yields += 1;
      },
    });

    // Assert
    should(result).deepEqual({ surveyed: 4, missing: 0, rebuilt: 0, slices: 0, complete: true, failedSessionIds: [] });
    should(yields).equal(0);
  });

  it('should stop between sessions once the daemon stops, and finish on the next call', async () => {
    // Arrange
    const lost = await restartWithCacheLost(await generatedFleet(6));
    const stop = new AbortController();

    // Act
    const stopped = await lost.storage.rebuildIndexYielding({
      sliceSize: 2,
      signal: stop.signal,
      yieldToLoop: async () => stop.abort(),
    });
    const before = stopped.rebuilt;
    const finished = await lost.storage.rebuildIndexYielding({ sliceSize: 2, yieldToLoop: noYield });

    // Assert
    should(stopped.complete).be.false();
    should(before).equal(2);
    should(finished.complete).be.true();
    should(finished.rebuilt).equal(4);
    should(lost.storage.listSessions()).have.length(6);
  });

  it('should name a session whose files cannot be read, warn once for it, and index the others', async () => {
    // Arrange
    const world = await generatedFleet(5);
    const broken = sessionIdAt(2);
    await world.storage.close();
    const log = new RecordingLog();
    const failing = (state: StatePort): StatePort => ({
      ...state,
      read: async (file, name) => {
        if (name === broken) throw new Error('cannot read this session');
        return await state.read(file, name);
      },
    });
    const lost = await memoryStorage({
      folder: world.folder,
      index: emptyCache,
      log,
      wrapState: failing,
    });

    // Act
    const result = await lost.storage.rebuildIndexYielding({ sliceSize: 10, yieldToLoop: noYield });

    // Assert
    should(result.failedSessionIds).deepEqual([broken]);
    should(result.rebuilt).equal(4);
    should(result.complete).be.true();
    should(log.lines.filter(line => line.level === 'warn')).have.length(1);
    should(lost.storage.findSession(broken)).be.undefined();
  });
});
