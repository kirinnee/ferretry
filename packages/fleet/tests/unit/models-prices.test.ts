import { describe, it } from 'bun:test';
import should from 'should';
import { builtInModelCatalogs, modelCatalogs } from '../../src/lib/models/catalog.ts';
import {
  PUBLISHED_MODEL_CATALOG_FILE,
  publishedModelCatalogFiles,
  readPublishedModelCatalog,
} from '../../src/lib/models/published.ts';
import { CatalogPriceSchema, type ModelCatalog } from '../../src/lib/models/schema.ts';

const HALVES = ['claude', 'codex'] as const;

/** Every key a catalog model had before prices: what a daemon older than prices accepts, strictly. */
const KEYS_BEFORE_PRICES = new Set([
  'id',
  'label',
  'tier',
  'suffix',
  'context',
  'reasoning',
  'efforts',
  'defaultEffort',
  'default',
  'note',
]);

const price = {
  provider: 'openai',
  input: 2,
  output: 10,
  cacheRead: 0.1,
  cacheWrite: 2.5,
  source: 'https://developers.openai.com/api/docs/pricing',
  verified: '2026-10-20',
} as const;

const anthropicPrice = {
  provider: 'anthropic',
  input: 4,
  output: 20,
  cacheRead: 0.2,
  cacheWrite5m: 5,
  cacheWrite1h: 8,
  source: 'https://platform.claude.com/docs/en/about-claude/pricing',
  verified: '2026-10-20',
} as const;

const models = (catalog: ModelCatalog) =>
  HALVES.flatMap(half => (catalog[half]?.models ?? []).map(model => ({ half, model })));

const publishedDocument = (): Record<string, unknown> =>
  JSON.parse(publishedModelCatalogFiles(3, builtInModelCatalogs())[PUBLISHED_MODEL_CATALOG_FILE] as string);

