import { describe, it } from 'bun:test';
import { builtInModelCatalogs } from '@ferretry/fleet';
import { ModelCatalogsViewSchema } from '@ferretry/protocol';
import should from 'should';
import { modelCatalogsView } from '../../../src/lib/models/view.ts';

describe('modelCatalogsView', () => {
  it('should list every catalog with its models as the CLI is handed them, and the published state', () => {
    // Act
    const view = ModelCatalogsViewSchema.parse(
      modelCatalogsView(builtInModelCatalogs(), { origin: 'https://ferretry.pages.dev', enabled: true, version: 4 }),
    );

    // Assert
    const deepseek = view.catalogs.find(catalog => catalog.id === 'deepseek');
    should(deepseek?.claude?.find(model => model.default)).match({
      id: 'deepseek-flash[1m]',
      tier: 'fast',
      context: 1_000_000,
    });
    should(deepseek?.codex?.find(model => model.default)?.id).equal('deepseek-flash');
    should(view.catalogs.find(catalog => catalog.id === 'openai')?.claude).be.undefined();
    should(view.catalogs.find(catalog => catalog.id === 'anthropic')?.codex).be.undefined();
    should(
      view.catalogs.find(catalog => catalog.id === 'minimax')?.claude?.find(model => model.id === 'MiniMax-M2.7'),
    ).have.property('context');
    should(view.published).deepEqual({ origin: 'https://ferretry.pages.dev', enabled: true, version: 4 });
  });
});
