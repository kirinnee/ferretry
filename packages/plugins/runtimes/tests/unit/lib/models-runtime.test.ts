import { describe, it } from 'bun:test';
import { type LocalModels, ModelCatalogFileSchema } from '@ferretry/plugin-logins/contract';
import should from 'should';
import type { Instant } from '@ferretry/std';
import { loginModelCatalog } from '../../../daemon/lib/models/catalog.ts';
import { runtimeModels } from '../../../daemon/lib/models/runtime.ts';
import type { ModelCatalog } from '../../../daemon/lib/models/schema.ts';
import { builtInModelCatalogs, builtInPresets } from './fixtures/built-ins.ts';

const CATALOGS = builtInModelCatalogs();
const PRESETS = builtInPresets();

const model = (id: string, extra: Record<string, unknown> = {}) => ({ id, label: id, tier: 'best', ...extra });
const catalogOf = (file: Record<string, unknown>, id = 'acme'): ModelCatalog => ({
  ...ModelCatalogFileSchema.parse({
    label: 'Acme',
    docs: 'https://acme.example/docs',
    verified: '2026-10-18',
    ...file,
  }),
  id,
  origin: 'file',
});

describe('runtimeModels', () => {
  const zai = CATALOGS.zai as ModelCatalog;
  const modelSet = (declaredDefault: string) =>
    ({
      source: 'model-set',
      layer: {
        reference: 'modelSets/claude',
        componentKind: 'modelSets',
        name: 'claude',
        origin: 'modelSets/claude',
        via: [],
      },
      models: [{ id: declaredDefault, available: true }],
      declaredDefault,
      default: declaredDefault,
      fellBack: false,
      noneAvailable: false,
    }) as const;

  it("should offer the profile's model set when the login has no catalog", () => {
    should(runtimeModels({ harness: 'claude', modelSet: modelSet('claude-opus-5') })).eql({
      models: [{ id: 'claude-opus-5', label: 'claude-opus-5', efforts: [], available: true }],
      default: 'claude-opus-5',
      env: {},
    });
    should(runtimeModels({ harness: 'claude', modelSet: { source: 'harness-default' } })).eql({
      models: [],
      default: undefined,
      env: {},
    });
    should(runtimeModels({ harness: 'codex', modelSet: undefined, catalog: zai }).models).be.empty();
  });

  it("should offer exactly the catalog, launch on its default, and pin Claude Code's tier slots", () => {
    // Act
    const derived = runtimeModels({ harness: 'claude', modelSet: modelSet('claude-opus-5'), catalog: zai });

    // Assert
    should(derived.models.map(entry => entry.id)).eql(['glm-5.3', 'glm-5.3-flash']);
    should(derived.models[0]).match({
      label: 'GLM-5.3',
      tier: 'best',
      efforts: ['low', 'high', 'max'],
      reasoning: true,
    });
    should(derived.models[1]).match({ reasoning: true, efforts: [] });
    should(derived.default).equal('glm-5.3');
    should(derived.env).eql({
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3-flash',
    });
    should(derived.catalog).match({ id: 'zai', customIds: false, origin: 'built-in' });
  });

  it("should keep the profile's default when it names a catalog model, by id or tier alias", () => {
    should(runtimeModels({ harness: 'claude', modelSet: modelSet('haiku'), catalog: zai }).default).equal(
      'glm-5.3-flash',
    );
    should(
      runtimeModels({ harness: 'claude', modelSet: modelSet('deepseek-v4-pro'), catalog: CATALOGS.deepseek }).default,
    ).equal('deepseek-v4-pro[1m]');
  });

  it("should never pin a variable the preset leaves to the person, and mark what the login can't use", () => {
    // Act
    const derived = runtimeModels({
      harness: 'claude',
      modelSet: undefined,
      catalog: zai,
      personOwned: new Set(['ANTHROPIC_DEFAULT_OPUS_MODEL']),
      availableModels: ['glm-5.3-flash'],
    });
    const none = runtimeModels({ harness: 'claude', modelSet: undefined, catalog: zai, availableModels: [] });

    // Assert
    should(derived.env).not.have.property('ANTHROPIC_DEFAULT_OPUS_MODEL');
    should(derived.models.map(entry => entry.available)).eql([false, true]);
    should(derived.default).equal('glm-5.3-flash');
    should(none.default).be.undefined();
  });

  it('should describe a model with a note, and a model the catalog says nothing about reasoning for', () => {
    // Arrange
    const catalog = catalogOf({
      detect: 'ollama',
      codex: { docs: 'https://acme.example/codex', models: [model('a', { default: true, note: 'Local.' })] },
    });

    // Act
    const derived = runtimeModels({ harness: 'codex', modelSet: undefined, catalog });

    // Assert
    should(derived.models[0]).eql({ id: 'a', label: 'a', tier: 'best', efforts: [], note: 'Local.', available: true });
    should(derived.catalog).match({ docs: 'https://acme.example/codex', detect: 'ollama' });
  });

  describe('with the models a local server has installed', () => {
    const ollama = CATALOGS.ollama as ModelCatalog;
    const installed = (state: LocalModels['state'], ids: readonly string[]): LocalModels => ({
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      state,
      models: ids.map(id => ({ id, label: id })),
      checkedAt: '2026-10-19T00:00:00.000Z' as Instant,
      message: 'Ollama says so.',
      pullCommand: 'ollama pull gpt-oss:20b',
    });

    it('should offer only what is installed, keep the catalog’s words for a model it knows, and mark each local', () => {
      // Arrange / Act
      const derived = runtimeModels({
        harness: 'codex',
        modelSet: undefined,
        catalog: ollama,
        local: installed('found', ['llama3.2:latest', 'gpt-oss:120b']),
      });

      // Assert
      should(derived.models.map(entry => [entry.id, entry.label, entry.local, entry.available])).eql([
        ['gpt-oss:120b', 'gpt-oss 120B', true, true],
        ['llama3.2:latest', 'llama3.2:latest', true, true],
      ]);
      should(derived.models[0]).match({ tier: 'best', context: 128000, efforts: ['low', 'medium', 'high'] });
      should(derived.models[1]).eql({
        id: 'llama3.2:latest',
        label: 'llama3.2:latest',
        efforts: [],
        available: true,
        local: true,
      });
      should(derived.default).equal('gpt-oss:120b');
      should(derived.local?.state).equal('found');
    });

    it('should launch with the catalog’s default when it is installed', () => {
      // Arrange / Act
      const derived = runtimeModels({
        harness: 'codex',
        modelSet: undefined,
        catalog: ollama,
        local: installed('found', ['llama3.2:latest', 'gpt-oss:20b']),
      });

      // Assert
      should(derived.default).equal('gpt-oss:20b');
    });

    it('should keep the catalog’s suggestions, and say what was found, when no model is installed', () => {
      // Arrange / Act
      const states = (['none-pulled', 'not-running', 'unreadable', 'refused', 'disabled'] as const).map(state =>
        runtimeModels({ harness: 'codex', modelSet: undefined, catalog: ollama, local: installed(state, []) }),
      );

      // Assert
      for (const derived of states) {
        should(derived.models.map(entry => [entry.id, entry.local])).eql([
          ['gpt-oss:20b', undefined],
          ['gpt-oss:120b', undefined],
        ]);
        should(derived.local).not.be.undefined();
      }
    });

    it('should hand a login the snapshot only when its catalog detects that server', () => {
      // Arrange
      const local = installed('found', ['gpt-oss:20b']);
      const sources = { catalogs: CATALOGS, presets: PRESETS, local: { ollama: local } };

      // Act
      const ollamaLogin = loginModelCatalog({ store: 'environment', preset: 'ollama-codex' }, 'codex', sources);
      const zaiLogin = loginModelCatalog({ store: 'environment', preset: 'zai-glm' }, 'claude', sources);
      const unread = loginModelCatalog({ store: 'environment', preset: 'ollama-codex' }, 'codex', {
        catalogs: CATALOGS,
        presets: PRESETS,
      });

      // Assert
      should(ollamaLogin.local).equal(local);
      should(zaiLogin.local).be.undefined();
      should(unread.local).be.undefined();
    });
  });
});
