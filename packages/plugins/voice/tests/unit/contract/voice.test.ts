import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_VOICE_CLEANUP_PROMPTS,
  DEFAULT_VOICE_CONFIG,
  SpeedupProviderSchema,
  SpeedupsViewSchema,
  VOICE_CONFIG,
  type VoiceConfig,
  VoiceConfigSchema,
  voiceLoosens,
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

/** Today's `voiceLoosening` cases (`packages/fleet/tests/unit/config-files/kinds.test.ts`), case for case. */
describe('T-0034 voice.yaml loosens where dictated text goes, as today', () => {
  const voiceWith = (postProcessing: Record<string, unknown>): VoiceConfig =>
    VoiceConfigSchema.parse({ postProcessing });

  test.each([
    [{ provider: 'groq' }, 'dictated text now goes to groq to be cleaned up'],
    [{ provider: 'cerebras' }, 'dictated text now goes to cerebras to be cleaned up'],
    [{ provider: 'login', login: 'work' }, 'dictated text now goes to the login work to be cleaned up'],
  ] as const)('T-0034 turning post-processing on as %j is held', (to, expected) => {
    expect(voiceLoosens(DEFAULT_VOICE_CONFIG, voiceWith(to))).toEqual([expected]);
    expect(VOICE_CONFIG.loosens(undefined, voiceWith(to))).toEqual([expected]);
  });

  test('T-0034 sending the text somewhere else is held', () => {
    expect(voiceLoosens(voiceWith({ provider: 'groq' }), voiceWith({ provider: 'cerebras' }))).toEqual([
      'dictated text now goes to cerebras to be cleaned up',
    ]);
  });

  test('T-0034 pointing the login provider at another login is held', () => {
    expect(
      voiceLoosens(voiceWith({ provider: 'login', login: 'work' }), voiceWith({ provider: 'login', login: 'home' })),
    ).toEqual(['dictated text now goes to the login home to be cleaned up']);
  });

  test('T-0034 a login provider that names no login is said without a stray space', () => {
    const bare: VoiceConfig = { postProcessing: { ...DEFAULT_VOICE_CONFIG.postProcessing, provider: 'login' } };
    expect(voiceLoosens(DEFAULT_VOICE_CONFIG, bare)).toEqual(['dictated text now goes to the login to be cleaned up']);
  });

  test('T-0034 sharing the conversation with the provider is held', () => {
    expect(
      voiceLoosens(voiceWith({ provider: 'groq' }), voiceWith({ provider: 'groq', useConversation: true })),
    ).toEqual(['recent conversation messages may now go to the cleanup provider to help clean up dictation']);
  });

  test('T-0034 switching the cleanup style back on from off is held', () => {
    expect(
      voiceLoosens(voiceWith({ provider: 'groq', style: 'off' }), voiceWith({ provider: 'groq', style: 'polish' })),
    ).toEqual(['dictated text now goes to groq to be cleaned up']);
  });

  test('T-0034 both at once are both said', () => {
    expect(
      voiceLoosens(
        undefined,
        voiceWith({ provider: 'login', login: 'owner-claude', style: 'polish', useConversation: true }),
      ),
    ).toEqual([
      'dictated text now goes to the login owner-claude to be cleaned up',
      'recent conversation messages may now go to the cleanup provider to help clean up dictation',
    ]);
  });

  test('T-0034 what only tightens or changes nothing about where the text goes applies at once', () => {
    const groq = voiceWith({ provider: 'groq' });
    expect(voiceLoosens(groq, DEFAULT_VOICE_CONFIG)).toEqual([]);
    expect(voiceLoosens(groq, undefined)).toEqual([]);
    expect(voiceLoosens(groq, voiceWith({ provider: 'groq', model: 'another-model' }))).toEqual([]);
    expect(
      voiceLoosens(
        voiceWith({ provider: 'groq', useConversation: true }),
        voiceWith({ provider: 'groq', useConversation: true, conversationMessages: 3 }),
      ),
    ).toEqual([]);
    expect(voiceLoosens(groq, voiceWith({ provider: 'groq', prompts: { fix: 'Fix only spelling.' } }))).toEqual([]);
    expect(voiceLoosens(undefined, DEFAULT_VOICE_CONFIG)).toEqual([]);
  });
});
