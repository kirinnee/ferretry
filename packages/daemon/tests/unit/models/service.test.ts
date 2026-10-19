import { describe, it } from 'bun:test';
import { builtInModelCatalogs, builtInPresets, type ModelCatalog } from '@ferretry/fleet';
import should from 'should';
import { ModelCatalogService } from '../../../src/lib/models/service.ts';

const BUILT_IN = builtInModelCatalogs();
const zai = BUILT_IN.zai as ModelCatalog;

describe('ModelCatalogService', () => {
  it('should read the built-in catalogs when nothing else is there', async () => {
    // Arrange
    const service = new ModelCatalogService({ files: async () => ({}), presets: async () => builtInPresets() });

    // Act
    const sources = await service.sources();

    // Assert
    should(Object.keys(sources.catalogs)).deepEqual(Object.keys(BUILT_IN));
    should(sources.presets.length).be.above(0);
  });

  it('should lay the published catalog over the built-in one, and this machine’s file over both', async () => {
    // Arrange
    const published = { ...zai, origin: 'published' as const, label: 'Published' };
    const file = { ...zai, origin: 'file' as const, label: 'Mine' };
    const service = new ModelCatalogService(
      { files: async () => ({ zai: file }), published: async () => ({ zai: published }), presets: async () => [] },
      { zai },
    );
    const unpublished = new ModelCatalogService(
      { files: async () => ({}), published: async () => undefined, presets: async () => [] },
      { zai },
    );

    // Act / Assert
    should((await service.catalogs()).zai?.label).equal('Mine');
    should((await unpublished.catalogs()).zai?.origin).equal('built-in');
  });
});
