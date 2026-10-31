import { describe, it } from 'bun:test';
import should from 'should';
import { MemberSweepTimer, systemSweepClock } from '../../../src/adapters/catalog-members/index.ts';

/**
 * The real interval behind the member sweep: it fires until it is stopped and then fires no more. Every wait
 * is on a condition (the callback ran), never on a fixed sleep.
 */

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('the condition was not met in time');
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

describe('the member sweep timer on the real clock', () => {
  it('should sweep repeatedly until the returned stopper is called', async () => {
    // Arrange
    let swept = 0;
    const timer = new MemberSweepTimer(
      systemSweepClock,
      async () => {
        swept += 1;
      },
      () => {},
    );

    // Act
    const stop = timer.start(5);
    await until(() => swept >= 2);
    stop();
    const atStop = swept;
    await new Promise<void>(resolve => setImmediate(resolve));

    // Assert
    should(atStop).be.aboveOrEqual(2);
    should(swept - atStop).be.belowOrEqual(1);
  });

  it('should report a sweep that fails and keep the timer running', async () => {
    // Arrange
    const reported: unknown[] = [];
    let attempts = 0;
    const timer = new MemberSweepTimer(
      systemSweepClock,
      async () => {
        attempts += 1;
        throw new Error('store unwritable');
      },
      error => reported.push(error),
    );

    // Act
    const stop = timer.start(5);
    await until(() => reported.length >= 2);
    stop();

    // Assert
    should(attempts).be.aboveOrEqual(2);
    should((reported[0] as Error).message).equal('store unwritable');
  });
});
