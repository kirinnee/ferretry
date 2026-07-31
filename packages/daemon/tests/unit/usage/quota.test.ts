import type { AccountUsage } from '@ferretry/protocol';
import { describe, it } from 'bun:test';
import should from 'should';
import {
  authFailureRemedy,
  compactUsageQuota,
  providerUnavailableDetail,
  quotaFromUsage,
  usageAccountView,
  usageEventData,
  usageQuotaLabel,
  usageStateFromQuota,
  type SessionQuota,
} from '../../../src/lib/usage/index.ts';

const account = (overrides: Partial<AccountUsage> = {}): AccountUsage => ({
  agent: 'writer',
  ...overrides,
});

describe('authFailureRemedy', () => {
  it.each([
    { authMode: 'oauth' as const, expected: 'fy fleet login' },
    { authMode: 'api-key' as const, expected: 'API key' },
  ])('names the achievable remedy for a $authMode account', ({ authMode, expected }) => {
    // Arrange / Act
    const remedy = authFailureRemedy(authMode);

    // Assert
    should(remedy).containEql(expected);
  });

  it('should offer both paths when the authentication mode is unknown', () => {
    // Arrange / Act
    const remedy = authFailureRemedy();

    // Assert
    should(remedy).containEql('fy fleet apply');
    should(remedy).containEql('fy fleet login');
  });
});

describe('quotaFromUsage', () => {
  it('should keep every window unknown when the probe itself failed', () => {
    // Arrange
    const row = account({
      ok: false,
      fiveHourPercent: 40,
      weeklyPercent: 60,
      atLimit: true,
      availability: 'available',
    });

    // Act
    const quota = quotaFromUsage(row);

    // Assert
    should(quota).deepEqual({});
  });

  it('should not report numerical windows for an account billed per request', () => {
    // Arrange
    const row = account({ usageBased: false, fiveHourPercent: 40, weeklyPercent: 60 });

    // Act
    const quota = quotaFromUsage(row);

    // Assert
    should(quota).deepEqual({ usageBased: false });
  });

  it('should discard windows but keep the evidence when authentication failed', () => {
    // Arrange
    const row = account({ authOk: false, fiveHourPercent: 40, availability: 'unavailable', unavailable: true });

    // Act
    const quota = quotaFromUsage(row);

    // Assert
    should(quota.fiveHourPercent).be.undefined();
    should(quota.authOk).be.false();
    should(quota.availability).equal('unavailable');
  });

  it('should carry an unavailable reason only while the account is actually unavailable', () => {
    // Arrange
    const row = account({ unavailable: false, unavailableReason: 'cooldown' });

    // Act
    const quota = quotaFromUsage(row);

    // Assert
    should(quota.unavailable).be.false();
    should(quota.unavailableReason).be.undefined();
  });

  it.each([
    { label: 'above the scale', value: 140 },
    { label: 'negative', value: -1 },
    { label: 'not finite', value: Number.POSITIVE_INFINITY },
  ])('should drop a percentage that is $label rather than display it', ({ value }) => {
    // Arrange
    const row = account({ fiveHourPercent: value });

    // Act
    const quota = quotaFromUsage(row);

    // Assert
    should(quota.fiveHourPercent).be.undefined();
  });

  it('should reduce the two reset windows to the nearest one', () => {
    // Arrange
    const row = account({ fiveHourResetAt: 5_000, weeklyResetAt: 2_000 });

    // Act
    const quota = quotaFromUsage(row);

    // Assert
    should(quota.resetAt).equal(2_000);
  });

  it('should ignore a retry time when availability was never reported', () => {
    // Arrange
    const row = account({ retryAt: 9_000 });

    // Act
    const quota = quotaFromUsage(row);

    // Assert
    should(quota.retryAt).be.undefined();
  });

  it('should keep a retry time reported alongside availability', () => {
    // Arrange
    const row = account({ availability: 'unavailable', retryAt: 9_000 });

    // Act
    const quota = quotaFromUsage(row);

    // Assert
    should(quota.retryAt).equal(9_000);
  });

  it('should keep the at-limit flag when only availability is known', () => {
    // Arrange
    const row = account({ usageBased: false, unavailable: true, atLimit: true });

    // Act
    const quota = quotaFromUsage(row);

    // Assert
    should(quota.atLimit).be.true();
  });

  it('should retain the provider and both windows for a healthy account', () => {
    // Arrange
    const row = account({
      provider: 'example',
      availability: 'available',
      fiveHourPercent: 12,
      weeklyPercent: 34,
      fiveHourResetAt: 7_000,
      weeklyResetAt: 8_000,
      atLimit: false,
      authOk: true,
    });

    // Act
    const quota = quotaFromUsage(row);

    // Assert
    should(quota).deepEqual({
      availability: 'available',
      atLimit: false,
      authOk: true,
      provider: 'example',
      fiveHourPercent: 12,
      weeklyPercent: 34,
      fiveHourResetAt: 7_000,
      weeklyResetAt: 8_000,
      resetAt: 7_000,
    });
  });
});

