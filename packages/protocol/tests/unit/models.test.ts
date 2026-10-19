import { describe, it } from 'bun:test';
import * as models from '../../src/lib/models.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const local = {
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  state: 'found',
  models: [
    {
      id: 'gpt-oss:20b',
      label: 'gpt-oss:20b',
      sizeBytes: 13_780_173_839,
      parameterSize: '20.9B',
      quantization: 'MXFP4',
      family: 'gptoss',
      modifiedAt: '2026-10-18T10:12:42.123Z',
    },
  ],
  checkedAt: '2026-10-19T00:00:00.000Z',
  message: 'Ollama has 1 model installed on this machine.',
  pullCommand: 'ollama pull gpt-oss:20b',
} as const;

const cases: SchemaCase[] = [
  {
    name: 'catalog entry',
    schema: models.ModelCatalogEntryViewSchema,
    value: { id: 'glm-5.3', label: 'GLM-5.3', tier: 'best', efforts: ['low'], default: true },
  },
  {
    name: 'catalog',
    schema: models.ModelCatalogViewSchema,
    value: { id: 'zai', label: 'GLM', origin: 'built-in', verified: '2026-10-18', customIds: false },
  },
  { name: 'refresh outcome', schema: models.ModelCatalogRefreshOutcomeSchema, value: 'not-due' },
  { name: 'refresh result', schema: models.ModelCatalogRefreshResultSchema, value: { outcome: 'updated', version: 4 } },
  {
    name: 'catalogs',
    schema: models.ModelCatalogsViewSchema,
    value: { published: { origin: 'https://ferretry.pages.dev', enabled: true }, catalogs: [] },
  },
  { name: 'local state', schema: models.LocalModelsStateSchema, value: 'not-running' },
  { name: 'local model', schema: models.LocalModelSchema, value: local.models[0] },
  { name: 'local models', schema: models.LocalModelsSchema, value: local },
  {
    name: 'local models, none pulled',
    schema: models.LocalModelsSchema,
    value: { ...local, state: 'none-pulled', models: [] },
  },
];

describe('models wire contract', () => {
  it('should round-trip every schema', () => {
    assertRoundTrips(cases);
  });

  it('should cover every exported schema', () => {
    assertCoversEverySchema(models, cases);
  });

  it('should refuse a state it does not know, a stray field and an empty command', () => {
    assertRejects([
      { name: 'unknown state', schema: models.LocalModelsSchema, value: { ...local, state: 'sleeping' } },
      { name: 'stray field', schema: models.LocalModelsSchema, value: { ...local, token: 'x' } },
      { name: 'empty command', schema: models.LocalModelsSchema, value: { ...local, pullCommand: '' } },
      { name: 'other provider', schema: models.LocalModelsSchema, value: { ...local, provider: 'lmstudio' } },
      { name: 'empty id', schema: models.LocalModelSchema, value: { id: '', label: 'x' } },
    ]);
  });
});
