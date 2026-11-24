import type { SecretName } from '@ferretry/core-vault/contract';
import { z } from 'zod';
import {
  ELEVENLABS_HOST,
  ELEVENLABS_OUTPUT_FORMAT,
  ELEVENLABS_SECRET_NAME,
  type ElevenLabsFailure,
  type ElevenLabsStatus,
  type ElevenLabsUsage,
  type ElevenLabsVoice,
  ElevenLabsVoiceSchema,
  type ElevenLabsVoices,
  type ReplyVoiceConfig,
  type ReplySpeakerApi,
  STREAM_SAMPLE_RATE,
} from '../../../contract/index.ts';
import type { OutboundAuthorizerPort } from '../stt/ports.ts';
import type { AuthorizedOutcome } from '@ferretry/core-vault/contract';
import type { SecretNameSource } from '../speedups/ports.ts';

/**
 * ElevenLabs as the reply voice. One line of speech is ONE call to the JSON `with-timestamps` endpoint through the Vault's
 * outbound holder (the key is placed by the holder, as `xi-api-key`, and this file never holds it). The holder answers only
 * parsed JSON, so raw audio is not on offer (owner decision O4): the audio comes back as base64 inside the JSON, asked for as
 * 16 kHz PCM so it is already the stream's rate and needs no decoder.
 *
 * https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps
 *
 * SPEND. ElevenLabs bills per character, so characters are counted BEFORE the call (a day's total is held across restarts)
 * and given back only when the call definitely billed nothing (the request never left, or a 4xx refused it). A call past
 * the day's cap is refused here, and the stream then lets the device's own voice read that line.
 */

const TIMEOUT_MS = 20_000;
/** The Vault's own ceiling for a JSON reply. A line of at most 280 characters is far under it (PCM is 32 KB a second). */
const MAX_REPLY_BYTES = 4 * 1024 * 1024;
const VOICES_TIMEOUT_MS = 10_000;
const VOICES_MAX_BYTES = 1024 * 1024;
const PLACEMENT = { header: 'xi-api-key' } as const;
const SECRET: SecretName = ELEVENLABS_SECRET_NAME;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;

/** A line that was not spoken, and why: a code for the log and a sentence. Never the text and never a provider body. */
export class ElevenLabsSpeechError extends Error {
  constructor(
    readonly code: 'not_ready' | 'cap' | ElevenLabsFailure['code'] | 'malformed',
    message: string,
  ) {
    super(message);
    this.name = 'ElevenLabsSpeechError';
  }
}

/** Characters sent today, kept across restarts. A new day starts again from zero. */
export interface SpendPort {
  read(): Promise<{ readonly day: string; readonly chars: number } | undefined>;
  write(record: { readonly day: string; readonly chars: number }): Promise<void>;
}

export interface ElevenLabsParts {
  readonly authorizer: OutboundAuthorizerPort;
  readonly secrets: SecretNameSource;
  readonly spend: SpendPort;
  /** `replyVoice` of `voice.yaml`, read at each call so an edit takes effect at once. */
  readonly settings: () => ReplyVoiceConfig;
  /** The machine's own calendar day, `YYYY-MM-DD`. */
  readonly today: () => string;
  readonly monotonicMs: () => number;
  readonly log: { info(message: string, fields?: Record<string, string | number | boolean>): void };
}

const SENTENCES: Readonly<Record<ElevenLabsFailure['code'], string>> = {
  not_set: 'No ElevenLabs key is set. Add one in Settings › Speed-ups.',
  rejected: 'ElevenLabs refused the key. Check it was copied whole, and that the account has credit.',
  rate_limited: 'ElevenLabs says too many requests. Try again in a minute.',
  unavailable: 'ElevenLabs could not be reached, or answered something unexpected.',
  vault_damaged: 'This machine’s secret store cannot be read, so the ElevenLabs key could not be used.',
};

