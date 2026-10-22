/** Pack mode fixtures the suites share: a fleet's model list and the view `GET /v1/pack` answers. */

import {
  DEFAULT_PACK_CONFIG,
  type GuideUseCase,
  type ModelsGuide,
  type PackFleetModel,
  type PackGuideJob,
  type PackGuideSuggestion,
  type PackView,
} from '@ferretry/protocol';
import type { MachinePack } from '../../src/features/pack/use-machine-pack.ts';

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

/** What a `MachinePack` does for the generator calls when a suite is not about them: nothing, and says so. */
export const IDLE_GUIDE_API: Pick<MachinePack, 'suggest' | 'readJob' | 'acceptGuide' | 'undoGuide' | 'describeModel'> =
  {
    suggest: async () => ({ kind: 'refused', message: 'Not under test.' }),
    readJob: async () => ({ kind: 'failed', message: 'Not under test.' }),
    acceptGuide: async () => ({ kind: 'refused', message: 'Not under test.' }),
    undoGuide: async () => ({ kind: 'refused', message: 'Not under test.' }),
    describeModel: async () => ({ kind: 'refused', message: 'Not under test.' }),
  };

const HARD = PACK_VIEW.guide.useCases[0] as GuideUseCase;
const BULK = PACK_VIEW.guide.useCases[1] as GuideUseCase;
const LEGACY: GuideUseCase = {
  id: 'legacy',
  title: 'Old shell chores',
  description: 'Chores nobody asks for any more.',
  candidates: [{ provider: 'ollama', model: 'gpt-oss:20b', why: 'Free and local.' }],
};

/** The guide in effect when the builder drafted `SUGGESTION`: the owner's own, with a routing line. */
export const CURRENT_GUIDE: ModelsGuide = {
  source: 'file',
  useCases: [HARD, BULK, LEGACY],
  routing: {
    source: 'file',
    prompt: 'Use Opus for anything hard.\nUse Haiku for everything else.',
    short: 'Opus for hard work, Haiku for the rest',
  },
};

/**
 * A realistic checked draft: the routing words changed; `hard` unchanged, `bulk` re-ranked, `docs` new and
 * `legacy` left out; one model dropped as listed nowhere and one effort flagged.
 */
export const SUGGESTION: PackGuideSuggestion = {
  suggested: { by: 'gpt-6-astra', via: 'codex-main', at: '2026-10-22T14:30:00.000Z' },
  routing: {
    prompt:
      'Use Opus for planning, review and critical code.\nUse Sonnet for ordinary edits.\nUse Haiku for bulk chores.',
    short: 'Opus plans, Sonnet edits, Haiku does chores',
  },
  useCases: [
    HARD,
    {
      ...BULK,
      description: 'Renames and one-line chores across many files; prefer the cheapest model that can do it.',
      candidates: [
        { provider: 'ollama', model: 'gpt-oss:20b', why: 'Runs here for free.' },
        { provider: 'anthropic', model: 'claude-haiku-4-5', why: 'Fast and cheap when the local one is busy.' },
      ],
    },
    {
      id: 'docs',
      title: 'Writing and docs',
      description: 'READMEs, changelogs and explanations.',
      candidates: [
        { provider: 'anthropic', model: 'claude-sonnet-5', effort: 'high', why: 'Clear prose at a fair price.' },
      ],
    },
  ],
  dropped: [
    { useCase: 'docs', provider: 'zai', model: 'glm-9', message: 'is not in any model catalog, so it was left out.' },
  ],
  flagged: [
    {
      useCase: 'hard',
      provider: 'openai',
      model: 'gpt-6-astra',
      message: 'effort “ultra” is not one it takes; the default is used.',
    },
  ],
  current: CURRENT_GUIDE,
};

/** A builder run as the daemon reports it. */
export const RUNNING_JOB: PackGuideJob = {
  id: 'job-1',
  session: 'mvjcjssv-builder',
  name: 'Guide Builder',
  runtime: 'codex-main',
  model: 'gpt-6-astra',
  startedAt: '2026-10-22T14:29:00.000Z',
  status: 'running',
};
