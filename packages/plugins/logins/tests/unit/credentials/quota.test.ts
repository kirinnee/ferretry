import { describe, it } from 'bun:test';
import should from 'should';
import {
  FORBIDDEN,
  parseStoredUsageBody,
  percentFromStoredUtilization,
  UNAUTHORIZED,
  usageEndpointCredentialSignal,
  usageEndpointHttpVerdict,
  parseClaudeStatuslineRateLimits,
  parseCodexRateLimits,
  parseCodexUsageBody,
} from '../../../daemon/lib/credentials/quota.ts';

describe('percentFromStoredUtilization', () => {
  it('should read 42 as 42% and 0.42 as less than one percent, never as a fraction', () => {
    // Assert — the stored usage JSON reports a percentage already, so a small number stays small.
    should(percentFromStoredUtilization(42)).equal(42);
    should(percentFromStoredUtilization(0.42)).equal(0.42);
  });

  it('should pass a percentage through, clamped to the public range', () => {
    should(percentFromStoredUtilization(0)).equal(0);
    should(percentFromStoredUtilization(100)).equal(100);
    should(percentFromStoredUtilization(140)).equal(100);
    should(percentFromStoredUtilization(-5)).equal(0);
  });

  it('should refuse anything that is not a number, rather than reading it as zero', () => {
    should(percentFromStoredUtilization('42')).be.undefined();
    should(percentFromStoredUtilization(undefined)).be.undefined();
    should(percentFromStoredUtilization(null)).be.undefined();
    should(percentFromStoredUtilization(Number.NaN)).be.undefined();
  });
});

describe('parseStoredUsageBody', () => {
  it('should read both named windows and their reset instants', () => {
    // Act
    const actual = parseStoredUsageBody({
      five_hour: { utilization: 42, resets_at: '2027-01-15T09:00:00.000Z' },
      seven_day: { utilization: 11, resets_at: '2027-01-20T09:00:00.000Z' },
    });

    // Assert — the provider names these windows, so nothing is inferred from reset horizons.
    should(actual.shortWindow).deepEqual({ usedPercent: 42, resetAt: Date.parse('2027-01-15T09:00:00.000Z') });
    should(actual.longWindow).deepEqual({ usedPercent: 11, resetAt: Date.parse('2027-01-20T09:00:00.000Z') });
    should(actual.hasQuotaSignal).be.true();
    should(actual.providerAtLimit).be.false();
  });

  it('should report no signal for a body that carries no measurement', () => {
    // Arrange — shaped like an answer, containing none.
    const actual = parseStoredUsageBody({ five_hour: {}, seven_day: {} });

    // Assert
    should(actual.hasQuotaSignal).be.false();
    should(actual.shortWindow).be.undefined();
    should(actual.longWindow).be.undefined();
  });

  it('should keep a reset time even when the percentage is unreadable, and still report no signal', () => {
    // Act
    const actual = parseStoredUsageBody({ five_hour: { utilization: 'lots', resets_at: '2027-01-15T09:00:00.000Z' } });

    // Assert — a reset instant alone proves nothing about consumption.
    should(actual.shortWindow).deepEqual({ resetAt: Date.parse('2027-01-15T09:00:00.000Z') });
    should(actual.hasQuotaSignal).be.false();
  });

  it('should survive a body that is not an object at all', () => {
    for (const body of [undefined, null, 'nope', 42, []]) {
      const actual = parseStoredUsageBody(body);
      should(actual.hasQuotaSignal).be.false();
      should(actual.providerAtLimit).be.false();
    }
  });

  it('should read a zero percentage as a real measurement', () => {
    // Arrange — an idle account genuinely reports 0, and that is a signal, not an absence.
    const actual = parseStoredUsageBody({ five_hour: { utilization: 0 } });

    // Assert
    should(actual.shortWindow).deepEqual({ usedPercent: 0 });
    should(actual.hasQuotaSignal).be.true();
  });
});

describe('usageEndpointHttpVerdict', () => {
  it('should not mark an account unavailable for a 403', () => {
    // Arrange — a 403 here only means the token lacks `user:profile`, which is expected for an
    // inference-scoped token and says nothing about whether the account can serve work.
    should(usageEndpointHttpVerdict(FORBIDDEN)).deepEqual({ unavailable: false });
  });

  it('should keep a bare control-plane 401 inconclusive for both auth and availability', () => {
    // The endpoint can refuse this HTTP client independently of whether the credential works in the
    // native harness. Status alone therefore cannot condemn the login or take the account out of use.
    should(usageEndpointHttpVerdict(UNAUTHORIZED)).deepEqual({ unavailable: false });
  });

  it('should treat a success as conclusive', () => {
    should(usageEndpointHttpVerdict(200)).deepEqual({ authOk: true, unavailable: false });
  });
});

/**
 * The same statuses, as the classification a HEALTH verdict is built from.
 *
 * These deliberately diverge from `usageEndpointHttpVerdict` above, and the divergence is the point:
 * for quota, anything that is not a `401` may safely be read as "not repudiated", so a `503` returns
 * `authOk: true`. Health asks whether the credential was ACCEPTED, and a provider that never answered
 * accepted nothing. Reusing the quota reading would publish a healthy verdict for every outage.
 */
