/** Pack mode fixtures the suites share: a fleet's model list and the view `GET /v1/pack` answers. */

import {
  DEFAULT_PACK_CONFIG,
  type PackCleanUpJob,
  type PackCleanUpSuggestion,
  type PackFleetModel,
  type PackModelOption,
  type PackQuota,
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
const SONNET = model({ id: 'claude-sonnet-5', label: 'Claude Sonnet 5' });
const HAIKU = model({ id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', tier: 'fast' });
const LATEST = model({ id: '~anthropic/claude-opus-latest', label: 'Opus (latest)', tier: 'best' });
const GLM = model({
  provider: 'zai',
  providerLabel: 'z.ai',
  id: 'glm-5.3',
  label: 'GLM-5.3',
  runtimes: [],
});
const ASTRA = model({
  provider: 'openai',
  providerLabel: 'OpenAI',
  harness: 'codex',
  id: 'gpt-6-astra',
  label: 'GPT-6 Astra',
  tier: 'best',
  efforts: ['medium', 'high'],
  runtimes: ['codex-main'],
});
const OSS = model({
  provider: 'ollama',
  providerLabel: 'Ollama',
  id: 'gpt-oss:20b',
  label: 'gpt-oss 20B',
  tier: 'fast',
});
const FLASH = model({
  provider: 'deepseek',
  providerLabel: 'DeepSeek',
  id: 'deepseek-flash[1m]',
  label: 'DeepSeek Flash 1M',
  tier: 'fast',
  runtimes: [],
});

export const FLEET_MODELS: readonly PackFleetModel[] = [OPUS, SONNET, HAIKU, LATEST, GLM, ASTRA, OSS, FLASH];

const quota = (state: PackQuota['state'], summary: string, leftPercent?: number): PackQuota => ({
  state,
  ...(leftPercent === undefined ? {} : { leftPercent }),
  windows: [],
  summary,
});

/** What runtimes here can start now, as the daemon orders them: ready first, then by quota left. */
const AVAILABLE: readonly PackModelOption[] = [
  {
    provider: 'anthropic',
    model: OPUS.id,
    modelLabel: OPUS.label,
    harness: 'claude',
    tier: 'best',
    efforts: OPUS.efforts,
    runtime: 'claude-main',
    runtimes: 1,
    ready: true,
    quota: quota('plenty', '5h 12% · week 30%', 70),
    named: 1,
    effort: 'max',
    command: 'fy new --runtime claude-main --model claude-opus-5-5 --effort max',
  },
  {
    provider: 'openai',
    model: ASTRA.id,
    modelLabel: ASTRA.label,
    harness: 'codex',
    tier: 'best',
    efforts: ASTRA.efforts,
    runtime: 'codex-main',
    runtimes: 1,
    ready: true,
    quota: quota('low', '5h 91% · week 64%', 9),
    named: 2,
  },
  {
    provider: 'anthropic',
    model: HAIKU.id,
    modelLabel: HAIKU.label,
    harness: 'claude',
    tier: 'fast',
    efforts: [],
    runtime: 'claude-spare',
    runtimes: 2,
    ready: false,
    refusal: {
      code: 'out_of_quota',
      message: 'claude-spare is out of quota until 18:00Z.',
      remedy: 'Wait for the reset, or add a login.',
    },
    quota: quota('exhausted', 'out of quota until 18:00Z', 0),
  },
];

/** The default routing prompt, rendered from the catalogs: nothing written. */
const DEFAULT_ROUTING = {
  text: 'Planning, review and critical code → claude-opus-5-5 at max. Everyday work → claude-sonnet-5. Chores → claude-haiku-4-5.',
  source: 'default',
} as const;

export const PACK_VIEW: PackView = {
  config: DEFAULT_PACK_CONFIG,
  routing: DEFAULT_ROUTING,
  models: FLEET_MODELS,
  available: AVAILABLE,
  cleanUp: { available: false, runtimes: [], reason: 'No agent runtime here is ready to run a clean-up.' },
};

/** The owner's own words, which name a known, an absent and an unknown model. */
export const OWNER_PROMPT = 'Hard work → claude-opus-5-5 at max, or glm-5.3. Never gpt-6-astra-mini.';

export const OWNER_VIEW: PackView = {
  ...PACK_VIEW,
  routing: { text: OWNER_PROMPT, source: 'file' },
  cleanUp: { available: true, runtimes: ['codex-main', 'claude-main'] },
};

/** What a `MachinePack` does for the routing calls when a suite is not about them: nothing, and says so. */
export const IDLE_ROUTING_API: Pick<MachinePack, 'savePrompt' | 'cleanUp' | 'readJob' | 'accept' | 'undo'> = {
  savePrompt: async () => ({ kind: 'refused', message: 'Not under test.' }),
  cleanUp: async () => ({ kind: 'refused', message: 'Not under test.' }),
  readJob: async () => ({ kind: 'failed', message: 'Not under test.' }),
  accept: async () => ({ kind: 'refused', message: 'Not under test.' }),
  undo: async () => ({ kind: 'refused', message: 'Not under test.' }),
};

/** A clean-up run as the daemon reports it. */
export const RUNNING_JOB: PackCleanUpJob = {
  id: 'job-1',
  session: 'mvjcjssv-cleanup',
  name: 'Routing Clean Up',
  runtime: 'codex-main',
  model: 'gpt-6-astra',
  startedAt: '2026-10-22T14:29:00.000Z',
  status: 'running',
};

/** A realistic checked rewrite of a rough prompt, with one note of each kind. */
export const SUGGESTION: PackCleanUpSuggestion = {
  suggested: { by: 'gpt-6-astra', via: 'codex-main', at: '2026-10-22T14:30:00.000Z' },
  before: 'use opus for hard stuff and glm-9 for the rest, haiku for chores when theres quota',
  after:
    'Planning, review and critical code → claude-opus-5-5 at max. Chores → claude-haiku-4-5 low while its login has quota left. Everything else → claude-sonnet-5.',
  notes: [
    { kind: 'unknown_model', message: 'No catalog lists glm-9, so it was left out.', model: 'glm-9' },
    { kind: 'absent_model', message: 'GLM-5.3 runs on no runtime here.', model: 'glm-5.3' },
    { kind: 'cut', message: 'The rewrite was cut to fit 1,200 characters.' },
    { kind: 'suggestion', message: 'Add a second Claude login so chores do not wait for quota.' },
  ],
};
