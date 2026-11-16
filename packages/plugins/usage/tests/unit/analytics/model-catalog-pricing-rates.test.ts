/**
 * List prices (parity ledger F2, v4 `GET /v1/analytics/pricing`): the model catalogs' prices become the rates analytics
 * charges, one per model identity, the MAKER's catalog winning, Anthropic cache writes by duration, reasoning = output
 * unless stated, Claude Code's tier names as aliases of the maker's pinned model, and the operator's rates still winning.
 */
import { describe, expect, it } from 'bun:test';
import type { ModelPriceCatalog } from '@ferretry/plugin-logins/contract';
import type { AnalyticsPricingRate } from '../../../contract/index.ts';
import {
  effectiveAnalyticsPricing,
  modelCatalogPricingRates,
} from '../../../daemon/lib/analytics/model-catalog-rates.ts';

const SOURCE = 'https://prices.example.test/page';
const anthropicPrice = {
  provider: 'anthropic',
  input: 5,
  output: 25,
  cacheRead: 0.5,
  cacheWrite5m: 6.25,
  cacheWrite1h: 10,
  source: SOURCE,
  verified: '2026-11-01',
} as const;

const CATALOGS: readonly ModelPriceCatalog[] = [
  {
    id: 'openai',
    codex: {
      models: [
        {
          id: 'gpt-fake-1',
          price: {
            provider: 'openai',
            input: 2,
            output: 8,
            cacheRead: 0.2,
            cacheWrite: 1,
            source: SOURCE,
            verified: '2026-11-02',
          },
        },
      ],
    },
  },
  // A gateway lists the maker's model too (cheaper, so a wrong pick is visible), re-pins `opus` to its own model and lists a
  // deployment literally named `opus`.
  {
    id: 'azure',
    claude: {
      models: [
        { id: 'claude-opus-fake', price: { ...anthropicPrice, input: 1, output: 1, cacheWrite5m: 1, cacheWrite1h: 1 } },
        { id: 'opus', price: { ...anthropicPrice, input: 9, output: 9 } },
      ],
      tiers: { opus: 'opus' },
    },
  },
  {
    id: 'anthropic',
    claude: {
      models: [
        { id: 'claude-opus-fake', price: anthropicPrice },
        { id: 'claude-haiku-fake', price: { ...anthropicPrice, input: 1, output: 5, reasoning: 7 } },
      ],
      tiers: { opus: 'claude-opus-fake' },
    },
    codex: undefined,
  },
];

const byModel = (rates: readonly AnalyticsPricingRate[], id: string): AnalyticsPricingRate => {
  const found = rates.find(rate => rate.modelId === id);
  if (found === undefined) throw new Error(`no rate for ${id}`);
  return found;
};

describe('modelCatalogPricingRates', () => {
  const rates = modelCatalogPricingRates(CATALOGS);

  it('builds one rate per model identity, never a deployment alias of a tier name', () => {
    expect(rates.map(rate => rate.modelId).sort()).toEqual(['claude-haiku-fake', 'claude-opus-fake', 'gpt-fake-1']);
  });

  it("takes the maker's catalog's price and aliases the tier name Anthropic pins", () => {
    const opus = byModel(rates, 'claude-opus-fake');
    expect(opus.rates.input).toBe(5_000_000);
    expect(opus.aliases).toEqual(['opus']);
    expect(opus.source).toEqual({ kind: 'model_catalog', catalog: 'anthropic', sourceUrl: SOURCE });
  });

  it('prices Anthropic cache writes by duration and every other maker with one cache write', () => {
    const opus = byModel(rates, 'claude-opus-fake').rates;
    expect([opus.cacheWrite, opus.cacheWrite5m, opus.cacheWrite1h]).toEqual([null, 6_250_000, 10_000_000]);
    const gpt = byModel(rates, 'gpt-fake-1').rates;
    expect([gpt.cacheWrite, gpt.cacheWrite5m, gpt.cacheWrite1h, gpt.cachedInput]).toEqual([
      1_000_000,
      null,
      null,
      200_000,
    ]);
  });

  it('bills reasoning as output unless the catalog states a price', () => {
    expect(byModel(rates, 'claude-opus-fake').rates.reasoning).toBe(25_000_000);
    expect(byModel(rates, 'claude-haiku-fake').rates.reasoning).toBe(7_000_000);
  });

  it('does not depend on the order the catalogs arrive in', () => {
    expect(modelCatalogPricingRates([...CATALOGS].reverse())).toEqual(rates);
  });
});

describe('effectiveAnalyticsPricing', () => {
  it('lets the operator rate win per model, by id or alias', () => {
    const catalogRates = modelCatalogPricingRates(CATALOGS);
    const operator: AnalyticsPricingRate = {
      ...byModel(catalogRates, 'gpt-fake-1'),
      pricingKey: 'mine',
      modelId: 'claude-opus-fake',
      aliases: [],
      source: { kind: 'manual' },
      rates: { ...byModel(catalogRates, 'gpt-fake-1').rates, input: 42 },
    };
    const effective = effectiveAnalyticsPricing([operator], catalogRates);
    expect(effective.filter(rate => rate.modelId === 'claude-opus-fake')).toEqual([operator]);
    expect(effective.map(rate => rate.modelId).sort()).toEqual(['claude-haiku-fake', 'claude-opus-fake', 'gpt-fake-1']);
  });
});