describe('usageEndpointCredentialSignal', () => {
  it('should require confirmed Anthropic JSON before a 403 is accepted-but-unmeasurable', () => {
    // The status alone can also be a Cloudflare HTML challenge. Only the inspected JSON response may
    // become `healthy/usage_scope_unavailable`; a bare 403 stays inconclusive.
    should(usageEndpointCredentialSignal(FORBIDDEN)).equal('inconclusive');
    should(usageEndpointCredentialSignal(FORBIDDEN, { scopeUnavailableConfirmed: true })).equal('scope_unavailable');
  });

  it('should classify a bare 401 as an unconfirmed rejection', () => {
    should(usageEndpointCredentialSignal(UNAUTHORIZED)).equal('rejection_unconfirmed');
  });

  it('should classify every 2xx as accepted', () => {
    should([200, 204, 299].map(status => usageEndpointCredentialSignal(status))).deepEqual([
      'accepted',
      'accepted',
      'accepted',
    ]);
  });

  it('should refuse to conclude anything from a rate limit, a server error or another 4xx', () => {
    // Arrange / Act
    const actual = [429, 500, 503, 418, 302].map(status => usageEndpointCredentialSignal(status));

    // Assert — a rate-limited account is an AUTHENTICATED account, and certainly not one whose login
    // needs replacing. Note `usageEndpointHttpVerdict` reports `authOk: true` for these; health may
    // not, which is exactly why this is a second function rather than a field on the first.
    should(actual).deepEqual(['inconclusive', 'inconclusive', 'inconclusive', 'inconclusive', 'inconclusive']);
    should(usageEndpointHttpVerdict(503).authOk).be.true();
  });
});

describe('parseClaudeStatuslineRateLimits', () => {
  it('should read both named windows as percentages with epoch-second resets', () => {
    // Arrange
    const payload = {
      model: { id: 'claude' },
      rate_limits: {
        five_hour: { used_percentage: 42, resets_at: 1_786_000_000 },
        seven_day: { used_percentage: 0.5, resets_at: 1_786_500_000 },
      },
    };

    // Act / Assert — `0.5` is half a percent here, never 50%: this field is already a percentage.
    should(parseClaudeStatuslineRateLimits(payload)).deepEqual({
      shortWindow: { usedPercent: 42, resetAt: 1_786_000_000_000 },
      longWindow: { usedPercent: 0.5, resetAt: 1_786_500_000_000 },
      hasQuotaSignal: true,
      providerAtLimit: false,
    });
  });

  it('should report no signal for a payload without rate limits, or with only a reset', () => {
    should(parseClaudeStatuslineRateLimits({ model: {} })).deepEqual({ hasQuotaSignal: false, providerAtLimit: false });
    should(parseClaudeStatuslineRateLimits('not an object').hasQuotaSignal).be.false();
    should(parseClaudeStatuslineRateLimits({ rate_limits: { five_hour: { resets_at: 1_786_000_000 } } })).deepEqual({
      shortWindow: { resetAt: 1_786_000_000_000 },
      hasQuotaSignal: false,
      providerAtLimit: false,
    });
  });
});

describe('parseCodexRateLimits', () => {
  it('should read primary as the 5-hour window and secondary as the weekly one', () => {
    should(
      parseCodexRateLimits({
        primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1_786_000_000 },
        secondary: { used_percent: 60, window_minutes: 10_080, resets_at: 1_786_500_000 },
      }),
    ).deepEqual({
      shortWindow: { usedPercent: 12.5, resetAt: 1_786_000_000_000 },
      longWindow: { usedPercent: 60, resetAt: 1_786_500_000_000 },
      hasQuotaSignal: true,
      providerAtLimit: false,
    });
  });

  it('should measure an older relative reset from the event, and drop one with no instant to measure from', () => {
    const limits = { primary: { used_percent: 5, resets_in_seconds: 60 }, secondary: { resets_in_seconds: -1 } };
    should(parseCodexRateLimits(limits, 1_000)).deepEqual({
      shortWindow: { usedPercent: 5, resetAt: 61_000 },
      hasQuotaSignal: true,
      providerAtLimit: false,
    });
    should(parseCodexRateLimits(limits)).deepEqual({
      shortWindow: { usedPercent: 5 },
      hasQuotaSignal: true,
      providerAtLimit: false,
    });
    should(parseCodexRateLimits(null).hasQuotaSignal).be.false();
  });
});

describe('parseCodexUsageBody', () => {
  it('should read both windows and the provider at-limit flag', () => {
    should(
      parseCodexUsageBody(
        {
          plan_type: 'pro',
          rate_limit: {
            limit_reached: true,
            primary_window: { used_percent: 100, reset_after_seconds: 30 },
            secondary_window: { used_percent: 40, reset_at: 1_786_500_000 },
          },
        },
        1_000,
      ),
    ).deepEqual({
      shortWindow: { usedPercent: 100, resetAt: 31_000 },
      longWindow: { usedPercent: 40, resetAt: 1_786_500_000_000 },
      hasQuotaSignal: true,
      providerAtLimit: true,
    });
  });

  it('should report no signal for a body without a rate limit', () => {
    should(parseCodexUsageBody({}, 1_000)).deepEqual({ hasQuotaSignal: false, providerAtLimit: false });
  });
});
