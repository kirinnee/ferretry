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
  label: 'Amazon Bedrock (AWS profile)',
  test: { available: false, reason: 'Bedrock needs AWS request signing.' },
  cloudCredential: { kinds: ['aws-profile'], suggested: 'aws-profile:default' },
  variables: [{ name: 'AWS_REGION', kind: 'plain', value: 'us-east-1', required: true, allowEmpty: false }],
});

export const OLLAMA = preset({ id: 'ollama-codex', label: 'Ollama (local)', harness: 'codex' });

export const ZAI_CODEX = preset({
  id: 'zai-glm-codex',
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
