import { describe, it } from 'bun:test';
import should from 'should';
import { builtInModelCatalogs } from '../../src/lib/models/catalog.ts';
import { runtimeModels } from '../../src/lib/models/runtime.ts';
import type { ModelCatalog } from '../../src/lib/models/schema.ts';
import {
  CODEX_CATALOG_FORMAT,
  CODEX_MODEL_CATALOG_FILE,
  CODEX_NATIVE_MODEL_CATALOGS,
  codexCatalogArguments,
  codexCatalogModels,
  contextWords,
  renderCodexModelCatalog,
} from '../../src/lib/models/codex-catalog.ts';
import type { RuntimeModelEntry, RuntimeModels } from '../../src/lib/models/runtime.ts';

/**
 * The keys a model entry must carry for the Codex builds this was measured against to load the file:
 * the first parse error each one printed (`missing field …`), collected by adding the field and trying
 * again, on codex-cli 0.145.0 and 0.156.1. Codex refuses to START on a catalog it cannot parse and
 * ignores keys it does not know, so a catalog carries the union.
 */
const REQUIRED_BY_0_156 = [
  'slug',
  'display_name',
  'supported_reasoning_levels',
  'shell_type',
  'visibility',
  'supported_in_api',
  'priority',
  'support_verbosity',
  'truncation_policy',
  'experimental_supported_tools',
  'base_instructions',
] as const;
const REQUIRED_BY_0_145 = [...REQUIRED_BY_0_156, 'supports_parallel_tool_calls'] as const;

const model = (overrides: Partial<RuntimeModelEntry> = {}): RuntimeModelEntry => ({
  id: 'glm-5.3',
  label: 'GLM-5.3',
  tier: 'best',
  context: 1_000_000,
  efforts: ['low', 'high', 'max'],
  defaultEffort: 'high',
  available: true,
  ...overrides,
});

const derived = (models: readonly RuntimeModelEntry[], catalog = 'zai'): RuntimeModels => ({
  catalog: { id: catalog, label: 'GLM / Z.ai', origin: 'built-in', customIds: false, docs: 'https://example.test/' },
  models,
  default: models[0]?.id,
  env: {},
});

const entriesOf = (models: readonly RuntimeModelEntry[]): Record<string, unknown>[] =>
  (JSON.parse(renderCodexModelCatalog(models)) as { models: Record<string, unknown>[] }).models;

describe('codexCatalogModels', () => {
  it("should offer a third-party catalog's usable models, in the catalog's order", () => {
    // Act
    const offered = codexCatalogModels(
      derived([model(), model({ id: 'gone', available: false }), model({ id: 'glm-5.3-flash' })]),
    );

    // Assert
    should(offered?.map(entry => entry.id)).eql(['glm-5.3', 'glm-5.3-flash']);
  });

  it('should keep Codex’s own list for a catalog of models Codex ships', () => {
    // Assert
    should([...CODEX_NATIVE_MODEL_CATALOGS].toSorted()).eql(['azure-openai', 'openai']);
    for (const id of CODEX_NATIVE_MODEL_CATALOGS) should(codexCatalogModels(derived([model()], id))).be.undefined();
  });

  it('should offer nothing for a login with no catalog, or one whose models are all unusable', () => {
    // Assert
    should(codexCatalogModels({ models: [model()], default: undefined, env: {} })).be.undefined();
    should(codexCatalogModels(derived([model({ available: false })]))).be.undefined();
    should(codexCatalogModels(derived([]))).be.undefined();
  });
});

