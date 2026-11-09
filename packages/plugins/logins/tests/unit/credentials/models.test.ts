import { describe, it } from 'bun:test';
import should from 'should';
import { findRawSecrets } from '../../../contract/secret-shape.ts';
import { readConfigText } from '../../../daemon/lib/shared/yaml-text.ts';
import {
  BUILT_IN_MODEL_CATALOG_TEXTS,
  BuiltInModelCatalogError,
  builtInModelCatalogs,
  loginModelCatalog,
  loginModelCatalogId,
  modelCatalogFileValue,
  modelCatalogs,
  parseModelCatalog,
  parseModelCatalogText,
  SIGN_IN_MODEL_CATALOGS,
} from '../../../daemon/lib/catalog/catalog.ts';
import {
  type CatalogHalf,
  catalogModelFor,
  catalogModelValue,
  catalogTierEnvironment,
  type ModelCatalog,
  ModelCatalogFileSchema,
  slotModelId,
} from '../../../daemon/lib/catalog/schema.ts';
import { builtInPresets } from '../../../daemon/lib/presets/catalog.ts';
import { presetHarnesses } from '../../../daemon/lib/presets/schema.ts';

const CATALOGS = builtInModelCatalogs();
const PRESETS = builtInPresets();

const model = (id: string, extra: Record<string, unknown> = {}) => ({ id, label: id, tier: 'best', ...extra });
const catalogOf = (file: Record<string, unknown>, id = 'acme'): ModelCatalog => {
  const parsed = parseModelCatalog(
    id,
    { label: 'Acme', docs: 'https://acme.example/docs', verified: '2026-10-18', ...file },
    'file',
  );
  if (!parsed.ok) throw new Error(parsed.problem);
  return parsed.value;
};
const problemOf = (file: Record<string, unknown>): string => {
  const parsed = parseModelCatalog(
    'acme',
    { label: 'Acme', docs: 'https://acme.example/docs', verified: '2026-10-18', ...file },
    'file',
  );
  if (parsed.ok) throw new Error('expected the catalog to be refused');
  return parsed.problem;
};

describe('the built-in model catalogs', () => {
  it.each(Object.keys(BUILT_IN_MODEL_CATALOG_TEXTS))('should ship %s as a file that checks and holds no secret', id => {
    // Arrange
    const read = readConfigText(BUILT_IN_MODEL_CATALOG_TEXTS[id] as string);

    // Assert
    should(read.ok).be.true();
    if (!read.ok) return;
    should(findRawSecrets(read.read.value)).be.empty();
    should(CATALOGS[id]?.origin).equal('built-in');
  });

  // THE VALIDATE TEST: every preset a person can add a login from offers a real model list.
  it.each(PRESETS.map(preset => preset.id))(
    'should give preset %s a catalog with models, exactly one default, and tier pins that name its models',
    id => {
      // Arrange
      const preset = PRESETS.find(entry => entry.id === id);
      const catalog = CATALOGS[preset?.catalog ?? ''];

      // Assert — a catalog, and a half of it for every CLI the preset drives
      should(catalog).not.be.undefined();
      for (const harness of presetHarnesses(preset as NonNullable<typeof preset>)) {
        const half = catalog?.[harness] as CatalogHalf;
        should(half).not.be.undefined();
        should(half.models.length).be.above(0);
        should(half.models.filter(entry => entry.default)).have.length(1);
        const ids = new Set(half.models.map(entry => entry.id));
        for (const value of Object.values(half.tiers ?? {})) should(ids.has(slotModelId(value as string))).be.true();
      }
    },
  );

  it('should give both sign-in logins a catalog of their own', () => {
    should(Object.values(SIGN_IN_MODEL_CATALOGS).every(id => CATALOGS[id] !== undefined)).be.true();
    should(CATALOGS.anthropic?.claude?.models.map(entry => entry.tier)).eql(['best', 'balanced', 'fast']);
  });

  it('should refuse to build when a shipped catalog is broken', () => {
    should(new BuiltInModelCatalogError('acme', 'models: required').message).equal(
      'built-in model catalog acme does not check: models: required',
    );
  });
});

