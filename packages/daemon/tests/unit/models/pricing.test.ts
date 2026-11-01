import { describe, it } from 'bun:test';
import { builtInModelCatalogs, type CatalogPrice, type ModelCatalog } from '@ferretry/fleet';
import type { AnalyticsPricingRate } from '@ferretry/protocol';
import should from 'should';
import { type AnalyticsTokenUsage, snapshotAnalyticsUsagePricing } from '../../../src/lib/analytics/pricing.ts';
import { analyticsPricingCatalogFingerprint } from '../../../src/lib/analytics/store.ts';
import {
  effectiveAnalyticsPricing,
  MODEL_CATALOG_PRICE_VALID_FROM,
  modelCatalogPricingRates,
  unclaimedModelCatalogRates,
} from '../../../src/lib/models/pricing.ts';

const HALVES = ['claude', 'codex'] as const;

const built = builtInModelCatalogs();

/** One session's worth of tokens on `model`, with every part a harness reports — cache writes and reasoning. */
const session = (pricingModel: string, price: CatalogPrice): AnalyticsTokenUsage => ({
  pricingModel,
  createdAt: '2024-03-01T00:00:00.000Z',
  inputTokens: 1_000_000,
  cachedInputTokens: 600_000,
  cacheWriteInputTokens: 100_000,
  ...(price.provider === 'anthropic' ? { cacheWrite5mInputTokens: 60_000, cacheWrite1hInputTokens: 40_000 } : {}),
  outputTokens: 200_000,
  reasoningTokens: 50_000,
});

const operatorRate = (modelId: string, aliases: readonly string[] = []): AnalyticsPricingRate => ({
  pricingKey: `operator:${modelId}`,
  modelId,
  aliases,
  provider: 'anthropic',
  currency: 'USD',
  rates: {
    input: 1_000_000,
    output: 1_000_000,
    cachedInput: 1_000_000,
    cacheWrite: null,
    cacheWrite5m: 1_000_000,
    cacheWrite1h: 1_000_000,
    reasoning: 1_000_000,
    image: null,
    tool: null,
  },
  source: { kind: 'manual' },
  validFrom: '2026-01-01T00:00:00.000Z',
  validThrough: null,
  verifiedAt: '2026-01-01T00:00:00.000Z',
  lastSyncedAt: null,
});

const catalogWith = (id: string, models: ModelCatalog['claude']): ModelCatalog => ({
  ...(built.anthropic as ModelCatalog),
  id,
  claude: models,
});

