import { describe, it } from 'bun:test';
import type { FleetCredentialUsage, ProviderQuotaReading } from '@ferretry/protocol';
import should from 'should';
import { providerAccountFields, withProviderQuota } from '../../../../src/lib/usage/provider-quota/account.ts';

const AT = '2026-10-16T09:00:00.000Z';
const RESET = '2026-10-16T11:00:00.000Z';

const reading = (overrides: Partial<ProviderQuotaReading> = {}): ProviderQuotaReading => ({
  source: 'zai-coding-plan',
  via: 'endpoint',
  windows: [
    { label: '5h', usedPercent: 120, resetsAt: RESET },
    { label: 'week', usedPercent: 30 },
  ],
  exhausted: true,
  unverified: true,
  at: AT,
  ...overrides,
});

describe('withProviderQuota', () => {
  it('should fill an unmeasured row from the reading, and only add it to a measured one', () => {
    // Arrange
    const unmeasured: FleetCredentialUsage = { fiveHour: {}, weekly: {} };
    const measured: FleetCredentialUsage = { fiveHour: { usedPercent: 5 }, weekly: {}, source: 'claude-statusline' };

    // Act & Assert
    should(withProviderQuota(unmeasured, undefined)).equal(unmeasured);
    should(withProviderQuota(unmeasured, reading())).deepEqual({
      fiveHour: { usedPercent: 120, resetsAt: RESET },
      weekly: { usedPercent: 30 },
      source: 'provider-quota',
      at: AT,
      provider: reading(),
    });
    should(withProviderQuota(measured, reading())).deepEqual({ ...measured, provider: reading() });
  });

  it('should claim no source for a reading the provider did not give', () => {
    // Arrange
    const spent = reading({ via: 'transcript', windows: [], exhausted: false });

    // Act
    const actual = withProviderQuota({ fiveHour: {}, weekly: {} }, spent);

    // Assert
    should(actual).deepEqual({ fiveHour: {}, weekly: {}, at: AT, provider: spent });
  });
});

describe('providerAccountFields', () => {
  it('should state the windows, at-limit, balance and spend the reading states, capped at 100', () => {
    // Act
    const actual = providerAccountFields(
      reading({
        balance: { amount: 3, currency: 'USD' },
        spend: { amountUsd: 1.5, since: AT, sessions: 1, unpriced: 0 },
      }),
    );

    // Assert
    should(actual).deepEqual({
      fiveHourPercent: 100,
      weeklyPercent: 30,
      fiveHourResetAt: Date.parse(RESET),
      atLimit: true,
      balance: { amount: 3, currency: 'USD' },
      spendUsd: 1.5,
    });
  });

  it('should state nothing a transcript reading cannot know', () => {
    // Act & Assert
    should(providerAccountFields(reading({ via: 'unknown', windows: [], exhausted: false }))).deepEqual({});
  });
});
