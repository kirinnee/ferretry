import { describe, it } from 'bun:test';
import should from 'should';
import {
  snapshotAnalyticsUsagePricing,
  type AnalyticsPricingRate,
  type AnalyticsPricingRates,
  type AnalyticsTokenUsage,
} from '../../../src/lib/analytics/pricing.ts';

/** Every slot stated, so a fixture says which charges do not apply instead of leaving them out. */
const rates = (
  input: number,
  cachedInput: number,
  output: number,
  patch: Partial<AnalyticsPricingRates> = {},
): AnalyticsPricingRates => ({
  input,
  output,
  cachedInput,
  cacheWrite: null,
  cacheWrite5m: null,
  cacheWrite1h: null,
  reasoning: null,
  image: null,
  tool: null,
  ...patch,
});

const openAiRate: AnalyticsPricingRate = {
  pricingKey: 'openai:model-a@2026-07-01',
  modelId: 'model-a',
  aliases: ['MODEL-A-preview'],
  provider: 'openai',
  currency: 'USD',
  rates: rates(2_000_000, 200_000, 10_000_000, { cacheWrite: 2_500_000 }),
  source: { kind: 'manual' },
  verifiedAt: '2026-07-01T00:00:00Z',
  validFrom: '2026-07-01T00:00:00Z',
  validThrough: null,
  lastSyncedAt: null,
};

const usage: AnalyticsTokenUsage = {
  pricingModel: 'model-a-preview[1m]',
  createdAt: '2026-07-30T12:00:00+00:00',
  inputTokens: 1_000_000,
  cachedInputTokens: 100_000,
  cacheWriteInputTokens: 100_000,
  outputTokens: 200_000,
};

describe('snapshotAnalyticsUsagePricing', () => {
  it('should snapshot the effective injected rate and round the combined cost once', () => {
    // Act
    const actual = snapshotAnalyticsUsagePricing(usage, [openAiRate]);

    // Assert
    should(actual).have.property('kind', 'priced');
    if (actual.kind !== 'priced') throw new Error('expected priced usage');
    should(actual.identity.modelId).equal('model-a');
    should(actual.identity.contextWindow).equal(1_000_000);
    should(actual.rate).deepEqual({
      pricingKey: 'openai:model-a@2026-07-01',
      modelId: 'model-a',
      provider: 'openai',
      // The stored projection: the slots this build multiplies, with an unstated charge left off
      // rather than written down as a zero.
      ratesUsdMicrosPerMillion: { input: 2_000_000, cachedRead: 200_000, output: 10_000_000, cacheWrite: 2_500_000 },
      verifiedAt: '2026-07-01T00:00:00Z',
      validFrom: '2026-07-01T00:00:00Z',
      validThrough: null,
    });
    should(actual.equivalentApiCostUsdMicros).equal(3_870_000);
  });

  it('should select the newest rate valid at the session instant', () => {
    // Arrange
    const newer = {
      ...openAiRate,
      pricingKey: 'openai:model-a@2026-07-15',
      rates: { ...openAiRate.rates, output: 20_000_000 },
      validFrom: '2026-07-15T00:00:00.000Z',
      validThrough: '2026-08-01T00:00:00.000Z',
    };

    // Act
    const actual = snapshotAnalyticsUsagePricing(usage, [openAiRate, newer]);

    // Assert
    should(actual).have.property('kind', 'priced');
    if (actual.kind === 'priced') should(actual.rate.pricingKey).equal(newer.pricingKey);
  });

  it('should price Anthropic cache writes only with an exact TTL split', () => {
    // Arrange
    const rate: AnalyticsPricingRate = {
      ...openAiRate,
      provider: 'anthropic',
      rates: rates(5_000_000, 500_000, 25_000_000, { cacheWrite5m: 6_250_000, cacheWrite1h: 10_000_000 }),
    };

    // Act
    const missing = snapshotAnalyticsUsagePricing(usage, [rate]);
    const inconsistent = snapshotAnalyticsUsagePricing(
      { ...usage, cacheWrite5mInputTokens: 40_000, cacheWrite1hInputTokens: 40_000 },
      [rate],
    );
    const invalid = snapshotAnalyticsUsagePricing(
      { ...usage, cacheWrite5mInputTokens: -1, cacheWrite1hInputTokens: 100_001 },
      [rate],
    );
    const missingRates = snapshotAnalyticsUsagePricing(
      { ...usage, cacheWrite5mInputTokens: 40_000, cacheWrite1hInputTokens: 60_000 },
      [{ ...rate, rates: rates(1, 1, 1) }],
    );
    const priced = snapshotAnalyticsUsagePricing(
      { ...usage, cacheWrite5mInputTokens: 40_000, cacheWrite1hInputTokens: 60_000 },
      [rate],
    );

    // Assert
    should(missing).have.property('reason', 'missing_anthropic_cache_write_split');
    should(inconsistent).have.property('reason', 'inconsistent_anthropic_cache_write_split');
    should(invalid).have.property('reason', 'invalid_token_counts');
    should(missingRates).have.property('reason', 'invalid_rate_table');
    should(priced).have.property('kind', 'priced');
  });

  it.each([
    { patch: { pricingModel: null }, catalog: [openAiRate], reason: 'missing_pricing_model' },
    { patch: { createdAt: 'not-an-instant' }, catalog: [openAiRate], reason: 'invalid_created_at' },
    { patch: { pricingModel: 'missing' }, catalog: [openAiRate], reason: 'unknown_pricing_model' },
    { patch: { createdAt: '2026-06-30T23:59:59Z' }, catalog: [openAiRate], reason: 'pricing_outside_validity_window' },
    { patch: { inputTokens: null }, catalog: [openAiRate], reason: 'incomplete_token_counts' },
    { patch: { outputTokens: -1 }, catalog: [openAiRate], reason: 'invalid_token_counts' },
    { patch: { inputTokens: 1 }, catalog: [openAiRate], reason: 'negative_uncached_input' },
  ])('should report $reason instead of guessing a zero cost', ({ patch, catalog, reason }) => {
    // Act
    const actual = snapshotAnalyticsUsagePricing({ ...usage, ...patch }, catalog);

    // Assert
    should(actual).have.property('kind', 'unpriced');
    should(actual).have.property('reason', reason);
  });

  it('should reject invalid rate snapshots and unsafe costs', () => {
    // Arrange
    const missingWriteRate = {
      ...openAiRate,
      rates: rates(1, 1, 1),
    };
    const negativeRate = {
      ...openAiRate,
      rates: { ...openAiRate.rates, input: -1 },
    };
    const hugeRate = {
      ...openAiRate,
      rates: rates(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, {
        cacheWrite: Number.MAX_SAFE_INTEGER,
      }),
    };

    // Act
    const missing = snapshotAnalyticsUsagePricing(usage, [missingWriteRate]);
    const invalid = snapshotAnalyticsUsagePricing(usage, [negativeRate]);
    const overflow = snapshotAnalyticsUsagePricing(
      { ...usage, inputTokens: Number.MAX_SAFE_INTEGER, cachedInputTokens: 0, cacheWriteInputTokens: 0 },
      [hugeRate],
    );

    // Assert
    should(missing).have.property('reason', 'invalid_rate_table');
    should(invalid).have.property('reason', 'invalid_rate_table');
    should(overflow).have.property('reason', 'cost_out_of_range');
  });
});
