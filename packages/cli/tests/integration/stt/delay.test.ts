import { describe, it } from 'bun:test';
import should from 'should';
import { TimerDelay } from '../../../src/adapters/stt/delay';

describe('the install poll delay', () => {
  it('should actually spend the wall-clock time it was asked for', async () => {
    // Arrange
    const started = performance.now();

    // Act
    await new TimerDelay().wait(25);

    // Assert — timers may fire late but never early
    should(performance.now() - started).be.aboveOrEqual(20);
  });

  it('should resolve immediately for a zero wait', async () => {
    // Arrange
    const started = performance.now();

    // Act
    await new TimerDelay().wait(0);

    // Assert
    should(performance.now() - started).be.below(200);
  });
});
