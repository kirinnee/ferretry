import { describe, it } from 'bun:test';
import should from 'should';
import { systemFleetUsageClock } from '../../src/adapters/system-clock.ts';

describe('systemFleetUsageClock', () => {
  it('should report the current instant in epoch milliseconds', () => {
    // Arrange
    const before = Date.now();

    // Act
    const actual = systemFleetUsageClock.now();

    // Assert
    should(actual).be.aboveOrEqual(before);
    should(actual).be.belowOrEqual(Date.now());
  });

  it('should not go backwards between reads', () => {
    // Act
    const first = systemFleetUsageClock.now();
    const second = systemFleetUsageClock.now();

    // Assert
    should(second).be.aboveOrEqual(first);
  });
});