describe('usageAccountView', () => {
  it('should key the wire row by agent and omit the derived reset', () => {
    // Arrange
    const row = account({ agent: 'reader', fiveHourResetAt: 4_000 });

    // Act
    const view = usageAccountView(row);

    // Assert
    should(view.agent).equal('reader');
    should(view.fiveHourResetAt).equal(4_000);
    should(view).not.have.property('resetAt');
  });
});

describe('usageStateFromQuota', () => {
  it('should clear every window once authentication is known to have failed', () => {
    // Arrange
    const quota: SessionQuota = { authOk: false, fiveHourPercent: 10, weeklyPercent: 20, atLimit: true };

    // Act
    const patch = usageStateFromQuota(quota);

    // Assert
    should(patch).deepEqual({
      usage5hPercent: undefined,
      usageWeeklyPercent: undefined,
      usage5hResetAt: undefined,
      usageWeeklyResetAt: undefined,
      usageAtLimit: undefined,
      usageAuthOk: false,
    });
  });

  it('should pass the windows through while authentication is not disproved', () => {
    // Arrange
    const quota: SessionQuota = { fiveHourPercent: 10, weeklyResetAt: 99, atLimit: false };

    // Act
    const patch = usageStateFromQuota(quota);

    // Assert
    should(patch.usage5hPercent).equal(10);
    should(patch.usageWeeklyResetAt).equal(99);
    should(patch.usageAtLimit).be.false();
    should(patch.usageAuthOk).be.undefined();
  });
});

describe('usageEventData', () => {
  it('should emit only the fields that are known', () => {
    // Arrange
    const state = { usage5hPercent: 10, usageAtLimit: false, usageWeeklyPercent: undefined };

    // Act
    const data = usageEventData(state);

    // Assert
    should(data).deepEqual({ usage5hPercent: 10, usageAtLimit: false });
  });

  it('should emit every field once all are known', () => {
    // Arrange
    const state = {
      usage5hPercent: 1,
      usageWeeklyPercent: 2,
      usage5hResetAt: 3,
      usageWeeklyResetAt: 4,
      usageAtLimit: true,
      usageAuthOk: true,
    };

    // Act
    const data = usageEventData(state);

    // Assert
    should(data).deepEqual(state);
  });
});

describe('usageQuotaLabel', () => {
  it.each([
    {
      label: 'authentication failure wins',
      state: { usageAuthOk: false, usage5hPercent: 4 },
      expected: 'AUTH REQUIRED',
    },
    { label: 'both windows', state: { usage5hPercent: 4, usageWeeklyPercent: 8 }, expected: '5h 4% · wk 8%' },
    { label: 'the limit marker', state: { usage5hPercent: 99, usageAtLimit: true }, expected: '5h 99% · AT LIMIT' },
  ])('should render $label', ({ state, expected }) => {
    // Arrange / Act
    const rendered = usageQuotaLabel(state);

    // Assert
    should(rendered).equal(expected);
  });

  it('should render nothing when no field is known', () => {
    // Arrange / Act
    const rendered = usageQuotaLabel({});

    // Assert
    should(rendered).be.undefined();
  });
});

describe('compactUsageQuota', () => {
  it.each([
    { label: 'authentication failure', state: { usageAuthOk: false }, expected: 'AUTH!' },
    { label: 'nothing known', state: {}, expected: '—' },
    { label: 'one known window', state: { usageWeeklyPercent: 30 }, expected: '—/30%' },
    {
      label: 'a capped account',
      state: { usage5hPercent: 100, usageWeeklyPercent: 50, usageAtLimit: true },
      expected: '100%/50%!',
    },
  ])('should render $label', ({ state, expected }) => {
    // Arrange / Act
    const rendered = compactUsageQuota(state);

    // Assert
    should(rendered).equal(expected);
  });
});

describe('providerUnavailableDetail', () => {
  it.each([
    { reason: 'cooldown' as const, expected: 'cooling down' },
    { reason: 'spend_limit' as const, expected: 'spend limit' },
    { reason: 'auth' as const, expected: 'rejected every credential' },
    { reason: 'no_credentials' as const, expected: 'no active credentials' },
    { reason: 'provider' as const, expected: 'provider is unavailable' },
  ])('should explain $reason in words the reader can act on', ({ reason, expected }) => {
    // Arrange / Act
    const detail = providerUnavailableDetail({ unavailableReason: reason });

    // Assert
    should(detail).containEql(expected);
  });

  it('should append the retry instant when one is known', () => {
    // Arrange / Act
    const detail = providerUnavailableDetail({ unavailableReason: 'cooldown', retryAt: 1_000 });

    // Assert
    should(detail).endWith('; retry after 1970-01-01T00:00:01.000Z');
  });

  it('should fall back to a generic explanation when no reason was reported', () => {
    // Arrange / Act
    const detail = providerUnavailableDetail({});

    // Assert
    should(detail).equal('the provider is unavailable');
  });
});
