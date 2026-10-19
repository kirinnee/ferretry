/** Pack mode fixtures the suites share: a fleet's model list and the view `GET /v1/pack` answers. */

import { DEFAULT_PACK_CONFIG, type PackFleetModel, type PackView } from '@ferretry/protocol';

const model = (overrides: Partial<PackFleetModel> & Pick<PackFleetModel, 'id' | 'label'>): PackFleetModel => ({
  provider: 'anthropic',
  providerLabel: 'Anthropic',
  harness: 'claude',
  tier: 'balanced',
  efforts: [],
  runtimes: ['claude-main'],
  ...overrides,
});

export const OPUS = model({
  id: 'claude-opus-5-5',
  label: 'Claude Opus 5.5',
  tier: 'best',
  efforts: ['low', 'high', 'max'],
});
export const SONNET = model({ id: 'claude-sonnet-5', label: 'Claude Sonnet 5' });
export const HAIKU = model({ id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', tier: 'fast' });
export const LATEST = model({ id: '~anthropic/claude-opus-latest', label: 'Opus (latest)', tier: 'best' });
export const GLM = model({
  provider: 'zai',
  providerLabel: 'z.ai',
  id: 'glm-5.3',
  label: 'GLM-5.3',
  runtimes: [],
});
export const ASTRA = model({
  provider: 'openai',
  providerLabel: 'OpenAI',
  harness: 'codex',
  id: 'gpt-6-astra',
  label: 'GPT-6 Astra',
  tier: 'best',
  efforts: ['medium', 'high'],
  runtimes: ['codex-main'],
});
export const OSS = model({
  provider: 'ollama',
  providerLabel: 'Ollama',
  id: 'gpt-oss:20b',
  label: 'gpt-oss 20B',
  tier: 'fast',
});
export const FLASH = model({
  provider: 'deepseek',
  providerLabel: 'DeepSeek',
  id: 'deepseek-flash[1m]',
  label: 'DeepSeek Flash 1M',
  tier: 'fast',
  runtimes: [],
});

export const FLEET_MODELS: readonly PackFleetModel[] = [OPUS, SONNET, HAIKU, LATEST, GLM, ASTRA, OSS, FLASH];

export const PACK_VIEW: PackView = {
  config: DEFAULT_PACK_CONFIG,
  guide: {
    source: 'derived',
    useCases: [
      {
        id: 'hard',
        title: 'Hard planning / review / critical code',
        description: 'Plans, reviews and the code that must not break. Prefer claude-opus-5-5.',
        keywords: ['plan', 'review'],
        candidates: [
          { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'high', why: 'The strongest reasoning here.' },
          { provider: 'openai', model: 'gpt-6-astra', why: 'A second family for a second opinion.' },
        ],
      },
      {
        id: 'bulk',
        title: 'Mechanical bulk edits',
        description: 'Renames and one-line chores across many files.',
        candidates: [{ provider: 'anthropic', model: 'claude-haiku-4-5', why: 'Fast and cheap.' }],
      },
    ],
  },
  models: FLEET_MODELS,
};
