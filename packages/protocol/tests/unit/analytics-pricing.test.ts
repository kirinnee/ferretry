import { describe, it } from 'bun:test';
import should from 'should';
import * as pricing from '../../src/lib/analytics-pricing.ts';
import {
  ANALYTICS_PRICING_RATE_SLOTS,
  ANALYTICS_PRICING_RATE_UNITS,
  ANALYTICS_PRICING_TOKEN_SLOTS,
  AnalyticsPricingCatalogSchema,
  AnalyticsPricingCurrencySchema,
  AnalyticsPricingFeedEntrySchema,
  AnalyticsPricingFeedSchema,
  AnalyticsPricingProviderSchema,
  AnalyticsPricingRateSchema,
  AnalyticsPricingRatesSchema,
  AnalyticsPricingRateUnitSchema,
  AnalyticsPricingSourceSchema,
  AnalyticsPricingSourceUrlSchema,
  analyticsPricingRateUnit,
  ConfiguredAnalyticsPricingSourceSchema,
  ConfiguredAnalyticsPricingSourcesSchema,
  type AnalyticsPricingRates,
} from '../../src/lib/index.ts';
import { INSTANT } from '../fixtures.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const LATER = '2026-08-30T12:00:00Z';
const FEED_URL = 'https://prices.example.test/openai.json';

const rates: AnalyticsPricingRates = {
  input: 2_000_000,
  output: 10_000_000,
  cachedInput: 200_000,
  cacheWrite: 2_500_000,
  cacheWrite5m: null,
  cacheWrite1h: null,
  reasoning: null,
  image: null,
  tool: null,
};

const manualRate = {
  pricingKey: 'operator:model-a:2026-07',
  modelId: 'model-a',
  aliases: ['model-a-preview'],
  provider: 'openai',
  currency: 'USD',
  rates,
  source: { kind: 'manual' },
  validFrom: INSTANT,
  validThrough: null,
  verifiedAt: INSTANT,
  lastSyncedAt: null,
} as const;

const syncedRate = {
  ...manualRate,
  pricingKey: 'sync:model-a:2026-08',
  validFrom: LATER,
  source: { kind: 'provider_sync', provider: 'openai', sourceUrl: FEED_URL },
  lastSyncedAt: LATER,
} as const;

/** The spelling an operator already has on disk: per-million rates, and instants `Date.parse` took. */
const legacyRate = {
  pricingKey: 'operator:model-b:2026-07',
  modelId: 'model-b',
  provider: 'anthropic',
  ratesUsdMicrosPerMillion: {
    input: 15_000_000,
    cachedRead: 1_500_000,
    cacheWrite5m: 18_750_000,
    cacheWrite1h: 30_000_000,
    output: 75_000_000,
  },
  verifiedAt: '2026-07-01',
  validFrom: '2026-07-01',
  validThrough: '2026-08-01',
} as const;

const configuredSource = { id: 'openai-public', provider: 'openai', url: FEED_URL, enabled: true } as const;

const feedEntry = {
  pricingKey: 'openai:model-a:2026-08',
  modelId: 'model-a',
  aliases: ['model-a-preview'],
  currency: 'USD',
  rates,
  validFrom: INSTANT,
  validThrough: null,
} as const;

const cases: readonly SchemaCase[] = [
  { name: 'provider', schema: AnalyticsPricingProviderSchema, value: 'anthropic' },
  { name: 'currency', schema: AnalyticsPricingCurrencySchema, value: 'USD' },
  { name: 'rate unit', schema: AnalyticsPricingRateUnitSchema, value: 'tool_call' },
  { name: 'rates', schema: AnalyticsPricingRatesSchema, value: rates },
  { name: 'source url', schema: AnalyticsPricingSourceUrlSchema, value: FEED_URL },
  { name: 'manual source', schema: AnalyticsPricingSourceSchema, value: { kind: 'manual' } },
  { name: 'rate', schema: AnalyticsPricingRateSchema, value: manualRate },
  { name: 'catalog', schema: AnalyticsPricingCatalogSchema, value: [manualRate, syncedRate] },
  { name: 'configured source', schema: ConfiguredAnalyticsPricingSourceSchema, value: configuredSource },
  { name: 'configured sources', schema: ConfiguredAnalyticsPricingSourcesSchema, value: [configuredSource] },
  { name: 'feed entry', schema: AnalyticsPricingFeedEntrySchema, value: feedEntry },
  { name: 'feed', schema: AnalyticsPricingFeedSchema, value: { entries: [feedEntry] } },
];