describe('model catalog prices in analytics', () => {
  it('should leave every session unpriced with no operator rates and no catalog prices — the old behaviour', () => {
    // Arrange
    const price = built.anthropic?.claude?.models[0]?.price as CatalogPrice;

    // Act
    const actual = snapshotAnalyticsUsagePricing(session('claude-opus-5-5', price), effectiveAnalyticsPricing([], {}));

    // Assert
    should(actual).match({ kind: 'unpriced', reason: 'unknown_pricing_model' });
  });

  it('should price a session on every priced fleet model, by each spelling a transcript records it as', () => {
    // Arrange
    const pricing = effectiveAnalyticsPricing([], built);
    const unpriced: string[] = [];
    let priced = 0;

    // Act
    for (const catalog of Object.values(built)) {
      for (const half of HALVES) {
        for (const model of catalog[half]?.models ?? []) {
          if (model.price === undefined) continue;
          for (const spelling of [model.id, `${model.id}${model.suffix ?? '[1m]'}`, `${model.id}-20261001`]) {
            const actual = snapshotAnalyticsUsagePricing(session(spelling, model.price), pricing);
            if (actual.kind === 'priced') priced += 1;
            else unpriced.push(`${catalog.id} ${spelling}: ${actual.reason}`);
          }
        }
      }
    }

    // Assert
    should(unpriced).deepEqual([]);
    should(priced).be.above(100);
  });

  it('should charge Opus 5.5 at Anthropic’s list price, cache write lifetimes and thinking included', () => {
    // Arrange
    const price = built.anthropic?.claude?.models[0]?.price as CatalogPrice;

    // Act
    const actual = snapshotAnalyticsUsagePricing(
      session('claude-opus-5-5[1m]', price),
      effectiveAnalyticsPricing([], built),
    );

    // Assert: 300k uncached × $4 + 600k read × $0.20 + 60k × $5 + 40k × $8 + 150k out × $20 + 50k thinking × $20.
    should(actual).match({
      kind: 'priced',
      equivalentApiCostUsdMicros: 1_200_000 + 120_000 + 300_000 + 320_000 + 3_000_000 + 1_000_000,
      rate: {
        modelId: 'claude-opus-5-5',
        provider: 'anthropic',
        source: {
          kind: 'model_catalog',
          catalog: 'anthropic',
          sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
        },
        verifiedAt: '2026-10-20T00:00:00.000Z',
        validFrom: MODEL_CATALOG_PRICE_VALID_FROM,
        lastSyncedAt: null,
      },
    });
  });

  it('should price a Codex session’s reasoning at GPT’s output rate, and a Bedrock version as its model', () => {
    // Arrange
    const pricing = effectiveAnalyticsPricing([], built);
    const astra = built.openai?.codex?.models.find(model => model.id === 'gpt-6-astra')?.price as CatalogPrice;
    const bedrock = built['amazon-bedrock']?.claude?.models[0]?.price as CatalogPrice;

    // Act
    const codex = snapshotAnalyticsUsagePricing(session('gpt-6-astra', astra), pricing);
    const versioned = snapshotAnalyticsUsagePricing(
      session('us.anthropic.claude-opus-5-5-20261001-v1:0', bedrock),
      pricing,
    );

    // Assert: 300k × $10 + 600k × $1 + 100k write × $12.50 + 150k out × $50 + 50k reasoning × $50.
    should(codex).match({
      kind: 'priced',
      equivalentApiCostUsdMicros: 3_000_000 + 600_000 + 1_250_000 + 7_500_000 + 2_500_000,
    });
    should(versioned).match({ kind: 'priced', rate: { source: { catalog: 'amazon-bedrock' } } });
  });

  it('should leave a model whose catalog gives no price unpriced, with the reason', () => {
    // Arrange
    const pricing = effectiveAnalyticsPricing([], built);
    const price = built.openai?.codex?.models[0]?.price as CatalogPrice;

    // Act
    const local = snapshotAnalyticsUsagePricing(session('gpt-oss:20b', price), pricing);

    // Assert
    should(local).match({ kind: 'unpriced', reason: 'unknown_pricing_model' });
  });

  it('should give a model several catalogs list its maker’s price, else the first catalog’s by id', () => {
    // Act
    const rates = modelCatalogPricingRates(built);
    const of = (modelId: string) => rates.filter(rate => rate.modelId === modelId);

    // Assert
    should(of('claude-opus-5-5').map(rate => rate.source)).match([{ kind: 'model_catalog', catalog: 'anthropic' }]);
    should(of('gpt-6-astra').map(rate => rate.source)).match([{ catalog: 'openai' }]);
    should(of('deepseek-flash').map(rate => rate.source)).match([{ catalog: 'deepseek' }]);
    should(of('~openai/gpt-sol-latest').map(rate => rate.source)).match([{ catalog: 'openrouter' }]);
    should(new Set(rates.map(rate => rate.pricingKey)).size).equal(rates.length);
  });

  it('should let an operator rate win its whole model, by id or by alias', () => {
    // Arrange
    const operator = [operatorRate('claude-opus-5-5'), operatorRate('house-sonnet', ['CLAUDE-SONNET-5-5'])];

    // Act
    const effective = effectiveAnalyticsPricing(operator, built);
    const unclaimed = unclaimedModelCatalogRates(operator, modelCatalogPricingRates(built));

    // Assert
    should(effective.slice(0, 2)).deepEqual(operator);
    should(unclaimed.some(rate => rate.modelId === 'claude-opus-5-5')).be.false();
    should(unclaimed.some(rate => rate.modelId === 'claude-sonnet-5-5')).be.false();
    should(unclaimed.some(rate => rate.modelId === 'claude-haiku-5-5')).be.true();
    should(effective.length).equal(operator.length + unclaimed.length);
  });

  it('should move the pricing fingerprint when a published price moves, so stored sessions re-price', () => {
    // Arrange: the fingerprint is part of every row's ingest signature (`analyticsIngestSignature`).
    const anthropic = built.anthropic as ModelCatalog;
    const half = anthropic.claude as NonNullable<ModelCatalog['claude']>;
    const cheaper = {
      ...built,
      anthropic: {
        ...anthropic,
        claude: {
          ...half,
          models: half.models.map((model, index) =>
            index === 0 ? { ...model, price: { ...(model.price as CatalogPrice), output: 18 } } : model,
          ),
        },
      },
    };

    // Act
    const before = analyticsPricingCatalogFingerprint(effectiveAnalyticsPricing([], built));
    const after = analyticsPricingCatalogFingerprint(effectiveAnalyticsPricing([], cheaper));
    const again = analyticsPricingCatalogFingerprint(effectiveAnalyticsPricing([], builtInModelCatalogs()));

    // Assert
    should(after).not.equal(before);
    should(again).equal(before);
  });

  it('should bound a long id’s key, and leave out a price the analytics contract cannot hold', () => {
    // Arrange
    const price = built.anthropic?.claude?.models[0]?.price as CatalogPrice;
    const model = built.anthropic?.claude?.models[0] as NonNullable<ModelCatalog['claude']>['models'][number];
    const keyed = `m-${'k'.repeat(115)}`;
    const tooLong = `m-${'x'.repeat(140)}`;
    const catalogs = {
      long: catalogWith('long', {
        models: [
          { ...model, id: keyed, default: true },
          { ...model, id: tooLong, default: false, price },
        ],
      }),
    };

    // Act
    const rates = modelCatalogPricingRates(catalogs);

    // Assert
    should(rates.map(rate => rate.modelId)).deepEqual([keyed]);
    should(rates[0]?.pricingKey).match(/^model-catalog:long:[0-9a-f]{32}$/u);
  });
});