/** What an outcome that is not an answer means, and whether the provider definitely billed nothing for it. */
function failureOf(outcome: AuthorizedOutcome): {
  readonly code: ElevenLabsFailure['code'];
  readonly noCharge: boolean;
} {
  switch (outcome.kind) {
    case 'secret_missing':
      return { code: 'not_set', noCharge: true };
    case 'vault_damaged':
      return { code: 'vault_damaged', noCharge: true };
    case 'refused':
      return { code: 'unavailable', noCharge: true };
    case 'status':
      if (outcome.status === 401 || outcome.status === 403) return { code: 'rejected', noCharge: true };
      if (outcome.status === 429) return { code: 'rate_limited', noCharge: true };
      return { code: 'unavailable', noCharge: outcome.status >= 400 && outcome.status < 500 };
    // A timeout, a dropped connection, an answer too large or unreadable may have been billed.
    case 'timeout':
    case 'unreachable':
    case 'oversized':
    case 'unreadable':
    case 'completion':
      return { code: 'unavailable', noCharge: false };
  }
}

const SpeechReplySchema = z.object({ audio_base64: z.string().min(1) });
const VoicesReplySchema = z.object({
  voices: z.array(z.object({ voice_id: z.string(), name: z.string(), category: z.string().nullish() }).passthrough()),
});

/** PCM16 little endian as samples in [-1, 1]; `undefined` for a length that is not whole samples. */
export function pcm16Samples(bytes: Uint8Array): Float32Array | undefined {
  if (bytes.byteLength === 0 || bytes.byteLength % 2 !== 0) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(bytes.byteLength / 2);
  for (let index = 0; index < samples.length; index += 1) samples[index] = view.getInt16(index * 2, true) / 32768;
  return samples;
}

export class ElevenLabsReplyVoice implements ReplySpeakerApi {
  /** Spoken lines wait for each other here, so two never read the day's count at once and both pass the cap. */
  private turn: Promise<unknown> = Promise.resolve();

  constructor(private readonly parts: ElevenLabsParts) {}

  /** Whether a line can be spoken now: a key is in the store and a voice was chosen. A name lookup; the key is never opened. */
  async ready(): Promise<boolean> {
    return this.parts.settings().elevenlabs.voiceId !== undefined && (await this.keySet());
  }

  async view(): Promise<{ readonly state: 'ready' | 'absent' }> {
    return { state: (await this.ready()) ? 'ready' : 'absent' };
  }

  /** Nothing to load: the voice is a service. */
  async warm(): Promise<void> {
    if (!(await this.ready())) throw new ElevenLabsSpeechError('not_ready', 'ElevenLabs is not set up');
  }

  async status(): Promise<ElevenLabsStatus> {
    const config = this.parts.settings().elevenlabs;
    return {
      usage: await this.usage(),
      keySet: await this.keySet(),
      ...(config.voiceId === undefined ? {} : { voiceId: config.voiceId }),
      model: config.model,
    };
  }

  async usage(): Promise<ElevenLabsUsage> {
    const day = this.parts.today();
    const kept = await this.parts.spend.read();
    return {
      day,
      usedChars: kept?.day === day ? Math.max(0, kept.chars) : 0,
      dailyChars: this.parts.settings().elevenlabs.dailyChars,
    };
  }

  /** The account's voices: one read of the key, nothing spoken and nothing billed. */
  async voices(): Promise<ElevenLabsVoices> {
    const outcome = await this.parts.authorizer.send(
      SECRET,
      [ELEVENLABS_HOST],
      {
        method: 'GET',
        url: `https://${ELEVENLABS_HOST}/v2/voices?page_size=100&sort=name&sort_direction=asc`,
        headers: { accept: 'application/json' },
        timeoutMs: VOICES_TIMEOUT_MS,
        maxResponseBytes: VOICES_MAX_BYTES,
      },
      PLACEMENT,
    );
    if (outcome.kind !== 'completion') {
      const { code } = failureOf(outcome);
      return { voices: [], failure: { code, sentence: SENTENCES[code] } };
    }
    const parsed = VoicesReplySchema.safeParse(outcome.payload);
    if (!parsed.success) return { voices: [], failure: { code: 'unavailable', sentence: SENTENCES.unavailable } };
    const voices: ElevenLabsVoice[] = [];
    for (const row of parsed.data.voices) {
      const voice = ElevenLabsVoiceSchema.safeParse({
        id: row.voice_id,
        name: row.name.trim().slice(0, 100),
        ...(typeof row.category === 'string' && row.category !== '' ? { category: row.category.slice(0, 40) } : {}),
      });
      // A row whose id is not a plain id is left out rather than put in a URL later.
      if (voice.success) voices.push(voice.data);
    }
    return { voices: voices.slice(0, 100) };
  }

