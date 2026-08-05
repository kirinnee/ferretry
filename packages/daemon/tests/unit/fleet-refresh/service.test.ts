import { describe, it } from 'bun:test';
import should from 'should';
import { FleetRefreshService } from '../../../src/lib/fleet-refresh/index.ts';

describe('the fleet refresh loop', () => {
  it('should refresh the existing usage and health feeds together', async () => {
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
      fleet: {
        health: async () => {
          calls.push('health');
          return {};
        },
      },
    });

    // Act
    await service.run();

    // Assert
    should(calls.sort()).deepEqual(['health', 'usage']);
  });

  it('should retain the next scheduled pass after either established feed fails', async () => {
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
      fleet: { health: async () => ({}) },
    });

    // Act
    await service.run();
    await service.run();

    // Assert — this loop has no failure-triggered retry of its own; the daemon timer owns cadence.
    should(attempts).equal(2);
  });

  it('should serialize overlapping ticks so a costly collector cannot be doubled by the timer', async () => {
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
      fleet: { health: async () => ({}) },
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
