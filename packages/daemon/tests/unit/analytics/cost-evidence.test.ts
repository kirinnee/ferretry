import { describe, it } from 'bun:test';
import type { AnalyticsRawSession } from '@ferretry/protocol';
import should from 'should';
import { costGapOf, currentRateCost, withCostEvidence } from '../../../src/lib/analytics/cost-evidence.ts';
import type { AnalyticsPricingRate } from '../../../src/lib/analytics/pricing.ts';
import type { AnalyticsStoredSession } from '../../../src/lib/analytics/store.ts';

const rate = (patch: Partial<AnalyticsPricingRate>): AnalyticsPricingRate => ({
  pricingKey: 'k',
  modelId: 'claude-opus-5-5',
  aliases: ['opus'],
  provider: 'anthropic',
  currency: 'USD',
  rates: {
    input: 4_000_000,
    output: 20_000_000,
    cachedInput: 200_000,
    cacheWrite: null,
    cacheWrite5m: 5_000_000,
    cacheWrite1h: 8_000_000,
    reasoning: null,
    image: null,
    tool: null,
  },
  source: { kind: 'manual' },
  verifiedAt: '2026-10-20T00:00:00.000Z',
  validFrom: '1970-01-01T00:00:00.000Z',
  validThrough: null,
  lastSyncedAt: null,
  ...patch,
});

const raw = (patch: Partial<AnalyticsRawSession> = {}): AnalyticsRawSession => ({
  id: 's1',
  agent: 'claude',
  model: 'claude-opus-5-5',
  contextWindow: null,
  harness: 'claude',
  mode: null,
  status: 'completed',
  label: null,
  cwd: null,
  parent: null,
  day: '2026-10-25',
  week: '2026-W43',
  createdAt: '2026-10-25T00:00:00.000Z',
  pricingModel: 'claude-opus-5-5',
  equivalentApiCostUsdMicros: 100,
  tokens: 2_000_000,
  inputTokens: 1_000_000,
  outputTokens: 1_000_000,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  cacheWrite5mInputTokens: 0,
  cacheWrite1hInputTokens: 0,
  reasoningTokens: null,
  turns: 1,
  durationMs: 1,
  activeDurationMs: 1,
  machine: null,
  timeToFirstOutputMs: 1,
  contextEndPercent: 1,
  stalled: false,
  failed: false,
  migrated: false,
  completed: true,
  ...patch,
});

const stored = (patch: Partial<AnalyticsStoredSession> & { raw?: AnalyticsRawSession }): AnalyticsStoredSession => ({
  raw: raw(),
  finishedAt: '2026-10-25T01:00:00.000Z',
  usageRefusal: null,
  pricing: null,
  signature: 'x',
  ingestedAt: '2026-10-25T01:00:00.000Z',
  ...patch,
});

describe('costGapOf', () => {
  it('should say nothing for a session that has a cost', () => {
    should(costGapOf(stored({}))).be.null();
  });

  it('should name the transcript refusal when the session has no cost because of one', () => {
    const actual = costGapOf(
      stored({ raw: raw({ equivalentApiCostUsdMicros: null, tokens: null }), usageRefusal: 'transcript_damaged' }),
    );
    should(actual).equal('transcript_damaged');
  });

  it('should name the pricing reason when the tokens were proven but no rate priced them', () => {
    const actual = costGapOf(
      stored({
        raw: raw({ equivalentApiCostUsdMicros: null }),
        pricing: { kind: 'unpriced', identity: null, reason: 'missing_pricing_model' },
      }),
    );
    should(actual).equal('missing_pricing_model');
  });

  it('should say unknown rather than guess when neither a refusal nor a reason survives', () => {
    should(costGapOf(stored({ raw: raw({ equivalentApiCostUsdMicros: null }) }))).equal('unknown');
  });
});

describe('currentRateCost', () => {
  const now = '2026-11-01T00:00:00.000Z';

  it('should price the stored tokens at the rate in force now, not the one in force then', () => {
    // Arrange: the rate doubled on 2026-10-30.
    const catalog = [
      rate({ validThrough: '2026-10-29T23:59:59.999Z' }),
      rate({
        pricingKey: 'k2',
        validFrom: '2026-10-30T00:00:00.000Z',
        rates: { ...rate({}).rates, input: 8_000_000, output: 40_000_000 },
      }),
    ];

    // Act
    const actual = currentRateCost(raw(), catalog, now);

    // Assert: 1M in × $8 + 1M out × $40.
    should(actual).equal(48_000_000);
  });

  it('should resolve a short name the catalog aliases', () => {
    should(currentRateCost(raw({ pricingModel: 'opus' }), [rate({})], now)).equal(24_000_000);
  });

  it('should be unknown for a model the catalog does not price, never zero', () => {
    should(currentRateCost(raw({ pricingModel: 'mystery' }), [rate({})], now)).be.null();
  });

  it('should be unknown for a session with no token evidence', () => {
    should(currentRateCost(raw({ tokens: null, inputTokens: null, outputTokens: null }), [rate({})], now)).be.null();
  });

  it('should be unknown for a session with no model name', () => {
    should(currentRateCost(raw({ pricingModel: null }), [rate({})], now)).be.null();
  });

  it('should be unknown while no catalog has been read', () => {
    should(currentRateCost(raw(), undefined, now)).be.null();
  });
});

describe('withCostEvidence', () => {
  it('should stamp the gap and the current-rate cost on the wire row without touching the stored cost', () => {
    const row = withCostEvidence(
      stored({
        raw: raw({ equivalentApiCostUsdMicros: null }),
        pricing: { kind: 'unpriced', identity: null, reason: 'unknown_pricing_model' },
      }),
      [rate({})],
      '2026-11-01T00:00:00.000Z',
    );
    should(row.costGap).equal('unknown_pricing_model');
    should(row.equivalentApiCostUsdMicros).be.null();
    should(row.equivalentApiCostCurrentUsdMicros).equal(24_000_000);
  });

  it('should carry no gap for a priced session', () => {
    const row = withCostEvidence(stored({}), [rate({})], '2026-11-01T00:00:00.000Z');
    should(row.costGap).be.null();
  });
});
