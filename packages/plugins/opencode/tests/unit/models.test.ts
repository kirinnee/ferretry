import { expect, test } from 'bun:test';
import { HarnessKeySchema } from '@ferretry/core-ferrets/contract';
import { ModelCatalogSourcesSchema } from '@ferretry/plugin-logins/contract';
import { fakeLogins } from '@ferretry/plugin-logins/contract/testing';
import { opencodeModels } from '../../daemon/lib/models.ts';

const now = Date.parse('2026-11-26T00:00:00Z');
function fixture(options: { preferred?: string; preset?: boolean; provider?: string } = {}) {
  const provider = options.provider ?? 'deepseek';
  const logins = fakeLogins();
  logins.setTemplates([
    {
      id: 'key',
      kind: 'templates',
      harness: HarnessKeySchema.parse('opencode'),
      ...(options.preset === false ? {} : { preset: 'deepseek' }),
      env: { DEEPSEEK_API_KEY: '${secret:DEEPSEEK_API_KEY}' },
    },
  ]);
  const sources = ModelCatalogSourcesSchema.parse({
    catalogs: {
      deepseek: {
        id: 'deepseek',
        origin: 'file',
        label: 'DeepSeek',
        docs: 'https://example.test/models',
        verified: '2026-11-26',
        opencode: {
          models: [
            {
              id: options.preferred ?? 'deepseek-flash',
              label: 'Curated label',
              tier: 'balanced',
              default: true,
              efforts: ['high'],
            },
          ],
        },
      },
    },
    presets: [{ id: 'deepseek', catalog: 'deepseek', variables: {} }],
    discovery: {
      providers: {
        [provider]: {
          name: 'DeepSeek',
          env: ['DEEPSEEK_API_KEY'],
          models: {
            'deepseek-flash': {
              name: 'Captured Flash name',
              tool_call: true,
              reasoning: true,
              limit: { context: 123456 },
            },
            'deepseek-v4-pro': { name: 'Captured Pro name', tool_call: true },
            image: { name: 'Image model', tool_call: false },
            unknown: { name: 'Unknown tool support' },
            retired: { name: 'Retired model', tool_call: true, retires: '2026-11-25' },
            retiring: { name: 'Retiring model', tool_call: true, status: 'retiring' },
            zero: { name: 'Unstated window', tool_call: true, limit: { context: 0 } },
          },
        },
      },
    },
  });
  logins.setModelSources(sources);
  return { logins, sources };
}

test('discovery keeps exact models.dev ids and metadata separate from curated defaults and efforts', async () => {
  const f = fixture();
  const original = structuredClone(f.sources);
  expect(await opencodeModels(f.logins, 'key', now)).toEqual({
    choices: [
      { id: 'deepseek/deepseek-flash', label: 'Captured Flash name', context: 123456, reasoning: true },
      { id: 'deepseek/deepseek-v4-pro', label: 'Captured Pro name' },
      { id: 'deepseek/zero', label: 'Unstated window' },
    ],
    default: 'deepseek/deepseek-flash',
  });
  expect(f.sources).toEqual(original);
  expect((await opencodeModels(f.logins, 'key', now)).choices.every(model => model.variants === undefined)).toBe(true);
});

test('a missing exact curated default requires an explicit choice; no first model becomes default', async () => {
  const f = fixture({ preferred: 'removed/model' });
  expect((await opencodeModels(f.logins, 'key', now)).default).toBeUndefined();
  f.sources.catalogs.deepseek!.opencode!.models[0]!.id = 'deepseek/deepseek-v4-pro';
  expect((await opencodeModels(f.logins, 'key', now)).default).toBe('deepseek/deepseek-v4-pro');
});

test('provider matching uses a preset catalog or one unambiguous native variable name, never a secret value', async () => {
  const native = fixture({ preset: false });
  expect((await opencodeModels(native.logins, 'key', now)).choices[0]?.id).toBe('deepseek/deepseek-flash');
  expect((await opencodeModels(native.logins, 'key', now)).default).toBeUndefined();
  native.sources.discovery!.providers.other = { ...native.sources.discovery!.providers.deepseek! };
  expect(await opencodeModels(native.logins, 'key', now)).toEqual({ choices: [] });
  const unknownPreset = fixture({ provider: 'different-provider' });
  expect(await opencodeModels(unknownPreset.logins, 'key', now)).toEqual({ choices: [] });
});

test('missing, withheld or unavailable public discovery offers no models and reads no status or Vault', async () => {
  expect(await opencodeModels(undefined, 'key', now)).toEqual({ choices: [] });
  const f = fixture();
  expect(await opencodeModels(f.logins, 'missing', now)).toEqual({ choices: [] });
  f.logins.setTemplates([
    { id: 'key', kind: 'withheld', harness: HarnessKeySchema.parse('opencode'), variables: ['DEEPSEEK_API_KEY'] },
  ]);
  expect(await opencodeModels(f.logins, 'key', now)).toEqual({ choices: [] });
  const absent = fixture();
  delete absent.sources.discovery;
  expect(await opencodeModels(absent.logins, 'key', now)).toEqual({ choices: [] });
});

test('Qwen Coding Plan uses its login preset provider rather than the shared Qwen catalog', async () => {
  const f = fixture();
  f.logins.setTemplates([
    {
      id: 'key',
      kind: 'templates',
      harness: HarnessKeySchema.parse('opencode'),
      preset: 'qwen-coding-plan',
      env: { ALIBABA_CODING_PLAN_API_KEY: '${secret:FIXTURE_KEY}' },
    },
  ]);
  f.sources.presets = [{ id: 'qwen-coding-plan', catalog: 'qwen', variables: {} }];
  f.sources.discovery!.providers = {
    alibaba: {
      name: 'Alibaba',
      env: ['DASHSCOPE_API_KEY'],
      models: { payg: { name: 'Pay as you go', tool_call: true } },
    },
    'alibaba-coding-plan': {
      name: 'Alibaba Coding Plan',
      env: ['ALIBABA_CODING_PLAN_API_KEY'],
      models: {
        'qwen3.7-plus': { name: 'Qwen Coding', tool_call: true },
      },
    },
  };
  expect(await opencodeModels(f.logins, 'key', now)).toEqual({
    choices: [{ id: 'alibaba-coding-plan/qwen3.7-plus', label: 'Qwen Coding' }],
  });
});
