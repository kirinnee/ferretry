import { describe, it } from 'bun:test';
import should from 'should';
import {
  FORBIDDEN,
  type HeaderLookup,
  inferenceHttpVerdict,
  MAX_UTILIZATION_FRACTION,
  parseQuotaHeaders,
  parseStoredUsageBody,
  percentFromStoredUtilization,
  percentFromUtilizationFraction,
  TOO_MANY_REQUESTS,
  UNAUTHORIZED,
  usageEndpointCredentialSignal,
  usageEndpointHttpVerdict,
} from '../../src/lib/quota.ts';

/** A header table, looked up case-insensitively as a real response would be. */
const headers = (table: Readonly<Record<string, string>>): HeaderLookup => {
  const lower = new Map(Object.entries(table).map(([name, value]) => [name.toLowerCase(), value]));
  return name => lower.get(name.toLowerCase()) ?? null;
};

const RESET_SECONDS = 1_800_003_600;
const RESET_MS = RESET_SECONDS * 1000;

/**
 * The 100× landmine, guarded from both sides.
 *
 * Both sources call the field `utilization`. The stored-OAuth JSON reports `0..100`; the inference
 * response header reports a fraction of one. These tests deliberately feed each reader the *other's*
 * value, because the whole failure mode is that a wrong reading still looks like a plausible number.
 * If either assertion is ever relaxed, the mix-up becomes reintroducible in silence.
 */
describe('the two utilization scales', () => {
  it('should read 0.42 as 42% from a header and as a rounding error from stored usage', () => {
    // Act — the same number, under each source's rule.
    const asFraction = percentFromUtilizationFraction('0.42');
    const asPercent = percentFromStoredUtilization(0.42);

    // Assert — 100× apart, which is exactly why they cannot share a reader.
    should(asFraction).equal(42);
    should(asPercent).equal(0.42);
  });

  it('should read 42 as 42% from stored usage and refuse it outright from a header', () => {
    // Act
    const asPercent = percentFromStoredUtilization(42);
    const asFraction = percentFromUtilizationFraction('42');

    // Assert — a percentage that reached the header reader is refused, not clamped to 100. Clamping
    // would report a healthy account as exhausted and look like a real reading while doing it.
    should(asPercent).equal(42);
    should(asFraction).be.undefined();
  });

  it('should accept a slightly-over-one utilization, which Anthropic has been observed sending', () => {
    // Arrange — 1.01 for a genuinely exhausted window is real, so the ceiling must not be exactly 1.
    should(percentFromUtilizationFraction('1.01')).equal(100);
    should(MAX_UTILIZATION_FRACTION).be.above(1);
  });

  it('should refuse a fraction beyond the ceiling rather than clamping it', () => {
    should(percentFromUtilizationFraction(String(MAX_UTILIZATION_FRACTION + 0.01))).be.undefined();
  });
});