  /** One short piece of text as sound at 16 kHz. Pieces are made one at a time, in the order they were asked for. */
  async speak(text: string): Promise<{ readonly samples: Float32Array; readonly speakMs: number }> {
    const run = this.turn.then(async () => await this.speakNow(text));
    this.turn = run.catch(() => undefined);
    return await run;
  }

  private async speakNow(text: string): Promise<{ readonly samples: Float32Array; readonly speakMs: number }> {
    const config = this.parts.settings().elevenlabs;
    if (config.voiceId === undefined) throw new ElevenLabsSpeechError('not_ready', 'no ElevenLabs voice is chosen');
    const day = this.parts.today();
    const kept = await this.parts.spend.read();
    const before = kept?.day === day ? Math.max(0, kept.chars) : 0;
    const length = [...text].length;
    if (before + length > config.dailyChars)
      throw new ElevenLabsSpeechError(
        'cap',
        `the day's ElevenLabs limit of ${config.dailyChars} characters is reached`,
      );
    // Counted before the call: money that may be spent is money recorded.
    await this.parts.spend.write({ day, chars: before + length });
    const began = this.parts.monotonicMs();
    const outcome = await this.parts.authorizer.send(
      SECRET,
      [ELEVENLABS_HOST],
      {
        method: 'POST',
        url: `https://${ELEVENLABS_HOST}/v1/text-to-speech/${encodeURIComponent(config.voiceId)}/with-timestamps?output_format=${ELEVENLABS_OUTPUT_FORMAT}`,
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ text, model_id: config.model }),
        timeoutMs: TIMEOUT_MS,
        maxResponseBytes: MAX_REPLY_BYTES,
      },
      PLACEMENT,
    );
    if (outcome.kind !== 'completion') {
      const failure = failureOf(outcome);
      if (failure.noCharge) await this.parts.spend.write({ day, chars: before });
      this.parts.log.info('voice.reply.elevenlabs.failed', { code: failure.code, chars: length });
      throw new ElevenLabsSpeechError(failure.code, SENTENCES[failure.code]);
    }
    const parsed = SpeechReplySchema.safeParse(outcome.payload);
    const audio =
      parsed.success && BASE64.test(parsed.data.audio_base64)
        ? Buffer.from(parsed.data.audio_base64, 'base64')
        : undefined;
    const samples = audio === undefined ? undefined : pcm16Samples(new Uint8Array(audio));
    if (samples === undefined) {
      this.parts.log.info('voice.reply.elevenlabs.failed', { code: 'malformed', chars: length });
      throw new ElevenLabsSpeechError('malformed', 'ElevenLabs answered with no usable audio');
    }
    const speakMs = Math.max(0, this.parts.monotonicMs() - began);
    // Counts and milliseconds only: what was said never reaches a log.
    this.parts.log.info('voice.reply.elevenlabs.spoke', {
      chars: length,
      speakMs: Math.round(speakMs),
      audioMs: Math.round((samples.length / STREAM_SAMPLE_RATE) * 1000),
    });
    return { samples, speakMs };
  }

  private async keySet(): Promise<boolean> {
    try {
      return (await this.parts.secrets.list()).some(entry => entry.name === SECRET);
    } catch {
      return false;
    }
  }
}