describe('a catalog file', () => {
  it('should refuse a catalog with no half, no default, two defaults, or a model listed twice', () => {
    should(problemOf({})).match(/claude:", "codex:" or both/);
    should(problemOf({ claude: { models: [model('a')] } })).match(/exactly one model/);
    should(problemOf({ claude: { models: [model('a', { default: true }), model('b', { default: true })] } })).match(
      /a, b all say/,
    );
    should(problemOf({ claude: { models: [model('a', { default: true }), model('a')] } })).match(/listed twice/);
  });

  it('should refuse a tier pin that names no model, and Codex tiers or suffixes', () => {
    should(problemOf({ claude: { tiers: { opus: 'other[1m]' }, models: [model('a', { default: true })] } })).match(
      /tier slot "opus" names other\[1m\]/,
    );
    should(problemOf({ codex: { tiers: { opus: 'a' }, models: [model('a', { default: true })] } })).match(
      /Codex has none/,
    );
    should(problemOf({ codex: { models: [model('a', { default: true, suffix: '[1m]' })] } })).match(
      /Codex takes a as it is/,
    );
  });

  it('should refuse a default effort it does not list, and efforts on a model said not to reason', () => {
    should(
      problemOf({ claude: { models: [model('a', { default: true, efforts: ['low'], defaultEffort: 'high' })] } }),
    ).match(/defaultEffort "high"/);
    should(
      problemOf({ claude: { models: [model('a', { default: true, efforts: ['low'], reasoning: false })] } }),
    ).match(/drop "reasoning: false"/);
  });

  it('should refuse an id a pane could not take as one word', () => {
    should(
      ModelCatalogFileSchema.safeParse({ claude: { models: [model('a b', { default: true })] } }).success,
    ).be.false();
  });

  it('should report a file that does not parse, and keep the parts a file is written as', () => {
    // Arrange / Act
    const broken = parseModelCatalogText('acme', 'label: [', 'file');
    const checked = catalogOf({ claude: { models: [model('a', { default: true })] } });

    // Assert
    should(broken.ok).be.false();
    should(modelCatalogFileValue(checked)).not.have.properties(['id', 'origin']);
    should(modelCatalogFileValue(checked).label).equal('Acme');
  });
});

describe('the catalog helpers', () => {
  const half = catalogOf({
    claude: {
      tiers: { opus: 'big[1m]', haiku: 'small', subagent: 'small' },
      models: [model('big', { default: true, suffix: '[1m]' }), model('small', { tier: 'fast' })],
    },
  }).claude as CatalogHalf;

  it('should pin each tier slot through its variable', () => {
    should(catalogTierEnvironment(half)).eql({
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'big[1m]',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'small',
      CLAUDE_CODE_SUBAGENT_MODEL: 'small',
    });
    should(catalogTierEnvironment({ models: half.models })).eql({});
  });

  it('should find a model by id, by its suffixed value, or by the tier alias pinned to it', () => {
    should(catalogModelFor(half, 'small')?.id).equal('small');
    should(catalogModelFor(half, 'big[1m]')?.id).equal('big');
    should(catalogModelFor(half, 'opus')?.id).equal('big');
    should(catalogModelFor(half, 'sonnet')).be.undefined();
    should(catalogModelFor(half, 'nobody')).be.undefined();
    should(catalogModelValue(half.models[0] as CatalogHalf['models'][number])).equal('big[1m]');
  });

  it('should lay a machine file over the published catalog over the built-in one, by id', () => {
    // Arrange
    const built = {
      ...catalogOf({ claude: { models: [model('a', { default: true })] } }),
      origin: 'built-in' as const,
    };
    const published = { ...built, origin: 'published' as const };
    const file = { ...built, origin: 'file' as const };

    // Act / Assert
    should(modelCatalogs({ builtIn: { acme: built } }).acme?.origin).equal('built-in');
    should(modelCatalogs({ builtIn: { acme: built }, published: { acme: published } }).acme?.origin).equal('published');
    should(
      modelCatalogs({ builtIn: { acme: built }, published: { acme: published }, files: { acme: file } }).acme?.origin,
    ).equal('file');
  });

  it('should give a sign-in login its maker, an environment login its preset, and a hand-made one nothing', () => {
    should(loginModelCatalogId({ store: 'host' }, 'claude', PRESETS)).equal('anthropic');
    should(loginModelCatalogId({ store: 'ferretry' }, 'codex', PRESETS)).equal('openai');
    should(loginModelCatalogId({ store: 'environment', preset: 'zai-glm' }, 'claude', PRESETS)).equal('zai');
    should(loginModelCatalogId({ store: 'environment', preset: 'gone' }, 'claude', PRESETS)).be.undefined();
    should(loginModelCatalogId({ store: 'environment' }, 'claude', PRESETS)).be.undefined();
  });

  it('should name the variables a preset leaves to the person, and no catalog the machine lacks', () => {
    // Arrange / Act
    const foundry = loginModelCatalog({ store: 'environment', preset: 'microsoft-foundry-api-key' }, 'claude', {
      catalogs: CATALOGS,
      presets: PRESETS,
    });
    const missing = loginModelCatalog({ store: 'environment', preset: 'zai-glm' }, 'claude', {
      catalogs: {},
      presets: PRESETS,
    });
    const signIn = loginModelCatalog({ store: 'host' }, 'claude', { catalogs: CATALOGS, presets: PRESETS });

    // Assert
    should(foundry.catalog?.id).equal('microsoft-foundry');
    should(foundry.personOwned.has('ANTHROPIC_DEFAULT_OPUS_MODEL')).be.true();
    should(missing.catalog).be.undefined();
    should(signIn.personOwned.size).equal(0);
  });
});

describe('a model retirement day', () => {
  it('should read a day the provider announced, and refuse one that is not a day', () => {
    // Act
    const read = catalogOf({ claude: { models: [model('old', { default: true, retires: '2027-01-31' })] } });

    // Assert
    should(read.claude?.models[0]?.retires).equal('2027-01-31');
    should(problemOf({ claude: { models: [model('old', { default: true, retires: 'next spring' })] } })).containEql(
      'write the date as YYYY-MM-DD',
    );
  });
});