describe('percentFromStoredUtilization', () => {
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

describe('percentFromUtilizationFraction', () => {
  it('should accept the fraction as a number as well as a string', () => {
    should(percentFromUtilizationFraction(0.5)).equal(50);
    should(percentFromUtilizationFraction('0.5')).equal(50);
  });

  it('should read a genuine zero as zero, not as absent', () => {
    should(percentFromUtilizationFraction('0')).equal(0);
  });

  it('should refuse an empty, blank, unparseable or negative value', () => {
    should(percentFromUtilizationFraction('')).be.undefined();
    should(percentFromUtilizationFraction('   ')).be.undefined();
    should(percentFromUtilizationFraction('not-a-number')).be.undefined();
    should(percentFromUtilizationFraction('-0.1')).be.undefined();
    should(percentFromUtilizationFraction(undefined)).be.undefined();
    should(percentFromUtilizationFraction(Number.POSITIVE_INFINITY)).be.undefined();
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

describe('parseQuotaHeaders', () => {
  it('should read both unified windows as fractions and convert them once', () => {
    // Act
    const actual = parseQuotaHeaders(
      headers({
        'anthropic-ratelimit-unified-5h-utilization': '0.42',
        'anthropic-ratelimit-unified-5h-reset': String(RESET_SECONDS),
        'anthropic-ratelimit-unified-5h-status': 'allowed',
        'anthropic-ratelimit-unified-7d-utilization': '0.11',
        'anthropic-ratelimit-unified-7d-reset': String(RESET_SECONDS),
      }),
    );

    // Assert
    should(actual.shortWindow).deepEqual({ usedPercent: 42, resetAt: RESET_MS });
    should(actual.longWindow).deepEqual({ usedPercent: 11, resetAt: RESET_MS });
    should(actual.hasQuotaSignal).be.true();
    should(actual.providerAtLimit).be.false();
  });

  it('should treat an explicit rejection as a signal even with no percentage', () => {
    // Arrange — the provider saying "rejected" is worth more than a number it did not send.
    const actual = parseQuotaHeaders(headers({ 'anthropic-ratelimit-unified-5h-status': 'REJECTED' }));

    // Assert
    should(actual.providerAtLimit).be.true();
    should(actual.hasQuotaSignal).be.true();
    should(actual.shortWindow).be.undefined();
  });

  it('should ignore a status it does not recognise', () => {
    const actual = parseQuotaHeaders(headers({ 'anthropic-ratelimit-unified-5h-status': 'probably-fine' }));
    should(actual.providerAtLimit).be.false();
    should(actual.hasQuotaSignal).be.false();
  });

  it('should report no signal when a response carries none of the headers', () => {
    // Arrange — a 200 with no quota headers is a failed reading, not an idle account.
    const actual = parseQuotaHeaders(headers({}));

    // Assert
    should(actual.hasQuotaSignal).be.false();
    should(actual.providerAtLimit).be.false();
    should(actual.shortWindow).be.undefined();
    should(actual.longWindow).be.undefined();
  });

  it('should keep a reset time without a percentage, and still call it no signal', () => {
    const actual = parseQuotaHeaders(headers({ 'anthropic-ratelimit-unified-7d-reset': String(RESET_SECONDS) }));
    should(actual.longWindow).deepEqual({ resetAt: RESET_MS });
    should(actual.hasQuotaSignal).be.false();
  });

  it('should ignore an unparseable reset value', () => {
    const actual = parseQuotaHeaders(headers({ 'anthropic-ratelimit-unified-5h-reset': 'soon' }));
    should(actual.shortWindow).be.undefined();
  });

  it('should treat a rejection on the long window as at-limit too', () => {
    const actual = parseQuotaHeaders(headers({ 'anthropic-ratelimit-unified-7d-status': 'rejected' }));
    should(actual.providerAtLimit).be.true();
  });
});

describe('inferenceHttpVerdict', () => {
  it('should let only 401 condemn the credential', () => {
    // Assert — a 403 here is an org or spend-policy block on a valid token.
    should(inferenceHttpVerdict(UNAUTHORIZED)).deepEqual({ authOk: false, unavailable: true });
    should(inferenceHttpVerdict(FORBIDDEN)).deepEqual({ unavailable: true });
    should(inferenceHttpVerdict(FORBIDDEN)).not.have.property('authOk');
  });

  it('should mark a forbidden account unavailable, so routing stops picking it', () => {
    // Arrange — leaving this unset made such accounts read as "usable, just no usage data".
    should(inferenceHttpVerdict(FORBIDDEN).unavailable).be.true();
  });

  it('should treat a rate-limited response as neither dead nor unavailable', () => {
    // Arrange — a 429 still carries valid quota headers, so it is a successful reading.
    should(inferenceHttpVerdict(TOO_MANY_REQUESTS)).deepEqual({ authOk: true, unavailable: false });
  });

  it('should treat a plain success as conclusive and usable', () => {
    should(inferenceHttpVerdict(200)).deepEqual({ authOk: true, unavailable: false });
  });
});

describe('usageEndpointHttpVerdict', () => {
  it('should not mark an account unavailable for a 403, unlike the inference call', () => {
    // Arrange — a 403 here only means the token lacks `user:profile`, which is expected for an
    // inference-scoped token and says nothing about whether the account can serve work.
    should(usageEndpointHttpVerdict(FORBIDDEN)).deepEqual({ unavailable: false });
    should(inferenceHttpVerdict(FORBIDDEN).unavailable).be.true();
  });

  it('should still let 401 condemn the credential', () => {
    should(usageEndpointHttpVerdict(UNAUTHORIZED)).deepEqual({ authOk: false, unavailable: true });
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
  it('should classify a 403 as accepted-but-unmeasurable, never as a rejection', () => {
    // The single most consequential row: this becomes `healthy/usage_scope_unavailable`, and reading
    // it as a rejection sends somebody to re-login forever on an account that works.
    should(usageEndpointCredentialSignal(FORBIDDEN)).equal('scope_unavailable');
  });

  it('should let only 401 reject the credential', () => {
    should(usageEndpointCredentialSignal(UNAUTHORIZED)).equal('rejected');
  });

  it('should classify every 2xx as accepted', () => {
    should([200, 204, 299].map(usageEndpointCredentialSignal)).deepEqual(['accepted', 'accepted', 'accepted']);
  });

  it('should refuse to conclude anything from a rate limit, a server error or another 4xx', () => {
    // Arrange / Act
    const actual = [TOO_MANY_REQUESTS, 500, 503, 418, 302].map(usageEndpointCredentialSignal);

    // Assert — a rate-limited account is an AUTHENTICATED account, and certainly not one whose login
    // needs replacing. Note `usageEndpointHttpVerdict` reports `authOk: true` for these; health may
    // not, which is exactly why this is a second function rather than a field on the first.
    should(actual).deepEqual(['inconclusive', 'inconclusive', 'inconclusive', 'inconclusive', 'inconclusive']);
    should(usageEndpointHttpVerdict(503).authOk).be.true();
  });
});
