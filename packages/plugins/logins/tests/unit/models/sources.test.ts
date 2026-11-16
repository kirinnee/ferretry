import { describe, it } from 'bun:test';
import should from 'should';
import { builtInModelCatalogs } from '../../../daemon/lib/catalog/catalog.ts';
import { modelCatalogSourcesView } from '../../../daemon/lib/models/sources.ts';
import { builtInPresets } from '../../../daemon/lib/presets/catalog.ts';

describe('modelCatalogSourcesView (what Runtimes derives a runtime’s models from)', () => {
  const view = modelCatalogSourcesView({ catalogs: builtInModelCatalogs(), presets: builtInPresets() });

  it('should carry the maker’s catalog whole, so a runtime on a sign-in offers every model it lists', () => {
    // Act
    const models = view.catalogs.anthropic?.claude?.models.map(model => model.id) ?? [];

    // Assert
    should(models.length).be.above(0);
    should(view.catalogs.anthropic?.origin).equal('built-in');
  });

  it('should name the catalog a preset reads and the variables it takes, never a value', () => {
    // Act
    const zai = view.presets.find(preset => preset.catalog === 'zai');

    // Assert
    should(zai).not.be.undefined();
    should(zai?.variables.claude?.length ?? 0).be.above(0);
    should(JSON.stringify(view.presets)).not.containEql('secret');
  });
});