describe('renderCodexModelCatalog', () => {
  it('should end with a newline and list the models by position', () => {
    // Act
    const text = renderCodexModelCatalog([model(), model({ id: 'glm-5.3-flash', label: 'GLM-5.3-Flash' })]);

    // Assert
    should(text.endsWith('}\n')).be.true();
    should(entriesOf([model(), model({ id: 'second' })]).map(entry => [entry.slug, entry.priority])).eql([
      ['glm-5.3', 1],
      ['second', 2],
    ]);
  });

  it('should list the model the runtime launches with first, because Codex calls the first its default', () => {
    // Act
    const entries = entriesOf([model({ id: 'pro' }), model({ id: 'flash' }), model({ id: 'mini' })]);
    const reordered = JSON.parse(
      renderCodexModelCatalog([model({ id: 'pro' }), model({ id: 'flash' }), model({ id: 'mini' })], 'flash'),
    ) as {
      models: { slug: string; priority: number }[];
    };
    const unknown = JSON.parse(renderCodexModelCatalog([model({ id: 'pro' }), model({ id: 'flash' })], 'gone')) as {
      models: { slug: string }[];
    };

    // Assert
    should(entries.map(entry => entry.slug)).eql(['pro', 'flash', 'mini']);
    should(reordered.models.map(entry => [entry.slug, entry.priority])).eql([
      ['flash', 1],
      ['pro', 2],
      ['mini', 3],
    ]);
    should(unknown.models.map(entry => entry.slug)).eql(['pro', 'flash']);
  });

  it('should carry every key the measured Codex builds require, and a prompt that is not a stub', () => {
    // Act
    const [entry] = entriesOf([model()]);

    // Assert
    for (const key of REQUIRED_BY_0_145) should(entry).have.property(key);
    should(entry).match({ visibility: 'list', supported_in_api: true, supports_parallel_tool_calls: false });
    // Codex's own prompt for a model it has no entry for: a short stub here is a much worse agent.
    const prompt = String(entry?.base_instructions);
    should(prompt.length).be.above(10_000);
    should(prompt).startWith('You are a coding agent running in the Codex CLI');
  });

  it('should say what Codex shows: the label, the tier, the window, and each level in Codex’s words', () => {
    // Act
    const [entry] = entriesOf([model({ note: 'Slow on long files.' })]);

    // Assert
    should(entry).match({
      display_name: 'GLM-5.3',
      description: 'Best · 1M context · Slow on long files.',
      default_reasoning_level: 'high',
      context_window: 1_000_000,
      max_context_window: 1_000_000,
      supported_reasoning_levels: [
        { effort: 'low', description: 'Fast responses with lighter reasoning' },
        { effort: 'high', description: 'Greater reasoning depth for complex problems' },
        { effort: 'max', description: 'Maximum reasoning depth for the hardest problems' },
      ],
    });
  });

  it('should leave out what the catalog does not say, and start a level-less model on no level at all', () => {
    // Act
    const [entry] = entriesOf([model({ tier: undefined, context: undefined, efforts: [], defaultEffort: undefined })]);

    // Assert
    should(entry).not.have.property('description');
    should(entry).not.have.property('default_reasoning_level');
    should(entry).not.have.property('context_window');
    should(entry).match({ supported_reasoning_levels: [] });
  });

  it('should start on medium when the model takes it and the catalog names no level, else on the first', () => {
    // Act
    const [withMedium, without] = entriesOf([
      model({ efforts: ['low', 'medium', 'high'], defaultEffort: undefined }),
      model({ efforts: ['high', 'max'], defaultEffort: undefined }),
    ]);

    // Assert
    should(withMedium?.default_reasoning_level).equal('medium');
    should(without?.default_reasoning_level).equal('high');
  });

  it('should name a level Codex has no words for by itself', () => {
    // Act
    const [entry] = entriesOf([
      model({ efforts: ['none', 'minimal', 'xhigh', 'ultra', 'turbo'], defaultEffort: 'none' }),
    ]);

    // Assert
    const levels = (entry?.supported_reasoning_levels ?? []) as { effort: string; description: string }[];
    should(levels.at(-1)).eql({
      effort: 'turbo',
      description: 'turbo',
    });
    should(levels.map(level => level.description).slice(0, 4)).eql([
      'No reasoning',
      'Minimal reasoning',
      'Extra high reasoning depth for complex problems',
      'Maximum reasoning with automatic task delegation',
    ]);
  });
});

describe('the catalog file format', () => {
  it('should change its number whenever the text written for the same models changes', () => {
    // Arrange
    const text = renderCodexModelCatalog([model()]);

    // Act
    const digest = new Bun.CryptoHasher('sha256').update(text).digest('hex');

    // Assert — the manifest publishes CODEX_CATALOG_FORMAT, which is how an installed machine learns its
    // files are out of date. If this fails you changed what is written: bump CODEX_CATALOG_FORMAT, then
    // paste the new digest (and the new format) here.
    should(CODEX_CATALOG_FORMAT).equal(1);
    should(digest).equal('3e0afeaa439f15cd308ddbbcc55c5dd7df9b7e3585ddfde2d763d200b39ac60f');
  });
});

describe('contextWords', () => {
  it('should write a window the way a person says it', () => {
    // Assert
    should(contextWords(1_000_000)).equal('1M');
    should(contextWords(1_050_000)).equal('1.05M');
    should(contextWords(128_000)).equal('128K');
    should(contextWords(200)).equal('1K');
  });
});

describe('codexCatalogArguments', () => {
  it('should point Codex at the file with a TOML string', () => {
    // Assert
    should(codexCatalogArguments(`/fy/home/.fy/${CODEX_MODEL_CATALOG_FILE}`)).eql([
      '-c',
      'model_catalog_json="/fy/home/.fy/codex-model-catalog.json"',
    ]);
    should(codexCatalogArguments('/a "b"/c')[1]).equal('model_catalog_json="/a \\"b\\"/c"');
  });
});

describe('Codex’s picker for the models Ollama has installed', () => {
  it('should list the installed models, the launch default first, and not the suggestions that are absent', () => {
    // Arrange
    const local = {
      provider: 'ollama' as const,
      baseUrl: 'http://127.0.0.1:11434',
      state: 'found' as const,
      models: [
        { id: 'llama3.2:latest', label: 'llama3.2:latest' },
        { id: 'gpt-oss:120b', label: 'gpt-oss:120b' },
      ],
      checkedAt: '2026-10-19T00:00:00.000Z',
      message: 'Ollama has 2 models installed on this machine.',
      pullCommand: 'ollama pull gpt-oss:20b',
    };
    const ollama = builtInModelCatalogs().ollama as ModelCatalog;

    // Act
    const runtime = runtimeModels({ harness: 'codex', modelSet: undefined, catalog: ollama, local });
    const slugs = (
      JSON.parse(renderCodexModelCatalog(codexCatalogModels(runtime) ?? [], runtime.default)) as {
        models: { slug: string; context_window?: number }[];
      }
    ).models;

    // Assert
    should(slugs.map(entry => entry.slug)).eql(['gpt-oss:120b', 'llama3.2:latest']);
    should(slugs[0]?.context_window).equal(128_000);
    should(slugs[1]?.context_window).be.undefined();
  });
});
