import { describe, it } from 'bun:test';
import should from 'should';
import { DEFAULT_READ_CONCURRENCY, mapWithConcurrency } from '../../../src/adapters/warden/index.ts';

/** Resolves only once released, so a test can hold every worker open at once. */
function gate(): { wait: () => Promise<void>; release: () => void } {
  let release = (): void => {};
  const opened = new Promise<void>(resolve => {
    release = resolve;
  });
  return { wait: () => opened, release };
}

describe('bounded fan-out', () => {
  it('should keep the results in input order', async () => {
    // Arrange
    const items = [3, 1, 2];

    // Act
    const results = await mapWithConcurrency(items, async value => {
      await Bun.sleep(value);
      return value * 10;
    });

    // Assert
    should(results).eql([30, 10, 20]);
  });

  it('should never run more than the limit at once', async () => {
    // Arrange
    const items = Array.from({ length: 20 }, (_unused, index) => index);
    let running = 0;
    let peak = 0;

    // Act
    await mapWithConcurrency(
      items,
      async () => {
        running += 1;
        peak = Math.max(peak, running);
        await Bun.sleep(1);
        running -= 1;
      },
      4,
    );

    // Assert
    should(peak).eql(4);
  });

  it('should not stall when there is less work than the limit', async () => {
    // Arrange
    const opened = gate();
    let started = 0;

    // Act — both workers must be running before either is released.
    const pending = mapWithConcurrency(
      [1, 2],
      async value => {
        started += 1;
        await opened.wait();
        return value;
      },
      8,
    );
    while (started < 2) await Bun.sleep(1);
    opened.release();

    // Assert
    should(await pending).eql([1, 2]);
  });

  it('should complete an empty batch without running anything', async () => {
    // Arrange
    let calls = 0;

    // Act
    const results = await mapWithConcurrency([], async () => {
      calls += 1;
    });

    // Assert
    should(results).be.empty();
    should(calls).eql(0);
  });

  it.each([
    { label: 'zero', limit: 0 },
    { label: 'a negative number', limit: -4 },
  ])('should clamp a limit of $label to a single worker rather than stalling', async ({ limit }) => {
    // Arrange
    const items = [1, 2, 3];

    // Act
    const results = await mapWithConcurrency(items, async value => value * 2, limit);

    // Assert
    should(results).eql([2, 4, 6]);
  });

  it('should default to a bound that keeps the descriptor table sane', () => {
    // Arrange / Act / Assert
    should(DEFAULT_READ_CONCURRENCY).be.above(0);
    should(DEFAULT_READ_CONCURRENCY).be.belowOrEqual(64);
  });
});
