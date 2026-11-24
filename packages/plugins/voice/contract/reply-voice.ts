import { z } from 'zod';
import { NonNegativeFiniteSchema } from '@ferretry/std';
import { VoiceEngineFailureCodeSchema, VoiceEngineStateSchema, VoiceRuntimeSchema } from './engine.ts';

/**
 * The reply voice: the machine speaks a ferret's `<voice>` lines with Kokoro-82M (owner decision O2: the sherpa-onnx
 * WebAssembly runtime first, in a worker thread of its own so listening never waits for speaking). It is installed on
 * its own, apart from the speech-to-text engine: voice mode listens without it, and a machine that lacks it is why a
 * device's own voice reads the reply instead.
 *
 * NOTHING SPOKEN TRAVELS ON THIS WIRE: a state, sizes, one measurement and one fixed sentence. The text to speak reaches
 * the engine only through the voice stream, never through a route.
 */

/** What one measured test line said about this machine's speed. Never stored with any words. */
export const ReplyVoiceSelfTestSchema = z.strictObject({
  loadMs: NonNegativeFiniteSchema,
  /** The milliseconds the test line took to turn into sound. */
  speakMs: NonNegativeFiniteSchema,
  /** How long the sound it made lasts, in milliseconds. */
  audioMs: NonNegativeFiniteSchema,
  /** `speakMs` divided by `audioMs`: below 1 is faster than speaking. */
  realTimeFactor: NonNegativeFiniteSchema,
  /** The runtime's own memory once the voice is loaded, in MiB. */
  memoryMb: NonNegativeFiniteSchema,
});
export type ReplyVoiceSelfTest = z.infer<typeof ReplyVoiceSelfTestSchema>;

export const ReplyVoiceViewSchema = z.strictObject({
  state: VoiceEngineStateSchema,
  /** What this machine is called, for "Install on <machine>". */
  machine: z.string().min(1).max(100),
  /** What it is, in words a person reads. */
  label: z.string().min(1).max(200),
  /** Everything Install downloads, in bytes. */
  sizeBytes: z.number().int().nonnegative(),
  doneBytes: z.number().int().nonnegative(),
  /** Whether the voice is in memory now. It is unloaded after ten idle minutes. */
  loaded: z.boolean(),
  failure: z.strictObject({ code: VoiceEngineFailureCodeSchema, sentence: z.string().min(1).max(400) }).optional(),
  selfTest: ReplyVoiceSelfTestSchema.optional(),
  /** Which engine runs the voice; present once it is installed. */
  runtime: VoiceRuntimeSchema.optional(),
});
export type ReplyVoiceView = z.infer<typeof ReplyVoiceViewSchema>;

/** One piece of speech, at the stream's 16 kHz, mono, in [-1, 1]. */
export interface ReplySpeech {
  readonly samples: Float32Array;
  /** The milliseconds it took to turn the text into these samples. */
  readonly speakMs: number;
}

/** The reply voice seen from the daemon: the voice stream and the routes. */
export interface ReplyVoiceApi {
  view(): Promise<ReplyVoiceView>;
  /** Starts the download in the background and answers at once; poll {@link view}. Idempotent while installing. */
  install(): Promise<ReplyVoiceView>;
  /** Unloads, then deletes the downloaded files. */
  remove(): Promise<ReplyVoiceView>;
  /** Loads the voice into memory now, so the first line a person hears is not what pays for the load. */
  warm(): Promise<void>;
  /** One short piece of text (a sentence or a clause) as sound. Loads the voice first if it is not in memory. */
  speak(text: string): Promise<ReplySpeech>;
}

/** The speaker Kokoro uses: `af_heart`, the voice the model's own sample uses. One fact, read by the worker. */
export const REPLY_SPEAKER_ID = 3;
