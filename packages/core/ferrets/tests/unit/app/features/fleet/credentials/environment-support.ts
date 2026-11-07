import type { FleetCredentialEnvironment, FleetProviderPresetView } from '@ferretry/protocol';

/** A preset as the daemon answers it, with every field a test does not care about filled in. */
const preset = (overrides: Partial<FleetProviderPresetView> & { readonly id: string }): FleetProviderPresetView => ({
  label: overrides.id,
  harness: 'claude',
  summary: 'Claude Code on a provider.',
  docs: 'https://docs.example.com/claude',
  origin: 'built-in',
  variables: [],
  models: [],
  test: { available: true, spends: 'nothing', note: 'Lists your models. Spends nothing.' },
  quota: { source: 'transcript-pricing', note: 'Counted from the transcript.' },
  unverified: [],
  verified: '2026-10-16',
  offered: { available: true },
  ...overrides,
});

export const ZAI = preset({
  id: 'zai-glm',
  group: 'popular',
  label: 'GLM / Z.ai',
  quota: { source: 'zai-coding-plan', note: 'Z.ai’s Coding Plan quota.' },
  unverified: ['The quota endpoint is community-documented.'],
  variables: [
    {
      name: 'ANTHROPIC_BASE_URL',
      kind: 'plain',
      value: 'https://api.z.ai/api/anthropic',
      required: true,
      allowEmpty: false,
    },
    { name: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', secret: 'ZAI_API_KEY', required: true, allowEmpty: false },
    { name: 'API_TIMEOUT_MS', kind: 'plain', value: '', required: false, allowEmpty: false, description: 'a timeout' },
    { name: 'EXTRA_TOKEN', kind: 'secret', secret: 'EXTRA_KEY', required: false, allowEmpty: false },
    { name: 'ANTHROPIC_API_KEY', kind: 'plain', value: '', required: true, allowEmpty: true },
  ],
});

export const FOUNDRY = preset({
  id: 'foundry',
  label: 'Microsoft Foundry (API key)',
  test: { available: true, spends: 'one-token', note: 'Sends one message capped at one token.' },
  variables: [
    { name: 'ANTHROPIC_FOUNDRY_API_KEY', kind: 'secret', secret: 'FOUNDRY_KEY', required: true, allowEmpty: false },
  ],
});

export const BEDROCK = preset({
  id: 'amazon-bedrock',
  group: 'cloud',
  label: 'Amazon Bedrock (AWS profile)',
  test: { available: false, reason: 'Bedrock needs AWS request signing.' },
  cloudCredential: { kinds: ['aws-profile'], suggested: 'aws-profile:default' },
  variables: [{ name: 'AWS_REGION', kind: 'plain', value: 'us-east-1', required: true, allowEmpty: false }],
});

export const OLLAMA = preset({ id: 'ollama-codex', label: 'Ollama (local)', harness: 'codex' });

export const ZAI_CODEX = preset({
  id: 'zai-glm-codex',
  group: 'popular',
  label: 'GLM / Z.ai',
  harness: 'codex',
  offered: { available: false, reason: 'Codex needs a model catalogue file.' },
});

export const PRESETS = { presets: [ZAI, FOUNDRY, BEDROCK, OLLAMA, ZAI_CODEX] };

export const ENVIRONMENT: FleetCredentialEnvironment = {
  preset: { id: 'zai-glm', label: 'GLM / Z.ai', docs: 'https://docs.z.ai/devpack/tool/claude' },
  variables: [
    { name: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', secrets: ['ZAI_API_KEY'], set: true },
    { name: 'ANTHROPIC_BASE_URL', kind: 'plain', value: 'https://api.z.ai/api/anthropic' },
    { name: 'ANTHROPIC_API_KEY', kind: 'plain', value: '' },
    { name: 'GATEWAY', kind: 'secret', secrets: ['GW_KEY'], set: false },
    { name: 'ODD_TOKEN', kind: 'hidden' },
  ],
  quotaSource: 'zai-coding-plan',
  missingSecrets: ['GW_KEY'],
  test: { available: true, spends: 'nothing', note: 'Reads your quota. Spends nothing.' },
};

/** A preset with a `claude:` and a `codex:` half: one key, both CLIs. */
export const DEEPSEEK = preset({
  id: 'deepseek',
  group: 'popular',
  label: 'DeepSeek',
  summary: 'Claude Code and Codex on DeepSeek models with one DeepSeek platform key.',
  halves: [
    { harness: 'claude', offered: { available: true }, models: ['deepseek-flash'] },
    {
      harness: 'codex',
      offered: { available: true },
      docs: 'https://api-docs.deepseek.com/codex',
      models: ['deepseek-flash'],
    },
  ],
  detect: { hosts: ['api.deepseek.com'], variables: ['DEEPSEEK_*'], keyPrefixes: [] },
  variables: [
    {
      name: 'ANTHROPIC_BASE_URL',
      kind: 'plain',
      value: 'https://api.deepseek.com/anthropic',
      required: true,
      allowEmpty: false,
      harnesses: ['claude'],
    },
    {
      name: 'ANTHROPIC_AUTH_TOKEN',
      kind: 'secret',
      secret: 'DEEPSEEK_API_KEY',
      required: true,
      allowEmpty: false,
      harnesses: ['claude'],
    },
    {
      name: 'DEEPSEEK_API_KEY',
      kind: 'secret',
      secret: 'DEEPSEEK_API_KEY',
      required: true,
      allowEmpty: false,
      harnesses: ['codex'],
    },
  ],
});

/** Another dual preset on the same host, so a paste can match two. */
export const DEEPSEEK_MIRROR = preset({
  id: 'deepseek-mirror',
  label: 'DeepSeek mirror',
  halves: [
    { harness: 'claude', offered: { available: true }, models: [] },
    { harness: 'codex', offered: { available: false, reason: 'No Responses API.' }, models: [] },
  ],
  detect: { hosts: ['api.deepseek.com'], variables: [], keyPrefixes: [] },
  variables: [{ name: 'MIRROR_KEY', kind: 'secret', secret: 'MIRROR_KEY', required: true, allowEmpty: false }],
});

/** Codex on an Azure resource: a required value with no default. */
export const AZURE = preset({
  id: 'azure-openai',
  group: 'cloud',
  label: 'Azure OpenAI',
  harness: 'codex',
  detect: { hosts: ['openai.azure.com'], variables: ['AZURE_OPENAI_*'], keyPrefixes: [] },
  variables: [
    {
      name: 'AZURE_OPENAI_RESOURCE',
      kind: 'plain',
      value: '',
      required: true,
      allowEmpty: false,
      description: 'the resource name',
    },
    { name: 'AZURE_OPENAI_API_KEY', kind: 'secret', secret: 'AZURE_OPENAI_API_KEY', required: true, allowEmpty: false },
  ],
});

/** The custom gateway: no clues, a blank base URL. */
export const GATEWAY = preset({
  id: 'custom-gateway',
  group: 'self-hosted',
  label: 'Custom gateway',
  variables: [
    { name: 'ANTHROPIC_BASE_URL', kind: 'plain', value: '', required: true, allowEmpty: false },
    { name: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', secret: 'GATEWAY_API_KEY', required: true, allowEmpty: false },
    { name: 'ANTHROPIC_MODEL', kind: 'plain', value: '', required: false, allowEmpty: false },
  ],
});

/** The catalogue the one-click suites read: the gateway first, so the grid's reordering shows. */
export const PROVIDERS = { presets: [GATEWAY, DEEPSEEK, ZAI, ZAI_CODEX, AZURE, DEEPSEEK_MIRROR, BEDROCK] };
