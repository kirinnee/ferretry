/** @ferretry/plugin-voice/contract/testing — the contract's fake and conformance suite (§7.8). */
import { describe, expect, test } from 'bun:test';
import { SttEnhancementError } from '../errors.ts';
import { VoiceConfigSchema } from '../config.ts';
import type { VoiceApi } from '../port.ts';
import type { SpeedupProvider, SpeedupTestResult } from '../speedups.ts';
import { SttEnhancementRequestSchema } from '../stt.ts';

const PROVIDERS = [
  { provider: 'jev', label: 'Jev', secretName: 'JEV_API_KEY' },
  { provider: 'groq', label: 'Groq', secretName: 'GROQ_API_KEY' },
  { provider: 'cerebras', label: 'Cerebras', secretName: 'CEREBRAS_API_KEY' },
] as const;

/** In-memory `VoiceApi`: keys set by name, a Test that proves a set key, an enhancer that keeps the words as spoken. */
export function fakeVoice(options: { readonly keys?: readonly string[] } = {}): VoiceApi {
  const keys = new Set(options.keys ?? []);
  const tested = new Map<SpeedupProvider, SpeedupTestResult>();
  const at = '2026-11-07T12:00:00.000Z' as SpeedupTestResult['at'];
  return {
    enhance: async input => {
      const parsed = SttEnhancementRequestSchema.safeParse(input);
      if (!parsed.success) throw new SttEnhancementError('bad_request', 'enhancement request is not valid');
      const key = PROVIDERS.find(entry => entry.provider === parsed.data.provider)?.secretName;
      if (key === undefined || !keys.has(key))
        throw new SttEnhancementError('secret_missing', 'enhancement provider is not configured');
      return { text: parsed.data.text, provider: parsed.data.provider, model: parsed.data.model ?? 'fake', latencyMs: 0 };
    },
    speedups: async () => ({
      providers: PROVIDERS.map(entry => ({
        provider: entry.provider,
        label: entry.label,
        purpose: `${entry.label} speeds something up.`,
        costNote: 'A fraction of a cent.',
        privacyNote: 'Text only.',
        keyUrl: 'https://example.test/keys',
        testNote: 'Test is free.',
        secretName: entry.secretName,
        set: keys.has(entry.secretName),
        ...(tested.has(entry.provider) ? { lastTest: tested.get(entry.provider) as SpeedupTestResult } : {}),
        testStale: false,
      })),
      vault: 'ok' as const,
    }),
    testSpeedup: async provider => {
      const entry = PROVIDERS.find(candidate => candidate.provider === provider);
      const set = entry !== undefined && keys.has(entry.secretName);
      const result: SpeedupTestResult = {
        provider,
        secretName: (entry?.secretName ?? 'GROQ_API_KEY') as SpeedupTestResult['secretName'],
        ok: set,
        code: set ? 'ok' : 'not_set',
        message: set ? 'The key works.' : 'No key is set. Paste one and save it first.',
        at,
      };
      tested.set(provider, result);
      return result;
    },
    settings: () => VoiceConfigSchema.parse({}),
  };
}

export function voiceConformance(name: string, make: (keys: readonly string[]) => VoiceApi): void {
  describe(`VoiceApi conformance: ${name}`, () => {
    test('a key is reported set by name, never by value', async () => {
      const view = await make(['GROQ_API_KEY']).speedups();
      expect(view.providers.find(entry => entry.provider === 'groq')?.set).toBe(true);
      expect(view.providers.find(entry => entry.provider === 'cerebras')?.set).toBe(false);
      expect(JSON.stringify(view)).not.toContain('gsk');
    });
    test('a Test of a missing key says so and a Test of a set key passes', async () => {
      expect((await make([]).testSpeedup('groq')).code).toBe('not_set');
      expect((await make(['GROQ_API_KEY']).testSpeedup('groq')).code).toBe('ok');
    });
    test('enhancement refuses a provider with no key and an invalid request, with stable codes', async () => {
      const api = make([]);
      await expect(api.enhance({ text: 'hello', provider: 'groq' })).rejects.toMatchObject({ code: 'secret_missing' });
      await expect(api.enhance({ nonsense: true })).rejects.toMatchObject({ code: 'bad_request' });
    });
    test('the default cleanup is off', () => {
      expect(make([]).settings().postProcessing.provider).toBe('off');
    });
  });
}
