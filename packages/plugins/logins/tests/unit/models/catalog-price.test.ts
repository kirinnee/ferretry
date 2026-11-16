import { describe, it } from 'bun:test';
import should from 'should';
import { builtInModelCatalogs } from '../../../daemon/lib/catalog/catalog.ts';
import {
  PUBLISHED_MODEL_CATALOG_FILE,
  publishedModelCatalogFiles,
  readPublishedModelCatalog,
} from '../../../daemon/lib/catalog/published.ts';
import { AnalyticsPricingSourceUrlSchema } from '../../../daemon/lib/catalog/price-source.ts';
import { CatalogPriceSchema } from '../../../daemon/lib/catalog/schema.ts';

const SOURCE = 'https://pricing.example.test/models';

const flat = (overrides: Record<string, unknown> = {}) => ({
  provider: 'zai',
  input: 1,
  output: 2,
  cacheRead: 0.1,
  cacheWrite: 0.5,
  source: SOURCE,
  verified: '2026-10-18',
  ...overrides,
});

const split = (overrides: Record<string, unknown> = {}) => ({
  provider: 'anthropic',
  input: 3,
  output: 15,
  cacheRead: 0.3,
  cacheWrite5m: 3.75,
  cacheWrite1h: 6,
  source: SOURCE,
  verified: '2026-10-18',
  ...overrides,
});

const messages = (value: unknown): string[] => {
  const result = CatalogPriceSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map(issue => issue.message);
};

describe('a catalog price follows its maker’s billing rules', () => {
  it('should take a flat price for most makers and a split cache write for Anthropic', () => {
    should(CatalogPriceSchema.safeParse(flat()).success).be.true();
    should(CatalogPriceSchema.safeParse(split()).success).be.true();
  });

  it('should make an Anthropic price state both cache-write lifetimes', () => {
    const both =
      'an anthropic price states both cacheWrite5m and cacheWrite1h: Anthropic bills a cache write by its lifetime';
    should(messages(split({ cacheWrite5m: undefined, cacheWrite1h: undefined }))).containEql(both);
    should(messages(split({ cacheWrite1h: undefined }))).containEql(both);
  });

  it('should refuse a split cache write from any maker but Anthropic, naming the maker', () => {
    should(messages(flat({ cacheWrite5m: 1 }))).containEql(
      'a zai price states one cacheWrite; only Anthropic splits cache writes by lifetime',
    );
    should(messages(flat({ cacheWrite1h: 1 }))).containEql(
      'a zai price states one cacheWrite; only Anthropic splits cache writes by lifetime',
    );
  });

  it('should refuse a single cacheWrite on an Anthropic price', () => {
    should(messages(split({ cacheWrite: 1 }))).containEql(
      'an anthropic price states cacheWrite5m and cacheWrite1h, not one cacheWrite',
    );
  });
});

describe('a pricing source address', () => {
  const issues = (value: string): string[] => {
    const result = AnalyticsPricingSourceUrlSchema.safeParse(value);
    return result.success ? [] : result.error.issues.map(issue => issue.message);
  };

  it('should accept a plain https address', () => {
    should(issues(SOURCE)).eql([]);
  });

  it('should refuse a source that is not fetched over https', () => {
    should(issues('http://pricing.example.test/models')).containEql('pricing sources must be fetched over https');
  });

  it('should refuse a source that carries a user or a password', () => {
    should(issues('https://user:pass@pricing.example.test/models')).containEql(
      'pricing source URLs may not carry credentials',
    );
    should(issues('https://user@pricing.example.test/models')).containEql(
      'pricing source URLs may not carry credentials',
    );
  });

  it('should refuse a source that carries a fragment', () => {
    should(issues(`${SOURCE}#section`)).containEql('pricing source URLs may not carry a fragment');
  });
});

describe('published prices are put back on the models they name', () => {
  const built = builtInModelCatalogs();
  const claudeOnly = Object.values(built).find(catalog => catalog.claude !== undefined && catalog.codex === undefined);
  const document = (prices: unknown) => ({
    ...JSON.parse(publishedModelCatalogFiles(7, built)[PUBLISHED_MODEL_CATALOG_FILE] as string),
    prices,
  });
  const firstModel = claudeOnly?.claude?.models[0]?.id as string;

  it('should have a catalog that drives only Claude Code to price', () => {
    should(claudeOnly).not.be.undefined();
    should(firstModel).be.a.String();
  });

  it('should name prices that are not a map of halves, and leave the catalog unpriced', () => {
    const read = readPublishedModelCatalog(document({ [claudeOnly?.id as string]: 'cheap' }));
    should(read?.rejectedPrices).eql([
      { id: claudeOnly?.id, model: '*', problem: 'the prices are not a map of halves' },
    ]);
    should(read?.catalogs[claudeOnly?.id as string]).not.be.undefined();
  });

  it('should name a half the catalog does not have, and a half whose prices are not a map', () => {
    const read = readPublishedModelCatalog(
      document({ [claudeOnly?.id as string]: { codex: { 'gpt-x': flat() }, claude: 'cheap' } }),
    );
    should(read?.rejectedPrices).eql([
      { id: claudeOnly?.id, model: 'claude.*', problem: 'there is no claude half to price' },
      { id: claudeOnly?.id, model: 'codex.*', problem: 'there is no codex half to price' },
    ]);
  });

  it('should name a price for a model the catalog does not list, and one that does not check', () => {
    const read = readPublishedModelCatalog(
      document({
        [claudeOnly?.id as string]: { claude: { 'no-such-model': flat(), [firstModel]: flat({ input: -1 }) } },
      }),
    );
    should(read?.rejectedPrices.map(rejected => rejected.model)).eql(['no-such-model', firstModel]);
    should(read?.rejectedPrices[0]?.problem).equal(`claude lists no model no-such-model`);
    const kept = read?.catalogs[claudeOnly?.id as string]?.claude?.models.find(model => model.id === firstModel);
    should(kept?.price).be.undefined();
  });

  it('should put a price that checks back on its model', () => {
    const read = readPublishedModelCatalog(
      document({ [claudeOnly?.id as string]: { claude: { [firstModel]: flat() } } }),
    );
    should(read?.rejectedPrices).eql([]);
    const priced = read?.catalogs[claudeOnly?.id as string]?.claude?.models.find(model => model.id === firstModel);
    should(priced?.price).match({ provider: 'zai', input: 1, output: 2 });
  });
});
