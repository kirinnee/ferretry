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

  it('should observe the account model’s credentials on the same pass, and survive their failure', async () => {
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
      credentials: {
        observeAll: async () => {
          calls.push('credentials');
          throw new Error('a probe failed');
        },
      },
    });

    // Act — the pass resolves although the credentials observation rejected.
    await service.run();
    await service.run();

    // Assert — free reads only: the usage feed and the credentials' observation, nothing else.
    should(calls).deepEqual(['usage', 'credentials', 'usage', 'credentials']);
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

  it('should observe only the credentials its schedule says are due, then tell it they were observed', async () => {
    // Arrange
    const observed: (readonly string[] | undefined)[] = [];
    const told: (readonly string[])[] = [];
    const service = new FleetRefreshService({
      usage: { accounts: async () => [], snapshotAt: () => undefined, hasSnapshot: () => false },
      credentials: {
        observeAll: async ids => {
          observed.push(ids);
        },
      },
      schedule: {
        start: async () => undefined,
        due: () => ['idle-login'],
        observed: ids => told.push(ids),
        close: () => undefined,
      },
    });

    // Act
    await service.run();

    // Assert — the login whose session is writing passive readings is not read at all.
    should(observed).deepEqual([['idle-login']]);
    should(told).deepEqual([['idle-login']]);
  });

  it('should arm its schedule, and close it with what arming answered', async () => {
    // Arrange
    const events: string[] = [];
    const service = new FleetRefreshService({
      usage: { accounts: async () => [], snapshotAt: () => undefined, hasSnapshot: () => false },
      schedule: {
        start: async due => {
          events.push('start');
          due();
        },
        due: () => [],
        observed: () => undefined,
        close: () => events.push('close'),
      },
    });

    // Act
    const stop = await service.arm(() => events.push('due'));
    stop();

    // Assert
    should(events).deepEqual(['start', 'due', 'close']);
  });

  it('should arm nothing without a schedule', async () => {
    // Arrange
    const due: string[] = [];
    const service = new FleetRefreshService({
      usage: { accounts: async () => [], snapshotAt: () => undefined, hasSnapshot: () => false },
    });

    // Act
    const stop = await service.arm(() => due.push('due'));
    stop();

    // Assert
    should(due).deepEqual([]);
  });
});
