import { describe, expect, it } from 'bun:test';
import type { ProviderPresetView } from '../../../contract/index.ts';
import {
  alsoMatchedSentence,
  CUSTOM_GATEWAY,
  detectTable,
  detectionSentence,
  pasteTarget,
  prefillFrom,
  readPaste,
} from '../../../app/lib/paste-model.ts';

/** One offered preset, shaped as the wire sends it. */
const preset = (overrides: Partial<ProviderPresetView> & { readonly id: string }): ProviderPresetView => ({
  label: overrides.id,
  harness: 'claude-code',
  summary: 'A provider.',
  docs: 'https://docs.example.test',
  origin: 'built-in',
  variables: [],
  models: [],
  test: { available: true, spends: 'nothing', note: 'Free.' },
  quota: { source: 'none', note: 'n/a' },
  unverified: [],
  verified: '2026-10-16',
  offered: { available: true },
  halves: [{ harness: 'claude-code', offered: { available: true }, models: [] }],
  ...overrides,
});

const ZAI = preset({
  id: 'zai-glm',
  label: 'GLM / Z.ai',
  variables: [
    { name: 'ANTHROPIC_BASE_URL', kind: 'plain', required: true, allowEmpty: false, harnesses: ['claude-code'] },
    {
      name: 'ANTHROPIC_AUTH_TOKEN',
      kind: 'secret',
      secret: 'ZAI_API_KEY',
      required: true,
      allowEmpty: false,
      harnesses: ['claude-code'],
    },
  ],
  detect: { hosts: ['api.z.ai'], variables: ['ZAI_API_KEY'], keyPrefixes: [] },
});

const DEEPSEEK = preset({
  id: 'deepseek',
  label: 'DeepSeek',
  variables: [
    { name: 'DEEPSEEK_API_KEY', kind: 'secret', required: true, allowEmpty: false, harnesses: ['claude-code'] },
  ],
  detect: { hosts: ['api.deepseek.com'], variables: ['DEEPSEEK_*'], keyPrefixes: [] },
});

const GATEWAY = preset({
  id: CUSTOM_GATEWAY,
  label: 'Custom gateway',
  variables: [
    { name: 'ANTHROPIC_BASE_URL', kind: 'plain', required: true, allowEmpty: false, harnesses: ['claude-code'] },
    {
      name: 'ANTHROPIC_AUTH_TOKEN',
      kind: 'secret',
      secret: 'GATEWAY_API_KEY',
      required: true,
      allowEmpty: false,
      harnesses: ['claude-code'],
    },
  ],
});

const CATALOG = [ZAI, DEEPSEEK, GATEWAY];

describe('prefillFrom', () => {
  it('fills a plain value by variable name, and a secret by its variable or its secret NAME', () => {
    const actual = prefillFrom(ZAI, {
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/paas/v4',
      ZAI_API_KEY: 'the-pasted-key',
    });
    expect(actual.values).toEqual({ ANTHROPIC_BASE_URL: 'https://api.z.ai/api/paas/v4' });
    expect(Object.keys(actual.secrets)).toEqual(['ZAI_API_KEY']);
  });

  it('leaves a variable the preset does not name behind, and takes no empty secret', () => {
    const actual = prefillFrom(GATEWAY, {
      UNRELATED: 'x',
      ANTHROPIC_AUTH_TOKEN: '',
      GATEWAY_API_KEY: '',
    });
    expect(actual.values).toEqual({});
    expect(actual.secrets).toEqual({});
  });
});

describe('detectTable', () => {
  it('keeps only the presets that declare clues, as the table detection reads', () => {
    expect(detectTable(CATALOG)).toEqual([
      { id: 'zai-glm', detect: { hosts: ['api.z.ai'], variables: ['ZAI_API_KEY'], keyPrefixes: [] } },
      { id: 'deepseek', detect: { hosts: ['api.deepseek.com'], variables: ['DEEPSEEK_*'], keyPrefixes: [] } },
    ]);
  });
});

