import { describe, it } from 'bun:test';
import should from 'should';
import { IntlLocalTime } from '../../../src/adapters/passkey/local-time';

describe('local clock time adapter', () => {
  it('should read an instant as HH:MM on this machine, 24-hour, zero padded', () => {
    // Arrange — the expectation is built from the same instant on the same machine, so the runner's zone
    // moves both sides together and only the FORMAT is under test.
    const instant = new Date(2026, 9, 13, 9, 5, 0);

    // Act
    const actual = new IntlLocalTime().clockTime(instant.toISOString());

    // Assert
    should(actual).equal('09:05');
  });

  it('should keep the afternoon on a 24-hour clock', () => {
    // Arrange
    const instant = new Date(2026, 9, 13, 14, 32, 59);

    // Act + Assert
    should(new IntlLocalTime().clockTime(instant.toISOString())).equal('14:32');
  });

  it('should read midnight as 00:00, not 24:00', () => {
    // Arrange
    const instant = new Date(2026, 9, 13, 0, 0, 0);

    // Act + Assert
    should(new IntlLocalTime().clockTime(instant.toISOString())).equal('00:00');
  });
});