describe('short tier names in analytics pricing', () => {
  const claudeUsage = (pricingModel: string): AnalyticsTokenUsage => ({
    pricingModel,
    createdAt: '2026-10-25T00:00:00.000Z',
    inputTokens: 1_000,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 1_000,
  });

  it('should resolve opus, sonnet and haiku to the models Anthropic’s catalog pins them to', () => {
    // Arrange
    const pricing = effectiveAnalyticsPricing([], built);

    // Act
    const actual = ['opus', 'sonnet', 'haiku', 'Opus'].map(name =>
      snapshotAnalyticsUsagePricing(claudeUsage(name), pricing),
    );

    // Assert
    should(actual.map(snapshot => (snapshot.kind === 'priced' ? snapshot.identity.modelId : snapshot.kind))).deepEqual([
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
      'claude-opus-5-5',
    ]);
  });

  it('should price a short name exactly as the canonical id it names', () => {
    // Arrange
    const pricing = effectiveAnalyticsPricing([], built);

    // Act
    const short = snapshotAnalyticsUsagePricing(claudeUsage('opus'), pricing);
    const canonical = snapshotAnalyticsUsagePricing(claudeUsage('claude-opus-5-5'), pricing);

    // Assert
    should(short.kind).equal('priced');
    should(short).match({
      equivalentApiCostUsdMicros: (canonical as { equivalentApiCostUsdMicros: number }).equivalentApiCostUsdMicros,
    });
  });

  it('should not let another catalog’s re-pinned tier slot claim the name', () => {
    // Arrange: Z.ai pins "opus" to a GLM model, and so would any gateway.
    const rates = modelCatalogPricingRates(built);

    // Act
    const owners = rates.filter(rate => rate.aliases.includes('opus')).map(rate => rate.modelId);

    // Assert
    should(owners).deepEqual(['claude-opus-5-5']);
  });

  it('should leave a short name to the operator when the operator prices the model', () => {
    // Arrange
    const operator = [operatorRate('claude-opus-5-5')];
    const pricing = effectiveAnalyticsPricing(operator, built);

    // Act
    const actual = snapshotAnalyticsUsagePricing(claudeUsage('opus'), pricing);

    // Assert: the operator's rate won the model, and took none of the catalog's aliases with it.
    should(actual).match({ kind: 'unpriced', reason: 'unknown_pricing_model' });
  });

  it('should change the pricing fingerprint when the aliases do, so stored rows are re-priced', () => {
    // Arrange
    const withAliases = modelCatalogPricingRates(built);
    const without = withAliases.map(rate => ({ ...rate, aliases: [] }));

    // Act / Assert
    should(analyticsPricingCatalogFingerprint(withAliases)).not.equal(analyticsPricingCatalogFingerprint(without));
  });
});
