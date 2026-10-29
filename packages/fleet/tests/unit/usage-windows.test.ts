import { describe, it } from 'bun:test';
import should from 'should';
import type { FleetManifest } from '../../src/lib/manifest.ts';
import { type FleetUsageClock, FleetUsageCollector, renderFleetUsageMetrics } from '../../src/lib/usage.ts';

const clock: FleetUsageClock = { now: () => 1_700_000_000_000 };

const manifest = (accounts: readonly Record<string, unknown>[]): FleetManifest =>
  ({ accounts }) as unknown as FleetManifest;

const account = (id: string): Record<string, unknown> => ({
  id,
  kind: 'claude',
  mode: 'auto',
  wrapper: `claude-auto-${id}`,
  home: `/tmp/${id}`,
  displayName: id,
  defaultModel: 'opus',
  models: [{ id: 'opus', available: true }],
  available: true,
});

describe('fleet usage metrics for the long quota window', () => {
  it('should publish the weekly percentage and reset time next to the short window', () => {
    // Arrange
    const snapshot = {
      at: 1_700_000_000_000,
      accounts: [
        {
          accountId: 'a',
          kind: 'claude',
          usageBased: true,
          ok: true,
          unavailable: false,
          atLimit: false,
          shortWindow: { usedPercent: 10, resetAt: 1_700_000_100_999 },
          longWindow: { usedPercent: 42, resetAt: 1_700_600_000_999 },
        },
      ],
    };

    // Act
    const actual = renderFleetUsageMetrics(snapshot, 1_700_000_005_000);

    // Assert
    const labels = 'account_id="a",kind="claude"';
    should(actual).containEql('fy_fleet_usage_probe_age_seconds 5');
    should(actual).containEql(`fy_fleet_account_usage_5h_percent{${labels}} 10`);
    should(actual).containEql(`fy_fleet_account_usage_5h_reset_seconds{${labels}} 1700000100`);
    should(actual).containEql(`fy_fleet_account_usage_weekly_percent{${labels}} 42`);
    should(actual).containEql(`fy_fleet_account_usage_weekly_reset_seconds{${labels}} 1700600000`);
  });

  it('should publish a long window that carries only a reset time without inventing a percentage', () => {
    // Arrange
    const snapshot = {
      at: 1,
      accounts: [
        {
          accountId: 'a',
          kind: 'claude',
          usageBased: true,
          ok: true,
          unavailable: false,
          atLimit: false,
          longWindow: { resetAt: 2_000_000 },
        },
      ],
    };

    // Act
    const actual = renderFleetUsageMetrics(snapshot, 1_000);

    // Assert
    should(actual).containEql('fy_fleet_account_usage_weekly_reset_seconds{account_id="a",kind="claude"} 2000');
    should(actual).not.containEql('usage_weekly_percent{');
    should(actual).not.containEql('usage_5h_percent{');
    should(actual).not.containEql('usage_5h_reset_seconds{');
  });
});

describe('fleet usage windows a probe could not read', () => {
  it('should drop a window that carries neither a percentage nor a reset, keeping the usable one', async () => {
    // Arrange
    const collector = new FleetUsageCollector(
      {
        probe: async () => ({
          usageBased: true,
          ok: true,
          shortWindow: {},
          longWindow: { usedPercent: 30 },
        }),
      },
      clock,
    );

    // Act
    const actual = await collector.collect(manifest([account('a')]));

    // Assert
    const [row] = actual.accounts;
    should(row).not.have.property('shortWindow');
    should(row?.longWindow).deepEqual({ usedPercent: 30 });
    should(row?.atLimit).equal(false);
  });
});
