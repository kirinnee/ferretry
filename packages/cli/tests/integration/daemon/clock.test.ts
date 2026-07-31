import { describe, it } from 'bun:test';
import should from 'should';
import { SystemClock } from '../../../src/adapters/daemon/clock';

describe('system clock', () => {
  it('should report real wall-clock milliseconds', () => {
    // Arrange
    const subject = new SystemClock();
    const before = Date.now();

    // Act
    const actual = subject.now();

    // Assert
    should(actual).be.aboveOrEqual(before);
    should(actual).be.belowOrEqual(Date.now());
  });

  it('should actually wait, so a poll loop does not spin the CPU', async () => {
    // Arrange
    const subject = new SystemClock();
    const before = subject.now();

    // Act
    await subject.sleep(30);

    // Assert
    should(subject.now() - before).be.aboveOrEqual(25);
  });
});
