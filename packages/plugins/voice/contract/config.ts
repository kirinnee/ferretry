import { defineConfig } from '@ferretry/kernel/contract';
import { NonEmptyStringSchema } from '@ferretry/std';
import { z } from 'zod';

/**
 * `config/voice.yaml` (§9.2): how a dictated take is post-processed, and which speech engine a paired device uses until
 * it picks its own. NO KEY LIVES HERE. A provider's key is a Vault secret by name (`GROQ_API_KEY`, `CEREBRAS_API_KEY`),
 * spent only through the Vault's outbound holder; this file only ever names a provider. Today's `voice` section of
 * `config.yaml`, copied field for field.
 *
 * Who cleans up a dictated transcript: transcription itself is chosen on each device (Parakeet in the browser, or the
 * browser's own speech service) and is not configured here. Only the transcript TEXT reaches the post-processor chosen
 * here, never audio, and only when the owner dictates.
 */

export const VOICE_POST_PROCESSORS = ['off', 'groq', 'cerebras', 'login'] as const;
export const VoicePostProcessorSchema = z.enum(VOICE_POST_PROCESSORS);
export type VoicePostProcessor = z.infer<typeof VoicePostProcessorSchema>;

/** The speech engines a device can use: Parakeet in the browser, or the browser's/phone's own recognition. */
export const VOICE_ENGINES = ['parakeet', 'browser'] as const;
export const VoiceEngineSchema = z.enum(VOICE_ENGINES);
export type VoiceEngine = z.infer<typeof VoiceEngineSchema>;

/** What cleanup does: nothing, only fix transcription mistakes, or rewrite into clear sentences. */
export const VOICE_CLEANUP_STYLES = ['off', 'fix', 'polish'] as const;
export const VoiceCleanupStyleSchema = z.enum(VOICE_CLEANUP_STYLES);
export type VoiceCleanupStyle = z.infer<typeof VoiceCleanupStyleSchema>;

export const MAX_VOICE_PROMPT_CHARS = 2_000;

/** The prompts a person may rewrite. The daemon's fixed guard wraps whichever one runs and cannot be removed. */
export const VoiceCleanupPromptsSchema = z.strictObject({
  fix: z.string().trim().min(1).max(MAX_VOICE_PROMPT_CHARS).optional(),
  polish: z.string().trim().min(1).max(MAX_VOICE_PROMPT_CHARS).optional(),
});
export type VoiceCleanupPrompts = z.infer<typeof VoiceCleanupPromptsSchema>;

/** The shipped wording of each prompt; "Reset to default" in Settings writes nothing and falls back to these. */
export const DEFAULT_VOICE_CLEANUP_PROMPTS: Readonly<Record<Exclude<VoiceCleanupStyle, 'off'>, string>> = {
  fix: 'Fix transcription errors in the dictated text: misheard or misspelled words, punctuation and capitalization. Keep the speaker\u2019s own wording, order and meaning; do not rephrase.',
  polish:
    'Rewrite the dictated text into clear, well-formed sentences with correct spelling, punctuation and capitalization. Keep the same meaning and every fact; do not add, answer or explain anything.',
};

export const VoiceConfigSchema = z.strictObject({
  /**
   * The speech engine a device paired to this machine uses until that device picks its own (New machine
   * setup's Voice step writes it). Transcription always runs ON the device; this only names the default.
   */
  defaultEngine: VoiceEngineSchema.optional(),
  postProcessing: z
    .strictObject({
      provider: VoicePostProcessorSchema.default('off'),
      /** `provider: login` only: the login (credential id) whose model cleans up the text. */
      login: NonEmptyStringSchema.optional(),
      /** The model the provider runs; the provider's own default when unset. */
      model: NonEmptyStringSchema.optional(),
      /** What cleanup does to a take: nothing, fix mistakes only, or polish into clear sentences. */
      style: VoiceCleanupStyleSchema.default('fix'),
      /** Your own wording of a style's prompt; the shipped default when a style is not listed. */
      prompts: VoiceCleanupPromptsSchema.prefault({}),
      /** Send the last few messages of the session as read-only reference so names and terms are spelled right. */
      useConversation: z.boolean().default(false),
      /** How many of the latest messages that reference holds. */
      conversationMessages: z.number().int().min(1).max(10).default(8),
    })
    .check(ctx => {
      const value = ctx.value;
      if (value.provider === 'login' && value.login === undefined) {
        ctx.issues.push({
          code: 'custom',
          message: 'provider: login needs "login" — the login whose model cleans up the text',
          input: value,
          path: ['login'],
        });
      }
      if (value.provider !== 'login' && value.login !== undefined) {
        ctx.issues.push({
          code: 'custom',
          message: `"login" is only read with provider: login — this one is provider: ${value.provider}`,
          input: value.login,
          path: ['login'],
        });
      }
    })
    .prefault({}),
});
export type VoiceConfig = z.infer<typeof VoiceConfigSchema>;

/** The voice settings a state home with no `voice.yaml` behaves as: no post-processing. */
export const DEFAULT_VOICE_CONFIG: VoiceConfig = VoiceConfigSchema.parse({});

/**
 * Which edits of `voice.yaml` LOOSEN where the owner's words go (docs/config-files.md rule 2, today's `voiceLoosening`,
 * copied rule for rule): a loosening edit is HELD for the owner and the tighter version stays in effect. Dictated text
 * newly sent to a cleanup provider, or to a different one (another provider, another login), spends and sends the
 * owner's words somewhere new; so does letting recent conversation messages ride along. Turning cleanup off, a model,
 * a prompt and fewer conversation messages never loosen.
 */
export function voiceLoosens(before: VoiceConfig | undefined, after: VoiceConfig | undefined): readonly string[] {
  const from = (before ?? DEFAULT_VOICE_CONFIG).postProcessing;
  const to = (after ?? DEFAULT_VOICE_CONFIG).postProcessing;
  const destination = to.provider === 'login' ? `the login ${to.login ?? ''}`.trim() : to.provider;
  const sends = to.provider !== 'off' && to.style !== 'off';
  const wasSending = from.provider !== 'off' && from.style !== 'off';
  const moved = sends && (!wasSending || from.provider !== to.provider || from.login !== to.login);
  const context = to.useConversation && !from.useConversation && to.style !== 'off';
  return [
    ...(moved ? [`dictated text now goes to ${destination} to be cleaned up`] : []),
    ...(context ? ['recent conversation messages may now go to the cleanup provider to help clean up dictation'] : []),
  ];
}

/** `config/voice.yaml`. Writes go through Gate's config route; an edit that loosens ({@link voiceLoosens}) is held. */
export const VOICE_CONFIG = defineConfig({
  file: 'voice.yaml',
  schema: VoiceConfigSchema,
  axis: 'configure',
  loosens: voiceLoosens,
});
