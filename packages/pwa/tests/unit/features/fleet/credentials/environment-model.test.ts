import { describe, expect, it } from 'bun:test';
import {
  environmentChange,
  environmentDraftProblem,
  freeLoginId,
  loginHarness,
  offeredHarnesses,
  presetDraft,
  presetHalves,
  presetScope,
  presetsFor,
  secretRef,
  testNote,
  testResultLine,
} from '../../../../../src/features/fleet/credentials/environment-model.ts';
import { CREDENTIALS, credential } from '../account-support.ts';
import { BEDROCK, DEEPSEEK, DEEPSEEK_MIRROR, OLLAMA, PRESETS, ZAI, ZAI_CODEX } from './environment-support.ts';

const list = (ids: readonly string[]) => ({ ...CREDENTIALS, credentials: ids.map(id => credential({ id })) });

describe('environment-model', () => {
  it('reads a preset’s halves, falling back to its one CLI when the daemon sends none', () => {
    expect(presetHalves(ZAI)).toEqual([{ harness: 'claude', offered: { available: true }, models: [] }]);
    expect(presetHalves(DEEPSEEK).map(half => half.harness)).toEqual(['claude', 'codex']);
    expect(offeredHarnesses(DEEPSEEK)).toEqual(['claude', 'codex']);
    expect(offeredHarnesses(DEEPSEEK_MIRROR)).toEqual(['claude']);
    expect(offeredHarnesses(ZAI_CODEX)).toEqual([]);
    expect(presetScope(DEEPSEEK)).toEqual(['claude', 'codex']);
    expect(presetScope(DEEPSEEK_MIRROR)).toEqual(['claude']);
    expect(presetScope(ZAI_CODEX)).toEqual(['codex']);
    expect(loginHarness(DEEPSEEK)).toBe('claude');
    expect(loginHarness(OLLAMA)).toBe('codex');
    expect(loginHarness(ZAI_CODEX)).toBe('codex');
  });

  it('offers every preset, or — opened for one CLI — the ones with an offered half for it', () => {
    const all = [...PRESETS.presets, DEEPSEEK, DEEPSEEK_MIRROR];
    expect(presetsFor(all)).toBe(all);
    expect(presetsFor(all, 'codex').map(preset => preset.id)).toEqual(['ollama-codex', 'deepseek']);
    expect(presetsFor(all, 'claude').map(preset => preset.id)).toEqual([
      'zai-glm',
      'foundry',
      'amazon-bedrock',
      'deepseek',
      'deepseek-mirror',
    ]);
  });

  it('adds ONE login for a preset with two halves: the first CLI, every half’s variables', () => {
    const draft = presetDraft(DEEPSEEK, null);
    expect(environmentDraftProblem(DEEPSEEK, draft, new Set())).toBe('Paste DEEPSEEK_API_KEY.');
    expect(environmentChange(DEEPSEEK, draft, new Set(['DEEPSEEK_API_KEY']))).toEqual({
      kind: 'credential.add',
      id: 'deepseek',
      harness: 'claude',
      store: 'environment',
      preset: 'deepseek',
      env: {
        ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
        ANTHROPIC_AUTH_TOKEN: secretRef('DEEPSEEK_API_KEY'),
        DEEPSEEK_API_KEY: secretRef('DEEPSEEK_API_KEY'),
      },
    });
  });

  it('names a new login after its preset, past every id the machine has', () => {
    expect(freeLoginId(null, 'zai-glm')).toBe('zai-glm');
    expect(freeLoginId(list(['zai-glm', 'zai-glm-2']), 'zai-glm')).toBe('zai-glm-3');
  });

  it('starts a draft from the preset, and turns it into the change that adds the login', () => {
    const draft = presetDraft(ZAI, null);
    expect(draft).toEqual({
      name: 'zai-glm',
      values: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', API_TIMEOUT_MS: '', ANTHROPIC_API_KEY: '' },
      secrets: { ANTHROPIC_AUTH_TOKEN: 'ZAI_API_KEY', EXTRA_TOKEN: 'EXTRA_KEY' },
      cloudCredential: '',
    });
    expect(environmentDraftProblem(ZAI, draft, new Set())).toBe('Paste ZAI_API_KEY.');
    expect(environmentDraftProblem(ZAI, { ...draft, name: 'Bad Name' }, new Set())).toBe(
      'Name it with lowercase letters, digits and dashes.',
    );
    expect(environmentDraftProblem(ZAI, draft, new Set(['ZAI_API_KEY']))).toBeNull();
    expect(
      environmentDraftProblem(
        ZAI,
        { ...draft, values: { ...draft.values, ANTHROPIC_BASE_URL: ' ' } },
        new Set(['ZAI_API_KEY']),
      ),
    ).toBe('Fill in ANTHROPIC_BASE_URL.');
    expect(environmentChange(ZAI, draft, new Set(['ZAI_API_KEY']))).toEqual({
      kind: 'credential.add',
      id: 'zai-glm',
      harness: 'claude',
      store: 'environment',
      preset: 'zai-glm',
      env: {
        ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
        ANTHROPIC_AUTH_TOKEN: secretRef('ZAI_API_KEY'),
        ANTHROPIC_API_KEY: '',
      },
    });
    expect(
      environmentChange(ZAI, { ...draft, values: { ...draft.values, API_TIMEOUT_MS: ' 5 ' } }, new Set(['EXTRA_KEY']))
        .env,
    ).toEqual({
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      ANTHROPIC_AUTH_TOKEN: secretRef('ZAI_API_KEY'),
      API_TIMEOUT_MS: '5',
      ANTHROPIC_API_KEY: '',
      EXTRA_TOKEN: secretRef('EXTRA_KEY'),
    });
  });

  it('carries a cloud credential reference, and needs one where the preset takes one', () => {
    const draft = presetDraft(BEDROCK, null);
    expect(draft.cloudCredential).toBe('aws-profile:default');
    expect(environmentDraftProblem(BEDROCK, { ...draft, cloudCredential: ' ' }, new Set())).toBe(
      'Fill in the cloud credential reference.',
    );
    expect(environmentChange(BEDROCK, { ...draft, cloudCredential: ' aws-profile:work ' }, new Set())).toEqual({
      kind: 'credential.add',
      id: 'amazon-bedrock',
      harness: 'claude',
      store: 'environment',
      preset: 'amazon-bedrock',
      env: { AWS_REGION: 'us-east-1' },
      cloudCredential: 'aws-profile:work',
    });
    expect(presetDraft(OLLAMA, null).cloudCredential).toBe('');
  });

  it('words the Test before and after it runs', () => {
    expect(testNote({ available: true, spends: 'nothing', note: 'Free.' })).toBe('Free.');
    expect(testNote({ available: false, reason: 'No way.' })).toBe('No way.');
    const result = {
      credentialId: 'x',
      ok: true,
      code: 'ok' as const,
      message: 'fine',
      spent: 'nothing' as const,
      at: '2026-10-16T08:00:00.000Z',
    };
    expect(testResultLine(result)).toBe('Test passed — nothing spent.');
    expect(testResultLine({ ...result, spent: 'one-token' })).toBe('Test passed — one token spent.');
    expect(testResultLine({ ...result, ok: false, code: 'rejected', message: 'The provider refused this key.' })).toBe(
      'The provider refused this key.',
    );
  });
});
