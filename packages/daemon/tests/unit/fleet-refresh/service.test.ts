import { describe, it } from 'bun:test';
import should from 'should';
import { FleetRefreshService } from '../../../src/lib/fleet-refresh/index.ts';

/**
 * The invariant these tests exist for is NEGATIVE: an unattended pass must reach nothing that spends.
 *
 * The first test here used to assert `['health', 'usage']` — it pinned the billable health probe as
 * expected behaviour, so the suite was green the whole time the daemon was launching a wrapper and
 * spending a real turn per account on its timer. A test that pins a defect is worse than no test,
 * because it makes the fix read as the regression. It now asserts what the pass may touch, and the
 * type no longer offers anything else.
 */
describe('the fleet refresh loop', () => {
  it('should refresh the usage feed and reach nothing that spends', async () => {
    // Arrange
    const calls: string[] = [];
    const service = new FleetRefreshService({
      usage: {
        accounts: async () => {
          calls.push('usage');
          return [];
        },
        snapshotAt: () => undefined,
        hasSnapshot: () => false,
      },
    });

    // Act
    await service.run();

    // Assert — the whole set, not a membership check: a second collector appearing here is the defect.
    should(calls).deepEqual(['usage']);
  });

  it('should retain the next scheduled pass after the established feed fails', async () => {
    // Arrange
    let attempts = 0;
    const service = new FleetRefreshService({
      usage: {
        accounts: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('collector unavailable');
          return [];
        },
        snapshotAt: () => undefined,
        hasSnapshot: () => false,
      },
    });

    // Act
    await service.run();
    await service.run();

    // Assert — this loop has no failure-triggered retry of its own; the daemon timer owns cadence.
    should(attempts).equal(2);
  });

  it('should serialize overlapping ticks so a slow collector cannot be doubled by the timer', async () => {
    // Arrange
    const release = Promise.withResolvers<void>();
    let active = 0;
    let peak = 0;
    const service = new FleetRefreshService({
      usage: {
        accounts: async () => {
          active += 1;
          peak = Math.max(peak, active);
          await release.promise;
          active -= 1;
          return [];
        },
        snapshotAt: () => undefined,
        hasSnapshot: () => false,
      },
    });

    // Act
    const first = service.run();
    const second = service.run();
    await Promise.resolve();
    release.resolve();
    await Promise.all([first, second]);

    // Assert
    should(peak).equal(1);
  });
});
