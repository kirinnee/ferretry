import { describe, it } from 'bun:test';
import should from 'should';
import { z } from 'zod';
import { builtInModelCatalogs, modelCatalogFileValue } from '../../../daemon/lib/catalog/catalog.ts';
import { publishedModelCatalogFiles, readPublishedModelCatalog } from '../../../daemon/lib/catalog/published.ts';
import { BASE_HALF_KEYS, ModelCatalogFileSchema, NEW_HALF_KEYS } from '../../../daemon/lib/catalog/schema.ts';
import { type Suggestions, trimModelsDev } from '../../../daemon/lib/catalog/suggestions.ts';

const catalogs = builtInModelCatalogs();
const documentOf = (version = 3, suggestions?: Suggestions) =>
  JSON.parse(publishedModelCatalogFiles(version, catalogs, suggestions)['catalog/models.json'] as string) as {
    version: number;
    catalogs: Record<string, Record<string, unknown>>;
    prices: Record<string, unknown>;
    catalogsV2: Record<string, Record<string, unknown>>;
    suggestions?: unknown;
  };

/** A catalog with a Claude Code half AND a newer half: today's `zai` plus an OpenCode half. */
function mixedCatalogs() {
  const zai = catalogs.zai;
  if (zai?.claude === undefined) throw new Error('the zai catalog has a claude half');
  return {
    ...catalogs,
    mixed: { ...zai, id: 'mixed', opencode: { models: [{ ...zai.claude.models[0]!, price: undefined }] } },
  };
}

describe('the four new catalogs', () => {
  it.each([
    ['google-gemini', ['gemini', 'opencode']],
    ['github-copilot', ['copilot']],
    ['xai', ['opencode']],
    ['mistral', ['opencode']],
  ])('should ship %s with exactly the halves %j, each with one default', (id, halves) => {
    // Act
    const catalog = catalogs[id];

    // Assert
    should(catalog).be.ok();
    const present = [...BASE_HALF_KEYS, ...NEW_HALF_KEYS].filter(key => catalog?.[key] !== undefined);
    should(present).eql(halves);
    for (const key of present) {
      const models = catalog?.[key]?.models ?? [];
      should(models.filter(model => model.default)).have.length(1);
      should(new Set(models.map(model => model.id)).size).equal(models.length);
    }
    should(catalog?.verified).match(/^\d{4}-\d{2}-\d{2}$/u);
    should(catalog?.docs).startWith('https://');
    should(catalog?.unverified.length).be.above(0);
  });
});

describe('the catalog schema with the newer halves', () => {
  const half = { models: [{ id: 'm', label: 'M', tier: 'best', default: true }] };
  const file = (extra: Record<string, unknown>) => ({
    label: 'X',
    docs: 'https://docs.example.test',
    verified: '2026-11-23',
    ...extra,
  });
  const problems = (value: unknown) => {
    const result = ModelCatalogFileSchema.safeParse(value);
    return result.success ? [] : result.error.issues.map(issue => issue.message);
  };

  it('should take a catalog with only a newer half, and refuse one with no half at all', () => {
    for (const key of NEW_HALF_KEYS) should(problems(file({ [key]: half }))).eql([]);
    should(problems(file({}))[0]).match(/at least one of/u);
  });

  it('should refuse a Claude Code context suffix or a tier pin on a newer half', () => {
    // Act
    const suffix = problems(file({ copilot: { models: [{ ...half.models[0], suffix: '[1m]' }] } }));
    const tiers = problems(file({ gemini: { ...half, tiers: { opus: 'm' } } }));

    // Assert
    should(suffix.join(';')).match(/suffix.*Copilot takes m as it is/u);
    should(tiers.join(';')).match(/tiers.*Gemini has none/u);
  });
});

