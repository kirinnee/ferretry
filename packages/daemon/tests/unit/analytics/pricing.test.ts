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
      // What the amounts are money IN and money PER, recorded on the row rather than left to the
      // reader's convention. Image and tool are catalog facts nothing here multiplies, so they are
      // absent rather than snapshotted as if they had been applied.
      currency: 'USD',
      rateUnit: 'million_tokens',
      // The stored projection: the slots this build multiplies, with an unstated charge left off
      // rather than written down as a zero.
      ratesUsdMicrosPerMillion: { input: 2_000_000, cachedRead: 200_000, output: 10_000_000, cacheWrite: 2_500_000 },
      source: { kind: 'manual' },
      lastSyncedAt: null,
      verifiedAt: '2026-07-01T00:00:00Z',
      validFrom: '2026-07-01T00:00:00Z',
      validThrough: null,
    });
    should(actual.equivalentApiCostUsdMicros).equal(3_870_000);
  });

  it('should snapshot provider-sync provenance and its sync instant', () => {
    // Arrange: where a price came from is READ off the row, not inferred. A synced rate carries the
    // feed and the address it came from; a manual one carries neither, and the two are different
    // shapes rather than a boolean beside an optional URL.
    const synced: AnalyticsPricingRate = {
      ...openAiRate,
      source: { kind: 'provider_sync', provider: 'openai', sourceUrl: 'https://prices.example/openai.json' },
      lastSyncedAt: '2026-07-20T09:30:00.000Z',
    };

    // Act
    const actual = snapshotAnalyticsUsagePricing(usage, [synced]);

    // Assert
    should(actual).have.property('kind', 'priced');
    if (actual.kind !== 'priced') throw new Error('expected priced usage');
    should(actual.rate.source).deepEqual({
      kind: 'provider_sync',
      provider: 'openai',
      sourceUrl: 'https://prices.example/openai.json',
    });
    should(actual.rate.lastSyncedAt).equal('2026-07-20T09:30:00.000Z');
  });

  it('should copy provenance onto the snapshot rather than sharing the catalog entry', () => {
    // A stored row is a FROZEN record of what priced it. `readonly` binds one reference at compile
    // time; it does not stop the caller who still owns the catalog object from editing the thing both
    // point at, which would let a later edit reach backwards into a snapshot taken months earlier.
    // Arrange
    const mutable: AnalyticsPricingRate = {
      ...openAiRate,
      source: { kind: 'provider_sync', provider: 'openai', sourceUrl: 'https://prices.example/openai.json' },
      lastSyncedAt: '2026-07-20T09:30:00.000Z',
    };

    // Act
    const actual = snapshotAnalyticsUsagePricing(usage, [mutable]);
    (mutable.source as { sourceUrl: string }).sourceUrl = 'https://attacker.example/prices.json';

    // Assert
    should(actual).have.property('kind', 'priced');
    if (actual.kind !== 'priced') throw new Error('expected priced usage');
    should(actual.rate.source).deepEqual({
      kind: 'provider_sync',
      provider: 'openai',
      sourceUrl: 'https://prices.example/openai.json',
    });
  });

  it('should charge reasoning tokens as a subset of output rather than in addition to it', () => {
    // THE ARITHMETIC DISTINGUISHES THE TWO READINGS. Codex reports `reasoning_output_tokens` as a
    // named part of its output total, so the output rate applies to what is LEFT after it:
    //   (1_000_000 - 100_000 - 100_000) uncached @ 2   =  1_600_000
    //   100_000 cached                            @ 0.2 =     20_000
    //   100_000 cache write                       @ 2.5 =    250_000
    //   (200_000 - 50_000) plain output           @ 10  =  1_500_000
    //   50_000 reasoning                          @ 30  =  1_500_000  (all figures USD micros/million)
    // Totalling 4_870_000. Treating reasoning as an ADDITIONAL 50_000 tokens beside the full output
    // would give 5_370_000, and charging it at the output rate would give 3_870_000; neither number
    // can be reached by this assertion.
    // Arrange
    const withReasoning: AnalyticsPricingRate = {
      ...openAiRate,
      rates: { ...openAiRate.rates, reasoning: 30_000_000 },
    };

    // Act
    const actual = snapshotAnalyticsUsagePricing({ ...usage, reasoningTokens: 50_000 }, [withReasoning]);

    // Assert
    should(actual).have.property('kind', 'priced');
    if (actual.kind !== 'priced') throw new Error('expected priced usage');
    should(actual.equivalentApiCostUsdMicros).equal(4_870_000);
    should(actual.rate.ratesUsdMicrosPerMillion.reasoning).equal(30_000_000);
  });

  it('should price the whole output at the output rate when no reasoning was reported', () => {
    // Null is not zero and it is not evidence: a harness that named no reasoning figure leaves the
    // output charged exactly as it was before this build learned the word.
    const withReasoningRate = { ...openAiRate, rates: { ...openAiRate.rates, reasoning: 30_000_000 } };

    should(snapshotAnalyticsUsagePricing({ ...usage, reasoningTokens: null }, [withReasoningRate])).have.property(
      'equivalentApiCostUsdMicros',
      3_870_000,
    );
    // A stated zero prices identically — the difference between the two is what may be REPORTED, not
    // what is charged — and it must not trip the missing-rate refusal on a catalog that states none.
    should(snapshotAnalyticsUsagePricing({ ...usage, reasoningTokens: 0 }, [openAiRate])).have.property(
      'equivalentApiCostUsdMicros',
      3_870_000,
    );
  });

  it('should refuse to price reasoning usage the catalog states no rate for', () => {
    // Charging reasoning at the output rate would be this build deciding a price the operator never
    // gave. An explicit refusal names the fact they can supply; a quiet fallback understates the bill.
    const actual = snapshotAnalyticsUsagePricing({ ...usage, reasoningTokens: 50_000 }, [openAiRate]);

    should(actual).have.property('kind', 'unpriced');
    should(actual).have.property('reason', 'missing_reasoning_rate');
  });

  it('should refuse a partial reasoning total without discarding the ordinary token evidence', () => {
    const withReasoning = { ...openAiRate, rates: { ...openAiRate.rates, reasoning: 30_000_000 } };

    const actual = snapshotAnalyticsUsagePricing({ ...usage, reasoningTokens: null, reasoningTokensIncomplete: true }, [
      withReasoning,
    ]);

    should(actual).have.property('kind', 'unpriced');
    should(actual).have.property('reason', 'incomplete_reasoning_counts');
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
    // Reasoning is a subset of output, so a figure larger than the output it sits inside is evidence
    // this daemon cannot reconcile — not a licence to charge the difference at some other rate.
    { patch: { reasoningTokens: 200_001 }, catalog: [openAiRate], reason: 'negative_non_reasoning_output' },
    { patch: { reasoningTokens: 1.5 }, catalog: [openAiRate], reason: 'invalid_token_counts' },
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
