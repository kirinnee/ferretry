import { z } from 'zod';
import { NonNegativeFiniteSchema } from '@ferretry/std';
import type { ReplyVoiceView } from './reply-voice.ts';

/**
 * ElevenLabs as the reply voice (unit 10): an optional second voice for a ferret's `<voice>` lines, used only when the
 * owner picks it in Settings and has set `ELEVENLABS_API_KEY` (Speed-ups). The default stays Kokoro on the machine.
 *
 * THE KEY NEVER LEAVES THE VAULT'S OUTBOUND HOLDER, and the holder returns only JSON (docs/secrets.md; owner decision O4:
 * no widening for raw audio). So a line is made through the `with-timestamps` endpoint, which answers JSON with the audio
 * as base64, asked for as 16 kHz PCM so it is already the stream's own sample rate.
 *
 * WHAT LEAVES THIS MACHINE: the text of each `<voice>` line, to ElevenLabs, and nothing else; a spend per character, so a
 * daily character cap stands in front of it.
 */

/** The Vault secret ElevenLabs is spent through, by NAME. Create shares it (one key, one account). */
export const ELEVENLABS_SECRET_NAME = 'ELEVENLABS_API_KEY';
/** The one host that key may reach (the manifest's `permissions.network` names it too). */
export const ELEVENLABS_HOST = 'api.elevenlabs.io';
/** ElevenLabs' fast, cheap model (Create uses the same): about half the latency of the multilingual one. */
export const ELEVENLABS_DEFAULT_MODEL = 'eleven_flash_v2_5';
/** The stream's own rate: asked for as `pcm_16000`, so there is nothing to resample or decode. */
export const ELEVENLABS_OUTPUT_FORMAT = 'pcm_16000';

/** Characters of speech one machine-day may send to ElevenLabs. 20 000 is about 20 minutes (**guess**, ~$0.7). */
export const ELEVENLABS_DEFAULT_DAILY_CHARS = 20_000;
export const ELEVENLABS_MAX_DAILY_CHARS = 200_000;

/** A voice id as ElevenLabs writes it (20 letters and digits). Checked before it is put in a URL path. */
export const ElevenLabsVoiceIdSchema = z.string().regex(/^[A-Za-z0-9]{8,40}$/u, 'an ElevenLabs voice id');

/** Where the reply voice comes from. `kokoro` is on this machine and free; `elevenlabs` is the owner's own account. */
export const REPLY_PROVIDERS = ['kokoro', 'elevenlabs'] as const;
export const ReplyProviderSchema = z.enum(REPLY_PROVIDERS);
export type ReplyProvider = z.infer<typeof ReplyProviderSchema>;

/** One voice the account can use. The name and the id are all the picker shows. */
export const ElevenLabsVoiceSchema = z.strictObject({
  id: ElevenLabsVoiceIdSchema,
  name: z.string().min(1).max(100),
  /** `premade`, `cloned`, `professional`...: what kind of voice it is, when ElevenLabs says. */
  category: z.string().min(1).max(40).optional(),
});
export type ElevenLabsVoice = z.infer<typeof ElevenLabsVoiceSchema>;

/** Why a read of the account failed, as a code a screen can say the next step for and one fixed sentence. */
export const ElevenLabsFailureSchema = z.strictObject({
  code: z.enum(['not_set', 'rejected', 'rate_limited', 'unavailable', 'vault_damaged']),
  sentence: z.string().min(1).max(400),
});
export type ElevenLabsFailure = z.infer<typeof ElevenLabsFailureSchema>;

/** What is spent today: the owner reads this before raising the cap. Counts only, never a word that was spoken. */
export const ElevenLabsUsageSchema = z.strictObject({
  /** The machine's own calendar day, `YYYY-MM-DD`. */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  usedChars: NonNegativeFiniteSchema,
  dailyChars: z.number().int().positive(),
});
export type ElevenLabsUsage = z.infer<typeof ElevenLabsUsageSchema>;

/** `GET /v1/voice/reply-voice/elevenlabs`: free, opens no key. */
export const ElevenLabsStatusSchema = z.strictObject({
  usage: ElevenLabsUsageSchema,
  /** Whether `ELEVENLABS_API_KEY` is in the secret store (a name lookup). */
  keySet: z.boolean(),
  /** The voice the owner chose and the model it speaks with. */
  voiceId: ElevenLabsVoiceIdSchema.optional(),
  model: z.string().min(1).max(64),
});
export type ElevenLabsStatus = z.infer<typeof ElevenLabsStatusSchema>;

/** `GET /v1/voice/reply-voice/elevenlabs/voices`: the account's voices (one key use, nothing spoken, nothing billed). */
export const ElevenLabsVoicesSchema = z.strictObject({
  voices: z.array(ElevenLabsVoiceSchema).max(100),
  failure: ElevenLabsFailureSchema.optional(),
});
export type ElevenLabsVoices = z.infer<typeof ElevenLabsVoicesSchema>;

export const ELEVENLABS_PATH = '/v1/voice/reply-voice/elevenlabs';

/** What the stream needs of any reply voice: whether it can speak now, to be warmed, and to speak. Kokoro and ElevenLabs both are one. */
export interface ReplySpeakerApi {
  /** Only the state is read: `ready` means a line can be spoken now, `absent` that it cannot, so the device reads it. */
  view(): Promise<{ readonly state: ReplyVoiceView['state'] | 'absent' }>;
  warm(): Promise<void>;
  speak(text: string): Promise<{ readonly samples: Float32Array; readonly speakMs: number }>;
}