describe('the published document keeps old daemons reading what they always read', () => {
  /** What a daemon older than the newer halves reads, written out here and not derived from the writer. */
  const LEGACY_KEYS = new Set(['label', 'docs', 'verified', 'unverified', 'customIds', 'detect', 'claude', 'codex']);
  const OldDocument = z.object({
    version: z.number().int().nonnegative(),
    catalogs: z.record(z.string(), z.unknown()),
    prices: z.record(z.string(), z.unknown()).optional(),
  });

  it('should parse under the old document schema, and every `catalogs` entry under the old strict keys', () => {
    // Act
    const document = documentOf(3);
    const old = OldDocument.safeParse(document);

    // Assert
    should(old.success).be.true();
    should(Object.keys(document)).containEql('catalogsV2').and.containEql('prices');
    for (const [id, entry] of Object.entries(document.catalogs)) {
      should(Object.keys(entry).filter(key => !LEGACY_KEYS.has(key))).eql([]);
      should(ModelCatalogFileSchema.safeParse(entry).success).be.true();
      should(entry.claude !== undefined || entry.codex !== undefined).be.true();
      should(catalogs[id]).be.ok();
    }
  });

  it('should leave `catalogs` byte-identical to what it was before the newer halves, for every claude/codex catalog', () => {
    // Arrange — the old writer's rule, restated: the catalog's file value with each model's price taken out.
    const expected = Object.fromEntries(
      Object.entries(catalogs).flatMap(([id, catalog]) => {
        if (catalog.claude === undefined && catalog.codex === undefined) return [];
        const file = modelCatalogFileValue(catalog);
        const strip = (half: typeof file.claude) =>
          half === undefined ? {} : { models: half.models.map(({ price: _price, ...model }) => model) };
        return [
          [
            id,
            {
              ...file,
              ...(file.claude === undefined ? {} : { claude: { ...file.claude, ...strip(file.claude) } }),
              ...(file.codex === undefined ? {} : { codex: { ...file.codex, ...strip(file.codex) } }),
            },
          ],
        ];
      }),
    );

    // Act
    const { catalogs: published } = documentOf(3);

    // Assert
    should(JSON.stringify(published)).equal(JSON.stringify(expected));
    for (const id of ['google-gemini', 'github-copilot', 'xai', 'mistral']) should(published[id]).be.undefined();
  });

  it('should keep a catalog that has both kinds of half in `catalogs` WITHOUT its newer halves, and whole in `catalogsV2`', () => {
    // Act
    const files = publishedModelCatalogFiles(3, mixedCatalogs());
    const document = JSON.parse(files['catalog/models.json'] as string) as ReturnType<typeof documentOf>;

    // Assert
    should(Object.keys(document.catalogs.mixed ?? {})).not.containEql('opencode');
    should(Object.keys(document.catalogsV2.mixed ?? {}))
      .containEql('opencode')
      .and.containEql('claude');
    should(Object.keys(document.catalogsV2).sort()).eql(['github-copilot', 'google-gemini', 'mistral', 'mixed', 'xai']);
  });
});

describe('a daemon that knows the newer halves reads them from `catalogsV2`', () => {
  const read = (document: unknown) => {
    const result = readPublishedModelCatalog(document);
    if (result === undefined) throw new Error('the document reads');
    return result;
  };
  const json = (files: Readonly<Record<string, string>>) => JSON.parse(files['catalog/models.json'] as string);

  it('should read every new catalog, and the SAME claude and codex halves from V2 as from `catalogs` (prices too)', () => {
    // Arrange
    const document = json(publishedModelCatalogFiles(3, mixedCatalogs()));
    const legacyOnly = { ...document, catalogsV2: undefined };

    // Act
    const withV2 = read(document);
    const without = read(legacyOnly);

    // Assert
    should(withV2.rejected).eql([]);
    for (const id of ['google-gemini', 'github-copilot', 'xai', 'mistral']) should(withV2.catalogs[id]).be.ok();
    should(without.catalogs.xai).be.undefined();
    should(withV2.catalogs.mixed?.opencode).be.ok();
    should(without.catalogs.mixed?.opencode).be.undefined();
    for (const id of Object.keys(without.catalogs)) {
      should(withV2.catalogs[id]?.claude).eql(without.catalogs[id]?.claude);
      should(withV2.catalogs[id]?.codex).eql(without.catalogs[id]?.codex);
    }
    should(withV2.catalogs.mixed?.claude).eql(without.catalogs.mixed?.claude);
    should(withV2.catalogs.mixed?.claude?.models.some(model => model.price !== undefined)).be.true();
  });

  it('should fall back to the base entry when the V2 entry does not check, and name a V2-only catalog it cannot read', () => {
    // Arrange
    const document = json(publishedModelCatalogFiles(3, mixedCatalogs()));
    document.catalogsV2.mixed = { label: 'x' };
    document.catalogsV2.xai = { label: 'x' };

    // Act
    const result = read(document);

    // Assert
    should(result.catalogs.mixed?.claude).be.ok();
    should(result.catalogs.mixed?.opencode).be.undefined();
    should(result.catalogs.xai).be.undefined();
    should(result.rejected.map(entry => entry.id)).eql(['xai']);
  });

  it('should carry the suggestions through, leave out a row that does not check and name it', () => {
    // Arrange
    const suggestions: Suggestions = {
      generated: '2026-11-23',
      sources: { modelsDev: 'https://models.dev/api.json' },
      providers: trimModelsDev({ xai: { name: 'xAI', models: { 'grok-4.7': { name: 'Grok 4.7' } } } }).providers,
    };
    const document = json(publishedModelCatalogFiles(3, catalogs, suggestions));
    document.suggestions.providers.xai.models.broken = { name: 7 };

    // Act
    const result = read(document);

    // Assert
    should(Object.keys(result.suggestions?.providers.xai?.models ?? {})).eql(['grok-4.7']);
    should(result.droppedSuggestions.map(entry => entry.where)).eql(['xai/broken']);
    should(read(json(publishedModelCatalogFiles(3, catalogs))).suggestions).be.undefined();
  });
});
