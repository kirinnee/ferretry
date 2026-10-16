import { describe, expect, it } from 'bun:test';
import {
  environmentChange,
  environmentDraftProblem,
  firstOffered,
  freeLoginId,
  presetDraft,
  presetOptionLabel,
  presetsOf,
  secretRef,
  testNote,
  testResultLine,
} from '../../../../../src/features/fleet/credentials/environment-model.ts';
import { CREDENTIALS, credential } from '../account-support.ts';
import { BEDROCK, OLLAMA, PRESETS, ZAI, ZAI_CODEX } from './environment-support.ts';

const list = (ids: readonly string[]) => ({ ...CREDENTIALS, credentials: ids.map(id => credential({ id })) });

describe('environment-model', () => {
  it('groups presets by tool and finds the first one that may add a login', () => {
    expect(presetsOf(PRESETS.presets, 'codex').map(p => p.id)).toEqual(['ollama-codex', 'zai-glm-codex']);
    expect(firstOffered(PRESETS.presets)?.id).toBe('zai-glm');
    expect(firstOffered(PRESETS.presets, 'codex')?.id).toBe('ollama-codex');
    expect(firstOffered([ZAI_CODEX])).toBeUndefined();
    expect(presetOptionLabel(ZAI)).toBe('GLM / Z.ai');
    expect(presetOptionLabel(ZAI_CODEX)).toBe('GLM / Z.ai — not offered: Codex needs a model catalogue file.');
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
    expect(environmentDraftProblem(ZAI, draft, new Set())).toBe('Store ZAI_API_KEY first.');
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
