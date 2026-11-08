import { describe, expect, it } from 'bun:test';
import {
  CODEX_CATALOG_FORMAT,
  CODEX_MODEL_CATALOG_FILE,
  codexCatalogArguments,
  codexCatalogModels,
  renderCodexModelCatalog,
} from '../../../daemon/lib/models/codex-catalog.ts';
import type { RuntimeModelEntry, RuntimeModels } from '../../../daemon/lib/models/runtime.ts';

const entry = (id: string, extra: Partial<RuntimeModelEntry> = {}): RuntimeModelEntry => ({
  id,
  label: id.toUpperCase(),
  efforts: [],
  available: true,
  ...extra,
});

interface Rendered {
  readonly models: readonly Record<string, unknown>[];
}
const render = (models: readonly RuntimeModelEntry[], launchesWith?: string): Rendered =>
  JSON.parse(renderCodexModelCatalog(models, launchesWith)) as Rendered;
const only = (model: RuntimeModelEntry): Record<string, unknown> =>
  render([model]).models[0] as Record<string, unknown>;

describe('the model catalog file a Codex runtime on a third-party provider reads', () => {
  it('names its file and format, and points Codex at a path as a TOML string', () => {
    expect(CODEX_CATALOG_FORMAT).toBe(1);
    expect(CODEX_MODEL_CATALOG_FILE).toBe('codex-model-catalog.json');
    expect(codexCatalogArguments('/fy/homes/a b/codex-model-catalog.json')).toEqual([
      '-c',
      'model_catalog_json="/fy/homes/a b/codex-model-catalog.json"',
    ]);
  });

  it('puts the model the runtime launches with first, and keeps the rest in the catalog’s order', () => {
    const catalog = render([entry('a'), entry('b'), entry('c')], 'b');
    expect(catalog.models.map(model => model.slug)).toEqual(['b', 'a', 'c']);
    expect(catalog.models.map(model => model.priority)).toEqual([1, 2, 3]);
    expect(render([entry('a'), entry('b')]).models.map(model => model.slug)).toEqual(['a', 'b']);
    expect(renderCodexModelCatalog([entry('a')]).endsWith('}\n')).toBe(true);
  });

  it('describes a model by its tier, its window and its note, joined with a dot', () => {
    expect(only(entry('m', { tier: 'best', context: 1_000_000, note: 'Careful' })).description).toBe(
      'Best · 1M context · Careful',
    );
    expect(only(entry('m', { tier: 'fast', context: 1_050_000 })).description).toBe('Fast · 1.05M context');
    expect(only(entry('m', { tier: 'balanced', context: 128_000 })).description).toBe('Balanced · 128K context');
    expect(only(entry('m', { context: 400 })).description).toBe('1K context');
  });

  it('writes no description at all for a model with nothing to say, and no window without a context', () => {
    const bare = only(entry('m'));
    expect(bare).not.toHaveProperty('description');
    expect(bare).not.toHaveProperty('context_window');
    expect(bare).not.toHaveProperty('max_context_window');
    expect(only(entry('m', { context: 128_000 }))).toMatchObject({
      context_window: 128_000,
      max_context_window: 128_000,
    });
  });

  it('starts a picker on the catalog’s effort, else medium when the model takes it, else its first', () => {
    expect(only(entry('m', { efforts: ['low', 'high'], defaultEffort: 'high' })).default_reasoning_level).toBe('high');
    expect(only(entry('m', { efforts: ['low', 'medium', 'high'] })).default_reasoning_level).toBe('medium');
    expect(only(entry('m', { efforts: ['low', 'high'] })).default_reasoning_level).toBe('low');
    expect(only(entry('m')).default_reasoning_level).toBeUndefined();
    expect(only(entry('m'))).not.toHaveProperty('default_reasoning_level');
  });

  it('words each effort, and passes through one it has no words for', () => {
    expect(only(entry('m', { efforts: ['low', 'turbo'] })).supported_reasoning_levels).toEqual([
      { effort: 'low', description: 'Fast responses with lighter reasoning' },
      { effort: 'turbo', description: 'turbo' },
    ]);
  });

  it('keeps Codex’s own list for a login with no catalog, a catalog Codex knows, or no usable model', () => {
    const source = (id: string) => ({ id, label: id, origin: 'file' as const, customIds: false, docs: '' });
    const derived = (overrides: Partial<RuntimeModels>): RuntimeModels => ({
      models: [],
      default: undefined,
      env: {},
      ...overrides,
    });
    const usable = entry('ok');
    expect(codexCatalogModels(derived({ models: [usable] }))).toBeUndefined();
    for (const known of ['openai', 'azure-openai']) {
      expect(codexCatalogModels(derived({ catalog: source(known), models: [usable] }))).toBeUndefined();
    }
    expect(
      codexCatalogModels(derived({ catalog: source('acme'), models: [entry('gone', { available: false })] })),
    ).toBeUndefined();
    expect(
      codexCatalogModels(derived({ catalog: source('acme'), models: [usable, entry('gone', { available: false })] })),
    ).toEqual([usable]);
  });
});
