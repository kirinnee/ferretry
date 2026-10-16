import { describe, expect, it } from 'bun:test';
import {
  alsoMatchedSentence,
  blankRequiredValues,
  CUSTOM_GATEWAY,
  detectionSentence,
  detectTable,
  gridPresets,
  oneClickDraft,
  pasteTarget,
  prefillFrom,
  readPaste,
  secretFields,
} from '../../../../../src/features/fleet/credentials/provider-model.ts';
import { CREDENTIALS, credential } from '../account-support.ts';
import { AZURE, DEEPSEEK, DEEPSEEK_MIRROR, GATEWAY, PROVIDERS, ZAI, ZAI_CODEX } from './environment-support.ts';

const PRESETS = PROVIDERS.presets;

describe('provider-model', () => {
  it('keeps the daemon’s order and moves the custom gateway to the end', () => {
    expect(CUSTOM_GATEWAY).toBe('custom-gateway');
    expect(gridPresets(PRESETS).map(preset => preset.id)).toEqual([
      'deepseek',
      'zai-glm',
      'zai-glm-codex',
      'azure-openai',
      'deepseek-mirror',
      'amazon-bedrock',
      'custom-gateway',
    ]);
  });

  it('asks for each secret NAME once, with the variables it fills, and for blank required values', () => {
    expect(secretFields(DEEPSEEK)).toEqual([
      { secret: 'DEEPSEEK_API_KEY', variables: ['ANTHROPIC_AUTH_TOKEN', 'DEEPSEEK_API_KEY'], required: true },
    ]);
    expect(secretFields(ZAI)).toEqual([
      { secret: 'ZAI_API_KEY', variables: ['ANTHROPIC_AUTH_TOKEN'], required: true },
      { secret: 'EXTRA_KEY', variables: ['EXTRA_TOKEN'], required: false },
    ]);
    const unnamed = {
      ...ZAI,
      variables: [{ name: 'RAW_KEY', kind: 'secret' as const, required: false, allowEmpty: false }],
    };
    expect(secretFields(unnamed)).toEqual([{ secret: 'RAW_KEY', variables: ['RAW_KEY'], required: false }]);
    expect(blankRequiredValues(AZURE)).toEqual(['AZURE_OPENAI_RESOURCE']);
    expect(blankRequiredValues(GATEWAY)).toEqual(['ANTHROPIC_BASE_URL']);
    // ANTHROPIC_API_KEY is empty on purpose; API_TIMEOUT_MS is optional.
    expect(blankRequiredValues(ZAI)).toEqual([]);
  });

  it('maps a paste onto a preset by name: plain values, and secrets by variable or by secret name', () => {
    expect(
      prefillFrom(DEEPSEEK, {
        ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'claude-half-key',
        DEEPSEEK_API_KEY: 'codex-half-key',
        UNRELATED: 'x',
      }),
    ).toEqual({
      values: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic' },
      secrets: { DEEPSEEK_API_KEY: 'claude-half-key' },
    });
    expect(prefillFrom(ZAI, { ZAI_API_KEY: 'by-secret-name', EXTRA_TOKEN: '' })).toEqual({
      values: {},
      secrets: { ZAI_API_KEY: 'by-secret-name' },
    });
    const unnamed = {
      ...ZAI,
      variables: [{ name: 'RAW_KEY', kind: 'secret' as const, required: true, allowEmpty: false }],
    };
    expect(prefillFrom(unnamed, { RAW_KEY: 'raw' }).secrets).toEqual({ RAW_KEY: 'raw' });
  });

  it('starts the minimal form from the preset with a paste’s values over it, named past taken ids', () => {
    const list = { ...CREDENTIALS, credentials: [credential({ id: 'custom-gateway' })] };
    const draft = oneClickDraft(GATEWAY, list, {
      values: { ANTHROPIC_BASE_URL: 'https://gw.example.test' },
      secrets: {},
    });
    expect(draft.name).toBe('custom-gateway-2');
    expect(draft.values).toEqual({ ANTHROPIC_BASE_URL: 'https://gw.example.test', ANTHROPIC_MODEL: '' });
    expect(oneClickDraft(GATEWAY, null).values).toEqual({ ANTHROPIC_BASE_URL: '', ANTHROPIC_MODEL: '' });
  });

  it('builds the detection table from the presets that declare clues', () => {
    expect(detectTable(PRESETS).map(row => row.id)).toEqual(['deepseek', 'azure-openai', 'deepseek-mirror']);
  });

  it('reads a paste and words what it found by NAMES, never a value', () => {
    const reading = readPaste(
      PRESETS,
      'export ANTHROPIC_BASE_URL=https://user:pw@api.deepseek.com/anthropic\nexport DEEPSEEK_API_KEY=sk-the-key-value',
    );
    expect(reading.values.DEEPSEEK_API_KEY).toBe('sk-the-key-value');
    expect(reading.detection.preset).toBe('deepseek');
    const sentence = detectionSentence(PRESETS, reading.detection);
    expect(sentence).toBe('Looks like DeepSeek — from ANTHROPIC_BASE_URL (api.deepseek.com) · DEEPSEEK_API_KEY');
    expect(sentence).not.toContain('sk-the-key-value');
    expect(sentence).not.toContain('pw@');
    expect(alsoMatchedSentence(PRESETS, reading.detection)).toBeNull();
    expect(pasteTarget(PRESETS, reading.detection)?.id).toBe('deepseek');
  });

  it('says which others matched as well, and a label it does not know by its id', () => {
    const tie = readPaste(PRESETS, 'ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic');
    expect(tie.detection.alsoMatched).toEqual(['deepseek-mirror']);
    expect(alsoMatchedSentence(PRESETS, tie.detection)).toBe('or: DeepSeek mirror');
    expect(detectionSentence([], tie.detection)).toBe(
      'Looks like deepseek — from ANTHROPIC_BASE_URL (api.deepseek.com)',
    );
  });

  it('falls back to the custom gateway, with what was recognised, when nothing matched', () => {
    const unknown = readPaste(PRESETS, 'ANTHROPIC_BASE_URL: https://gw.example.test\nANTHROPIC_AUTH_TOKEN: k\nFOO=bar');
    expect(detectionSentence(PRESETS, unknown.detection)).toBe(
      'Custom gateway — recognised: ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN',
    );
    expect(pasteTarget(PRESETS, unknown.detection)?.id).toBe('custom-gateway');
    expect(detectionSentence(PRESETS, readPaste(PRESETS, 'FOO=bar').detection)).toBe(
      'Custom gateway — no variable recognised',
    );
    expect(pasteTarget([ZAI_CODEX], unknown.detection)).toBeUndefined();
  });

  it('continues as the gateway when the recognised provider is not offered here', () => {
    const mirrorOnly = readPaste([DEEPSEEK_MIRROR, GATEWAY], 'ANTHROPIC_BASE_URL=https://api.deepseek.com');
    expect(
      pasteTarget([{ ...DEEPSEEK_MIRROR, offered: { available: false, reason: 'no' } }, GATEWAY], mirrorOnly.detection)
        ?.id,
    ).toBe('custom-gateway');
  });
});
