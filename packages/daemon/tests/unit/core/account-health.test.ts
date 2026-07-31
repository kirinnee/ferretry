import type { AccountUsage } from '@ferretry/protocol';
import { describe, it } from 'bun:test';
import should from 'should';
import {
  confirmedUsableAccount,
  spentPercent,
  unusableAccountReason,
  usageForAgent,
} from '../../../src/lib/core/index.ts';
import { usableAccount } from '../../../src/lib/core/account-health.ts';

const usage = (overrides: Partial<AccountUsage> = {}): AccountUsage => ({ agent: 'agent-primary', ...overrides });

describe('spentPercent', () => {
  it('should report the tighter of the two windows', () => {
    // Arrange / Act / Assert
    should(spentPercent(usage({ fiveHourPercent: 20, weeklyPercent: 75 }))).equal(75);
  });

  it('should report one window when only one is known', () => {
    // Arrange / Act / Assert
    should(spentPercent(usage({ fiveHourPercent: 20 }))).equal(20);
  });

  it('should say nothing rather than zero when no window is known', () => {
    // Arrange — the source answered 0, which made an unmeasured account look emptiest of all
    should(spentPercent(usage())).be.undefined();
  });

  it('should say nothing for an account with no feed row at all', () => {
    // Arrange / Act / Assert
    should(spentPercent(undefined)).be.undefined();
  });

  it('should say nothing when the probe itself failed', () => {
    // Arrange / Act / Assert
    should(spentPercent(usage({ ok: false, fiveHourPercent: 20 }))).be.undefined();
  });
});

describe('usableAccount', () => {
  it.each([
    { label: 'no evidence at all', row: undefined, expected: true },
    { label: 'a healthy row', row: usage({ atLimit: false, authOk: true }), expected: true },
    { label: 'an unavailable provider', row: usage({ unavailable: true }), expected: false },
    { label: 'an account at its limit', row: usage({ atLimit: true }), expected: false },
    { label: 'rejected credentials', row: usage({ authOk: false }), expected: false },
  ])('should answer $expected for $label', ({ row, expected }) => {
    // Arrange / Act / Assert
    should(usableAccount(row)).equal(expected);
  });
});

describe('confirmedUsableAccount', () => {
  it('should require positively confirmed headroom', () => {
    // Arrange / Act / Assert
    should(confirmedUsableAccount(usage({ atLimit: false }))).be.true();
  });

  it.each([
    { label: 'no row at all', row: undefined },
    { label: 'an unknown limit', row: usage({ authOk: true }) },
    { label: 'a failed probe', row: usage({ ok: false, atLimit: false }) },
    { label: 'an unavailable provider', row: usage({ unavailable: true, atLimit: false }) },
    { label: 'rejected credentials', row: usage({ authOk: false, atLimit: false }) },
  ])('should refuse unattended failover onto $label', ({ row }) => {
    // Arrange / Act / Assert
    should(confirmedUsableAccount(row)).be.false();
  });
});

describe('unusableAccountReason', () => {
  it('should say nothing while the account can take work', () => {
    // Arrange / Act / Assert
    should(unusableAccountReason(usage({ atLimit: false }))).be.undefined();
  });

  it('should say nothing when there is no evidence either way', () => {
    // Arrange / Act / Assert
    should(unusableAccountReason(undefined)).be.undefined();
  });

  it('should name an authentication failure first', () => {
    // Arrange / Act / Assert
    should(unusableAccountReason(usage({ authOk: false, atLimit: true }))).equal('the account is not authenticated');
  });

  it('should explain an unavailable provider in the same words the quota surface uses', () => {
    // Arrange / Act
    const reason = unusableAccountReason(usage({ unavailable: true, unavailableReason: 'cooldown' }));

    // Assert
    should(reason).equal('every provider credential is cooling down');
  });

  it('should report an account that is simply spent', () => {
    // Arrange / Act / Assert
    should(unusableAccountReason(usage({ atLimit: true }))).equal('the account is at its usage limit');
  });
});

describe('usageForAgent', () => {
  it('should find the row for an executable name', () => {
    // Arrange
    const rows = [usage({ agent: 'agent-a' }), usage({ agent: 'agent-b', atLimit: true })];

    // Act / Assert
    should(usageForAgent(rows, 'agent-b')?.atLimit).be.true();
  });

  it('should find nothing when the feed carries no row for it', () => {
    // Arrange / Act / Assert
    should(usageForAgent([], 'agent-a')).be.undefined();
  });
});
