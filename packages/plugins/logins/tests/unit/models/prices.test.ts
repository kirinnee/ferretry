import { describe, it } from 'bun:test';
import should from 'should';
import { ModelPriceCatalogSchema } from '../../../contract/index.ts';
import { builtInModelCatalogs } from '../../../daemon/lib/catalog/catalog.ts';
import { modelPriceCatalogs } from '../../../daemon/lib/models/prices.ts';

describe('modelPriceCatalogs (what Usage prices a session from)', () => {
  const catalogs = modelPriceCatalogs(builtInModelCatalogs());

  it('should carry every priced model with the whole price, and no model that states none', () => {
    // Act
    const parsed = catalogs.map(catalog => ModelPriceCatalogSchema.parse(catalog));
    const priced = parsed.flatMap(catalog => [...(catalog.claude?.models ?? []), ...(catalog.codex?.models ?? [])]);

    // Assert
    should(priced.length).be.above(0);
    for (const model of priced) {
      should(model.price.input).be.a.Number();
      should(model.price.cacheRead).be.a.Number();
      should(model.price.source).startWith('https://');
    }
    const anthropic = parsed.find(catalog => catalog.id === 'anthropic')?.claude?.models ?? [];
    should(
      anthropic.every(model => model.price.cacheWrite5m !== undefined && model.price.cacheWrite1h !== undefined),
    ).be.true();
  });

  it('should pin Claude Code’s tier slots to bare model ids, as the maker’s catalog states them', () => {
    // Act
    const tiers = catalogs.find(catalog => catalog.id === 'anthropic')?.claude?.tiers;

    // Assert
    should(Object.keys(tiers ?? {}).sort()).eql(['haiku', 'opus', 'sonnet']);
    for (const id of Object.values(tiers ?? {})) should(id).not.match(/\[/u);
  });
});