describe('readPaste', () => {
  it('reads the block and recognises the provider from the presets’ clues', () => {
    const actual = readPaste(
      CATALOG,
      'export ANTHROPIC_BASE_URL=https://api.z.ai/api/paas/v4\nexport ZAI_API_KEY=sk-zai-secret',
    );
    expect(actual.detection.preset).toBe('zai-glm');
    expect(Object.keys(actual.values)).toEqual(['ANTHROPIC_BASE_URL', 'ZAI_API_KEY']);
    // The key never reaches the recognition, which is names only.
    expect(JSON.stringify(actual.detection)).not.toContain('sk-zai-secret');
  });

  it('reads a Codex TOML table and finds nothing offered for it: a custom gateway', () => {
    const actual = readPaste(
      CATALOG,
      ['[model_providers.ollama]', 'base_url = "http://localhost:11434/v1"', 'env_key = "OLLAMA_API_KEY"', ''].join(
        '\n',
      ),
    );
    expect(actual.detection.preset).toBeUndefined();
    expect(actual.detection.recognised).toEqual(['model_providers.ollama.base_url', 'model_providers.ollama.env_key']);
  });
});

describe('detectionSentence', () => {
  it('names the provider and its clues, the host as the preset wrote it', () => {
    const { detection } = readPaste(CATALOG, 'export ANTHROPIC_BASE_URL=https://api.z.ai/api/paas/v4\nZAI_API_KEY=k');
    expect(detectionSentence(CATALOG, detection)).toBe(
      'Looks like GLM / Z.ai — from ANTHROPIC_BASE_URL (api.z.ai) · ZAI_API_KEY',
    );
  });

  it('says a custom gateway with what was recognised, or that nothing was', () => {
    const some = readPaste(CATALOG, 'GATEWAY_TOKEN=abc').detection;
    expect(detectionSentence(CATALOG, some)).toBe('Custom gateway — recognised: GATEWAY_TOKEN');
    const none = readPaste(CATALOG, 'JUST_A_SENTENCE').detection;
    expect(detectionSentence(CATALOG, none)).toBe('Custom gateway — no variable recognised');
  });
});

describe('alsoMatchedSentence', () => {
  it('is null without a tie, and names the others in the catalogue’s order with one', () => {
    const alone = readPaste(CATALOG, 'export ANTHROPIC_BASE_URL=https://api.z.ai/api/paas/v4').detection;
    expect(alsoMatchedSentence(CATALOG, alone)).toBeNull();
    // DEEPSEEK_API_KEY is a variable clue for deepseek and a KEY name; nothing else scores, so no tie
    // is possible against this table — assert the sentence shape on a hand-made tie instead.
    const tie = {
      preset: 'zai-glm',
      clues: [{ kind: 'variable' as const, variable: 'ZAI_API_KEY' }],
      alsoMatched: ['deepseek'],
      recognised: ['ZAI_API_KEY'],
      harnesses: ['claude' as const],
    };
    expect(alsoMatchedSentence(CATALOG, tie)).toBe('or: DeepSeek');
  });
});

describe('pasteTarget', () => {
  it('continues to the preset recognised when it is offered here', () => {
    const { detection } = readPaste(CATALOG, 'export ANTHROPIC_BASE_URL=https://api.z.ai/api/paas/v4');
    expect(pasteTarget(CATALOG, detection)?.id).toBe('zai-glm');
  });

  it('falls back to the custom gateway when the recognised preset is not offered here', () => {
    const refused = preset({ ...ZAI, id: 'zai-glm', offered: { available: false, reason: 'not here' } });
    const { detection } = readPaste([refused, GATEWAY], 'export ANTHROPIC_BASE_URL=https://api.z.ai/api/paas/v4');
    expect(detection.preset).toBe('zai-glm');
    expect(pasteTarget([refused, GATEWAY], detection)?.id).toBe(CUSTOM_GATEWAY);
  });

  it('offers nothing to continue to when no preset is offered', () => {
    const { detection } = readPaste([], 'A=1');
    expect(pasteTarget([], detection)).toBeUndefined();
  });
});
