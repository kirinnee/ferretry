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

  it('should carry what the last read of Ollama found, and nothing when none was read', async () => {
    // Arrange
    const local = {
      provider: 'ollama' as const,
      baseUrl: 'http://127.0.0.1:11434',
      state: 'none-pulled' as const,
      models: [],
      checkedAt: '2026-10-19T00:00:00.000Z',
      message: 'Ollama is running, but no model is installed yet. Run: ollama pull gpt-oss:20b',
      pullCommand: 'ollama pull gpt-oss:20b',
    };
    const read = new ModelCatalogService({ files: async () => ({}), presets: async () => [], ollama: () => local });
    const unread = new ModelCatalogService({
      files: async () => ({}),
      presets: async () => [],
      ollama: () => undefined,
    });

    // Act / Assert
    should((await read.sources()).local).eql({ ollama: local });
    should((await unread.sources()).local).be.undefined();
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
