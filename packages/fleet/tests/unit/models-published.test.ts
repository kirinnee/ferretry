import { describe, it } from 'bun:test';
import should from 'should';
import { builtInModelCatalogs } from '../../src/lib/models/catalog.ts';
import {
  PUBLISHED_MODEL_CATALOG_FILE,
  PUBLISHED_MODEL_CATALOG_VERSION_FILE,
  publishedModelCatalogFiles,
  readPublishedModelCatalog,
} from '../../src/lib/models/published.ts';

describe('the published model catalog', () => {
  it('should write every catalog at one version, and read back exactly what was written', () => {
    // Arrange
    const built = builtInModelCatalogs();

    // Act
    const files = publishedModelCatalogFiles(12, built);
    const read = readPublishedModelCatalog(JSON.parse(files[PUBLISHED_MODEL_CATALOG_FILE] as string));

    // Assert
    should(JSON.parse(files[PUBLISHED_MODEL_CATALOG_VERSION_FILE] as string)).deepEqual({ version: 12 });
    should(read?.version).equal(12);
    should(Object.keys(read?.catalogs ?? {})).deepEqual(Object.keys(built));
    should(read?.catalogs.zai).match({ id: 'zai', origin: 'published', label: built.zai?.label });
    should(read?.rejected).deepEqual([]);
  });

  it('should leave out a catalog that does not check, and refuse a document that is not one', () => {
    // Act
    const read = readPublishedModelCatalog({ version: 1, catalogs: { broken: { label: 'Broken' } } });

    // Assert
    should(read?.catalogs).deepEqual({});
    should(read?.rejected.map(entry => entry.id)).deepEqual(['broken']);
    should(readPublishedModelCatalog({ version: 'one' })).be.undefined();
    should(readPublishedModelCatalog({ version: 1, catalogs: { 'Bad Id': {} } })).be.undefined();
  });
});
