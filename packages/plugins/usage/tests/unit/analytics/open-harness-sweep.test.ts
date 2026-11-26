import { describe, expect, test } from 'bun:test';
import { ModelPriceCatalogSchema } from '@ferretry/plugin-logins/contract';
import { modelCatalogPricingRates, PRICED_HALVES } from '../../../daemon/lib/analytics/model-catalog-rates.ts';

/**
 * U4b part 4b, Usage. The halves a priced catalog carries are Logins' own price wire's, not a second list of the same two
 * words: a half added to that wire is read here without an edit.
 */

describe('the halves analytics prices', () => {
  test('are the keys of the price wire a catalog arrives in, bar its id', () => {
    expect([...PRICED_HALVES] as string[]).toEqual(
      Object.keys(ModelPriceCatalogSchema.shape).filter(key => key !== 'id'),
    );
    expect([...PRICED_HALVES] as string[]).toEqual(['claude', 'codex']);
  });

  test('both shipped halves are still priced', () => {
    // Arrange
    const price = {
      provider: 'openai',
      input: 1,
      output: 2,
      cacheRead: 0.1,
      source: 'https://example.com/prices',
      verified: '2026-11-01',
    } as const;
    const catalog = {
      id: 'openai',
      claude: { models: [{ id: 'model-a', price }] },
      codex: { models: [{ id: 'model-b', price }] },
    };

    // Act
    const rates = modelCatalogPricingRates([catalog as never]);

    // Assert
    expect(rates.map(rate => rate.modelId).sort()).toEqual(['model-a', 'model-b']);
  });
});
