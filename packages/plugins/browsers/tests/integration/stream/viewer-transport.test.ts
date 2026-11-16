import { describe, it } from 'bun:test';
import should from 'should';
import { KernelFrameClock } from '../../../daemon/stream/frame-clock.ts';
import { wallClock } from '../../support/wall-clock.ts';
import { waitFor } from '../../support/wait-for.ts';

describe('system frame clock', () => {
  it('should report wall-clock time and fire a scheduled callback', async () => {
    // Arrange
    const clock = new KernelFrameClock(wallClock());
    const before = Date.now();
    let fired = 0;

    // Act
    const elapsed = clock.now() - before;
    clock.schedule(() => {
      fired += 1;
    }, 5);
    await waitFor(() => fired > 0, 'the scheduled callback to fire');

    // Assert
    should(elapsed).be.aboveOrEqual(0);
    should(fired).equal(1);
  });

  it('should not fire a cancelled timer', async () => {
    // Arrange
    const clock = new KernelFrameClock(wallClock());
    let fired = 0;
    let sentinel = false;

    // Act — timers of one delay fire in the order they were set, so once a later one has fired the
    // cancelled one would have.
    clock
      .schedule(() => {
        fired += 1;
      }, 5)
      .cancel();
    clock.schedule(() => {
      sentinel = true;
    }, 5);
    await waitFor(() => sentinel, 'the later timer to fire');

    // Assert
    should(fired).equal(0);
  });
});