describe('model catalog prices', () => {
  it('should price every shipped model, or say in its catalog why it has no price', () => {
    // Arrange
    const unexplained: string[] = [];

    // Act
    for (const catalog of Object.values(builtInModelCatalogs())) {
      for (const { half, model } of models(catalog)) {
        if (model.price !== undefined) continue;
        if (!catalog.unverified.some(line => line.includes(model.id)))
          unexplained.push(`${catalog.id} ${half} ${model.id}`);
      }
    }

    // Assert
    should(unexplained).deepEqual([]);
  });

  it('should price the owner fleet’s models from their makers’ pages', () => {
    // Arrange
    const catalogs = builtInModelCatalogs();
    const of = (catalog: string, half: 'claude' | 'codex', id: string) =>
      catalogs[catalog]?.[half]?.models.find(model => model.id === id)?.price;

    // Act + Assert
    should(of('anthropic', 'claude', 'claude-opus-5-5')).match({ provider: 'anthropic', input: 4, output: 20 });
    should(of('anthropic', 'claude', 'claude-sonnet-5-5')).match({ input: 2, output: 10, cacheRead: 0.1 });
    should(of('anthropic', 'claude', 'claude-haiku-5-5')).match({ input: 0.1, cacheWrite1h: 0.2 });
    should(of('openai', 'codex', 'gpt-6-astra')).match({ provider: 'openai', input: 10, output: 50, cacheRead: 1 });
    should(of('amazon-bedrock', 'claude', 'us.anthropic.claude-opus-5-5')).match({ input: 4.4, output: 22 });
    should(of('ollama', 'codex', 'gpt-oss:20b')).be.undefined();
  });

  it('should refuse a price whose cache writes do not follow its maker’s rules', () => {
    // Act
    const unsplit = CatalogPriceSchema.safeParse({ ...anthropicPrice, cacheWrite5m: undefined });
    const both = CatalogPriceSchema.safeParse({ ...anthropicPrice, cacheWrite: 5 });
    const splitOpenAi = CatalogPriceSchema.safeParse({ ...price, cacheWrite5m: 2.5 });

    // Assert
    should(CatalogPriceSchema.parse(anthropicPrice)).match({ cacheWrite5m: 5, cacheWrite1h: 8 });
    should(CatalogPriceSchema.parse(price)).match({ cacheWrite: 2.5 });
    should(unsplit.success).be.false();
    should(both.success).be.false();
    should(splitOpenAi.success).be.false();
  });

  it('should refuse a price past the micro-dollar, a plaintext source, or an undated one', () => {
    // Act + Assert
    should(CatalogPriceSchema.safeParse({ ...price, input: 0.0000001 }).success).be.false();
    should(CatalogPriceSchema.safeParse({ ...price, input: -1 }).success).be.false();
    should(CatalogPriceSchema.safeParse({ ...price, source: 'http://example.com/prices' }).success).be.false();
    should(CatalogPriceSchema.safeParse({ ...price, source: 'https://example.com/prices#opus' }).success).be.false();
    should(CatalogPriceSchema.safeParse({ ...price, verified: '20 October' }).success).be.false();
    should(CatalogPriceSchema.parse({ ...price, input: 0.1375 }).input).equal(0.1375);
  });

  describe('published', () => {
    it('should keep catalogs in the shape a daemon older than prices reads, prices beside them', () => {
      // Act
      const document = publishedDocument();
      const catalogs = document.catalogs as Record<string, Record<string, { models: Record<string, unknown>[] }>>;
      const keys = Object.values(catalogs).flatMap(catalog =>
        HALVES.flatMap(half => (catalog[half]?.models ?? []).flatMap(model => Object.keys(model))),
      );

      // Assert
      should(keys.filter(key => !KEYS_BEFORE_PRICES.has(key))).deepEqual([]);
      should(document.prices).have.property('anthropic');
      should((document.prices as Record<string, unknown>).ollama).be.undefined();
    });

    it('should read every price back onto the model it was published for', () => {
      // Arrange
      const built = builtInModelCatalogs();

      // Act
      const read = readPublishedModelCatalog(publishedDocument());

      // Assert
      should(read?.rejectedPrices).deepEqual([]);
      for (const [id, catalog] of Object.entries(built)) {
        should(models(read?.catalogs[id] as ModelCatalog).map(({ model }) => model.price)).deepEqual(
          models(catalog).map(({ model }) => model.price),
        );
      }
    });

    it('should read a document published before prices as unpriced, not as broken', () => {
      // Arrange
      const { prices: _prices, ...older } = publishedDocument();

      // Act
      const read = readPublishedModelCatalog(older);

      // Assert
      should(read?.rejected).deepEqual([]);
      should(read?.catalogs.anthropic?.claude?.models.every(model => model.price === undefined)).be.true();
    });

    it('should give a published catalog without prices the built-in prices, but never fill a machine file', () => {
      // Arrange: a daemon holding a catalog published before prices existed, or a rollback to one.
      const built = builtInModelCatalogs();
      const { prices: _prices, ...older } = publishedDocument();
      const published = readPublishedModelCatalog(older)?.catalogs ?? {};
      const openai = published.openai as ModelCatalog;
      const half = openai.codex as NonNullable<ModelCatalog['codex']>;
      const repriced = {
        ...openai,
        codex: {
          ...half,
          models: half.models.map(model => (model.id === 'gpt-6-astra' ? { ...model, price: { ...price, input: 9 } } : model)),
        },
      };
      const file = { ...(built.deepseek as ModelCatalog), origin: 'file' as const };
      const unpricedFile = {
        ...file,
        codex: { ...(file.codex as NonNullable<ModelCatalog['codex']>), models: file.codex?.models.map(({ price: _p, ...model }) => model) ?? [] },
      };

      // Act
      const effective = modelCatalogs({
        builtIn: built,
        published: { ...published, openai: repriced, custom: { ...repriced, id: 'custom' } },
        files: { deepseek: unpricedFile },
      });
      const of = (catalog: string, id: string) => effective[catalog]?.codex?.models.find(model => model.id === id);

      // Assert
      should(effective.anthropic?.origin).equal('published');
      should(effective.anthropic?.claude?.models.map(model => model.price)).deepEqual(
        built.anthropic?.claude?.models.map(model => model.price),
      );
      should(of('openai', 'gpt-6-astra')?.price?.input).equal(9);
      should(of('openai', 'gpt-6-luna')?.price).deepEqual(
        built.openai?.codex?.models.find(model => model.id === 'gpt-6-luna')?.price,
      );
      should(of('custom', 'gpt-6-luna')?.price).be.undefined();
      should(of('deepseek', 'deepseek-flash')?.price).be.undefined();
    });

    it('should leave out a price that does not check and keep its model, naming each refusal', () => {
      // Arrange
      const document = publishedDocument();
      const prices = {
        anthropic: { claude: { 'claude-opus-5-5': { ...anthropicPrice, input: -4 }, 'claude-opus-9': anthropicPrice } },
        openai: { claude: { 'gpt-6-astra': price }, codex: 'everything' },
        zai: 'free',
      };

      // Act
      const read = readPublishedModelCatalog({ ...document, prices });

      // Assert
      const opus = read?.catalogs.anthropic?.claude?.models.find(model => model.id === 'claude-opus-5-5');
      should(opus).match({ label: 'Opus 5.5' });
      should(opus?.price).be.undefined();
      should(read?.rejectedPrices.map(entry => [entry.id, entry.model])).deepEqual([
        ['anthropic', 'claude-opus-9'],
        ['anthropic', 'claude-opus-5-5'],
        ['openai', 'claude.*'],
        ['openai', 'codex.*'],
        ['zai', '*'],
      ]);
      should(read?.rejected).deepEqual([]);
    });
  });
});
