import { describe, it } from 'bun:test';
import type { FleetManifestAccount } from '@ferretry/fleet';
import should from 'should';
import { SystemFleetClock } from '../../../src/adapters/fleet/clock';
import { SystemUsageClock, UnprovisionedUsageProbe } from '../../../src/adapters/fleet/usage-probe';

const ACCOUNT = {
  id: '00000000-0000-4000-8000-00000000c1a0',
  kind: 'claude',
  mode: 'auto',
  wrapper: 'fy-claude-work',
  home: '/state/fleet/homes/work',
  displayName: 'Claude (work)',
  defaultModel: 'opus',
  models: [{ id: 'opus', available: true }],
  available: true,
  unavailableReason: null,
} as FleetManifestAccount;

describe('the unprovisioned quota probe', () => {
  it('should report the absence of a probe rather than a fabricated zero', async () => {
    // Act
    const actual = await new UnprovisionedUsageProbe().probe(ACCOUNT);

    // Assert
    should(actual).eql({
      usageBased: false,
      ok: false,
      unavailable: true,
      unavailableReason: UnprovisionedUsageProbe.REASON,
    });
  });

  it('should answer the same for every account, since nothing about one changes the answer', async () => {
    // Act
    const other = await new UnprovisionedUsageProbe().probe({ ...ACCOUNT, kind: 'codex' } as FleetManifestAccount);

    // Assert
    should(other.unavailable).be.true();
  });
});

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