describe('analytics pricing contract', () => {
  it('should round-trip every pricing schema and cover all of them', () => {
    // Act + Assert
    assertRoundTrips(cases);
    assertCoversEverySchema(pricing, cases);
  });

  it('should denominate every slot exactly once, and never bill an image or a tool call in tokens', () => {
    // Arrange
    const expected = Object.keys(rates).sort();

    // Act
    const actual = [...ANALYTICS_PRICING_RATE_SLOTS].sort();

    // Assert
    should(actual).deepEqual(expected);
    should(analyticsPricingRateUnit('reasoning')).equal('million_tokens');
    should(analyticsPricingRateUnit('image')).equal('image');
    should(analyticsPricingRateUnit('tool')).equal('tool_call');
    should([...ANALYTICS_PRICING_TOKEN_SLOTS].sort()).deepEqual([
      'cacheWrite',
      'cacheWrite1h',
      'cacheWrite5m',
      'cachedInput',
      'input',
      'output',
      'reasoning',
    ]);
    should(ANALYTICS_PRICING_RATE_UNITS.image).equal('image');
  });

  it('should keep an unsupplied price visible as a null instead of a zero', () => {
    // Act
    const actual = AnalyticsPricingRatesSchema.safeParse({ ...rates, image: undefined });

    // Assert: a total record has no silent absence — the key is stated or the document is refused.
    should(actual.success).be.false();
    should(AnalyticsPricingRatesSchema.parse({ ...rates, image: null }).image).be.null();
  });

  it('should refuse an address that could carry a credential or reach a plaintext host', () => {
    // Act + Assert
    assertRejects([
      { name: 'insecure', schema: AnalyticsPricingSourceUrlSchema, value: 'http://prices.example.test/a.json' },
      { name: 'credentials', schema: AnalyticsPricingSourceUrlSchema, value: 'https://user:key@example.test/a.json' },
      { name: 'fragment', schema: AnalyticsPricingSourceUrlSchema, value: 'https://example.test/a.json#token' },
      { name: 'not a url', schema: AnalyticsPricingSourceUrlSchema, value: 'prices.example.test' },
    ]);
  });

  it('should keep manual and provider-synced provenance mechanically apart', () => {
    // Act
    const synced = AnalyticsPricingRateSchema.parse(syncedRate);
    const manual = AnalyticsPricingRateSchema.parse(manualRate);
    const mismatched = AnalyticsPricingRateSchema.safeParse({
      ...syncedRate,
      source: { kind: 'provider_sync', provider: 'anthropic', sourceUrl: FEED_URL },
    });
    const manualButSynced = AnalyticsPricingRateSchema.safeParse({ ...manualRate, lastSyncedAt: INSTANT });

    // Assert
    should(synced.source.kind).equal('provider_sync');
    should(synced.lastSyncedAt).equal(LATER);
    should(manual.lastSyncedAt).be.null();
    should(mismatched.success).be.false();
    should(manualButSynced.success).be.false();
  });

  it('should refuse a synced rate that will not say when it was synced', () => {
    // Checking only that a manual rate has no sync instant leaves the useful half of the claim
    // optional: `provider_sync` with a null `lastSyncedAt` reads as freshly fetched and carries no
    // evidence anybody can check it against.
    // Act
    const undated = AnalyticsPricingRateSchema.safeParse({ ...syncedRate, lastSyncedAt: null });
    const looselyDated = AnalyticsPricingRateSchema.safeParse({ ...syncedRate, lastSyncedAt: '2026-08-30' });

    // Assert: named by path, so this proves the new rule fired rather than some other refusal.
    should(undated.success).be.false();
    should(undated.error?.issues.map(issue => issue.path)).containDeep([['lastSyncedAt']]);
    // And it is the shared strict instant, not the legacy input domain: only the on-disk catalog
    // spelling canonicalizes a date-only value, and a synced rate never came from that document.
    should(looselyDated.success).be.false();
  });

  it('should refuse an effective window that ends before it begins', () => {
    // Act
    const backwards = AnalyticsPricingRateSchema.safeParse({ ...manualRate, validFrom: LATER, validThrough: INSTANT });
    const openEnded = AnalyticsPricingRateSchema.parse(manualRate);

    // Assert
    should(backwards.success).be.false();
    should(openEnded.validThrough).be.null();
  });

  it.each([
    ['a five-minute split', { cacheWrite: 1, cacheWrite5m: 2, cacheWrite1h: null }],
    ['an hour split', { cacheWrite: 1, cacheWrite5m: null, cacheWrite1h: 3 }],
  ])('should refuse two answers for one cache write (%s)', (_name, patch) => {
    // Act
    const actual = AnalyticsPricingRateSchema.safeParse({ ...manualRate, rates: { ...rates, ...patch } });

    // Assert
    should(actual.success).be.false();
  });

  it('should read the shape already on disk into the canonical one', () => {
    // Act
    const actual = AnalyticsPricingRateSchema.parse(legacyRate);
    const openEnded = AnalyticsPricingRateSchema.parse({
      ...legacyRate,
      ratesUsdMicrosPerMillion: { input: 1, cachedRead: 2, cacheWrite: 3, output: 4 },
      validThrough: undefined,
    });

    // Assert
    should(actual).deepEqual({
      pricingKey: 'operator:model-b:2026-07',
      modelId: 'model-b',
      aliases: [],
      provider: 'anthropic',
      currency: 'USD',
      rates: {
        input: 15_000_000,
        output: 75_000_000,
        cachedInput: 1_500_000,
        cacheWrite: null,
        cacheWrite5m: 18_750_000,
        cacheWrite1h: 30_000_000,
        reasoning: null,
        image: null,
        tool: null,
      },
      source: { kind: 'manual' },
      // A date-only instant is what the previous schema accepted, so it is read and canonicalized
      // rather than refused: refusing it would take a daemon down over a price it already had.
      validFrom: '2026-07-01T00:00:00.000Z',
      validThrough: '2026-08-01T00:00:00.000Z',
      verifiedAt: '2026-07-01T00:00:00.000Z',
      lastSyncedAt: null,
    });
    should(openEnded.rates.cacheWrite).equal(3);
    should(openEnded.rates.cacheWrite5m).be.null();
    should(openEnded.validThrough).be.null();
  });

  it('should refuse a legacy entry whose instant was never a date at all', () => {
    // Act + Assert
    assertRejects([
      {
        name: 'unparseable',
        schema: AnalyticsPricingRateSchema,
        value: { ...legacyRate, verifiedAt: 'whenever' },
      },
      {
        name: 'both spellings at once',
        schema: AnalyticsPricingRateSchema,
        value: { ...manualRate, ratesUsdMicrosPerMillion: { input: 1, cachedRead: 1, output: 1 } },
      },
    ]);
  });

  it('should refuse damaged or ambiguous evidence before anything can be priced with it', () => {
    // A catalog cannot name two prices for the same effective model instant, and an alias must never
    // resolve to two models: either would make a plausible amount depend on incidental catalog order.
    // Act + Assert
    assertRejects([
      {
        name: 'duplicate pricing key',
        schema: AnalyticsPricingCatalogSchema,
        value: [manualRate, { ...manualRate, modelId: 'model-c', validFrom: LATER }],
      },
      {
        name: 'duplicate effective identity',
        schema: AnalyticsPricingCatalogSchema,
        value: [manualRate, { ...manualRate, pricingKey: 'other', aliases: [] }],
      },
      {
        name: 'alias identifying two models',
        schema: AnalyticsPricingCatalogSchema,
        value: [
          manualRate,
          { ...manualRate, pricingKey: 'other', modelId: 'model-c', validFrom: LATER, aliases: ['MODEL-A'] },
        ],
      },
    ]);
  });

  it('should accept one model priced over several windows, aliases and all', () => {
    // Arrange
    const later = { ...manualRate, pricingKey: 'operator:model-a:2026-08', validFrom: LATER };

    // Act
    const actual = AnalyticsPricingCatalogSchema.parse([manualRate, later]);

    // Assert: the same alias owned by the same model twice is agreement, not a conflict.
    should(actual).have.length(2);
    should(actual[1]?.validFrom).equal(LATER);
  });

  it('should name a configured feed by identifier and refuse a repeated one', () => {
    // Act
    const parsed = ConfiguredAnalyticsPricingSourcesSchema.parse([
      { id: 'openai-public', provider: 'openai', url: FEED_URL },
    ]);
    const repeated = ConfiguredAnalyticsPricingSourcesSchema.safeParse([configuredSource, configuredSource]);
    const punctuated = ConfiguredAnalyticsPricingSourceSchema.safeParse({ ...configuredSource, id: '-leading' });

    // Assert
    should(parsed[0]?.enabled).be.true();
    should(repeated.success).be.false();
    should(punctuated.success).be.false();
  });

  it('should refuse a feed that describes its own provenance', () => {
    // A feed states prices; the daemon stamps where they came from and when it fetched them.
    // Act + Assert
    assertRejects([
      {
        name: 'claimed provider',
        schema: AnalyticsPricingFeedEntrySchema,
        value: { ...feedEntry, provider: 'openai' },
      },
      {
        name: 'claimed sync time',
        schema: AnalyticsPricingFeedEntrySchema,
        value: { ...feedEntry, lastSyncedAt: INSTANT },
      },
      { name: 'claimed source', schema: AnalyticsPricingFeedEntrySchema, value: { ...feedEntry, source: FEED_URL } },
    ]);
    should(AnalyticsPricingFeedEntrySchema.parse({ ...feedEntry, aliases: undefined }).aliases).deepEqual([]);
  });
});
