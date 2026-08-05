import { describe, it } from 'bun:test';
import should from 'should';
import { SystemFleetClock } from '../../../src/adapters/fleet/clock';
import { SystemUsageClock } from '../../../src/adapters/fleet/usage-probe';

describe('the fleet clocks', () => {
  it('should stamp a usage snapshot with epoch milliseconds', () => {
    // Act
    const now = new SystemUsageClock().now();

    // Assert
    should(now).be.a.Number();
    should(Number.isInteger(now)).be.true();
    should(now).be.above(1_700_000_000_000);
  });

  it('should stamp a plan with an ISO-8601 instant', () => {
    // Act
    const now = new SystemFleetClock().now();

    // Assert
    should(now).match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
    should(Date.parse(now)).not.be.NaN();
  });
});
