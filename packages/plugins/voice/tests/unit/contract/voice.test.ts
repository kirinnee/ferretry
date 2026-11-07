import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_VOICE_CLEANUP_PROMPTS,
  SpeedupProviderSchema,
  SpeedupsViewSchema,
  VoiceConfigSchema,
} from '../../../contract/index.ts';
import { fakeVoice, voiceConformance } from '../../../contract/testing/index.ts';

voiceConformance('fakeVoice', keys => fakeVoice({ keys }));

describe('voice.yaml', () => {
  test('an empty file means no post-processing, fix style, no conversation', () => {
    expect(VoiceConfigSchema.parse({}).postProcessing).toMatchObject({
      provider: 'off',
      style: 'fix',
      useConversation: false,
      conversationMessages: 8,
    });
  });

  test('provider: login needs a login, and a login is only read with provider: login', () => {
    expect(VoiceConfigSchema.safeParse({ postProcessing: { provider: 'login' } }).success).toBe(false);
    expect(VoiceConfigSchema.safeParse({ postProcessing: { provider: 'login', login: 'work' } }).success).toBe(true);
    expect(VoiceConfigSchema.safeParse({ postProcessing: { provider: 'groq', login: 'work' } }).success).toBe(false);
  });

  test('holds no key: a key-shaped field is refused', () => {
    expect(VoiceConfigSchema.safeParse({ postProcessing: { provider: 'groq', apiKey: 'gsk_x' } }).success).toBe(false);
    expect(DEFAULT_VOICE_CLEANUP_PROMPTS.fix.length).toBeGreaterThan(0);
  });
});

describe('the speed-up wire', () => {
  test('the providers are a closed set', () => {
    expect(SpeedupProviderSchema.options).toEqual(['jev', 'groq', 'cerebras']);
  });

  test('a view carries no field a value could ride in', async () => {
    const view = await fakeVoice({ keys: ['GROQ_API_KEY'] }).speedups();
    expect(SpeedupsViewSchema.safeParse(view).success).toBe(true);
    expect(SpeedupsViewSchema.safeParse({ ...view, providers: [{ ...view.providers[0], value: 'x' }] }).success).toBe(
      false,
    );
  });
});
