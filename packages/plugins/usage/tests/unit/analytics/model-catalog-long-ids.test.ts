import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import type { ModelPriceCatalog } from '@ferretry/plugin-logins/contract';
import { modelCatalogPricingRates } from '../../../daemon/lib/analytics/model-catalog-rates.ts';

const price = {
  provider: 'openai',
  input: 2,
  output: 8,
  cacheRead: 0.2,
  source: 'https://prices.example.test/page',
  verified: '2026-11-02',
} as const;

describe('modelCatalogPricingRates keys', () => {
  it('keeps a short model id readable in its key', () => {
    const catalogs: readonly ModelPriceCatalog[] = [{ id: 'openai', codex: { models: [{ id: 'gpt-fake-1', price }] } }];

    expect(modelCatalogPricingRates(catalogs).map(rate => rate.pricingKey)).toEqual([
      'model-catalog:openai:gpt-fake-1',
    ]);
  });

  it('hashes a model id too long to spell in a key, so the key stays within the contract bound and stays the same', () => {
    const longId = `gpt-${'x'.repeat(120)}`;
    const catalogs: readonly ModelPriceCatalog[] = [{ id: 'openai', codex: { models: [{ id: longId, price }] } }];

    const [rate] = modelCatalogPricingRates(catalogs);

    const digest = createHash('sha256').update(longId).digest('hex').slice(0, 32);
    expect(rate?.modelId).toBe(longId);
    expect(rate?.pricingKey).toBe(`model-catalog:openai:${digest}`);
    expect(rate?.pricingKey.length).toBeLessThanOrEqual(128);
    expect(modelCatalogPricingRates(catalogs)[0]?.pricingKey).toBe(rate?.pricingKey as string);
  });
});
