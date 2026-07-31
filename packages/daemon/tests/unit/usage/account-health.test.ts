import type { AccountUsage } from '@ferretry/protocol';
import { describe, it } from 'bun:test';
import should from 'should';
import {
  accountHealthProblem,
  confirmedUsableAccount,
  spentPercent,
  unusableAccountReason,
  usableAccount,
  usageForAgent,
} from '../../../src/lib/usage/index.ts';

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

describe('accountHealthProblem', () => {
  it.each([
    { label: 'nothing is known', row: undefined, expected: undefined },
    { label: 'the row is healthy', row: usage({ atLimit: false, authOk: true }), expected: undefined },
    { label: 'credentials were rejected', row: usage({ authOk: false }), expected: 'auth' },
    { label: 'the provider is down', row: usage({ unavailable: true }), expected: 'unavailable' },
    { label: 'the account is spent', row: usage({ atLimit: true }), expected: 'at-limit' },
  ])('should classify $label as $expected', ({ row, expected }) => {
    // Arrange / Act / Assert
    should(accountHealthProblem(row)).equal(expected);
  });

  it('should rank rejected credentials above every other problem', () => {
    // Arrange — an account that is unauthenticated AND down AND spent: only the first is actionable
    const row = usage({ authOk: false, unavailable: true, atLimit: true });

    // Act / Assert
    should(accountHealthProblem(row)).equal('auth');
  });

  it('should rank an unavailable provider above a spent account', () => {
    // Arrange / Act / Assert
    should(accountHealthProblem(usage({ unavailable: true, atLimit: true }))).equal('unavailable');
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
