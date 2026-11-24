import { z } from 'zod';
import { NonNegativeFiniteSchema } from '@ferretry/std';

/**
 * The machine speech engine: the speech-to-text and voice detection voice mode runs on the daemon's own host (design
 * `docs/design/voice-modes.md` §2; owner decision O2: the sherpa-onnx WebAssembly runtime first, in a worker thread).
 *
 * NOTHING SECRET AND NOTHING SPOKEN TRAVELS ON THIS WIRE: a state, a size, counters and one fixed sentence. Audio
 * reaches the engine only through the daemon port ({@link VoiceEngineApi.transcribe}), never through a route.
 */

/** `not_installed` → `installing` → `ready` (or `failed`, which says why and can be retried). */
export const VoiceEngineStateSchema = z.enum(['not_installed', 'installing', 'ready', 'failed']);
export type VoiceEngineState = z.infer<typeof VoiceEngineStateSchema>;

/** Why an install or a load stopped. `hash_mismatch` is a download that is not the pinned file: nothing of it is kept. */
export const VoiceEngineFailureCodeSchema = z.enum([
  'download_failed',
  'hash_mismatch',
  'write_failed',
  'no_memory',
  'load_failed',
]);
export type VoiceEngineFailureCode = z.infer<typeof VoiceEngineFailureCodeSchema>;

/** One self-test: the model loaded and decoded one second of silence. */
export const VoiceEngineSelfTestSchema = z.strictObject({
  loadMs: NonNegativeFiniteSchema,
  decodeMs: NonNegativeFiniteSchema,
  /** The speech runtime's own memory once the models are loaded, in MiB (a worker thread cannot see its own share of the process). */
  memoryMb: NonNegativeFiniteSchema,
});
export type VoiceEngineSelfTest = z.infer<typeof VoiceEngineSelfTestSchema>;

export const VoiceEngineViewSchema = z.strictObject({
  state: VoiceEngineStateSchema,
  /** What this machine is called, for "Install on <machine>". */
  machine: z.string().min(1).max(100),
  /** What it is, in words a person reads. */
  label: z.string().min(1).max(200),
  /** Everything Install downloads, in bytes (the number the button shows). */
  sizeBytes: z.number().int().nonnegative(),
  /** Bytes already downloaded and checked against their pinned hash. */
  doneBytes: z.number().int().nonnegative(),
  /** Whether the models are in memory now. They are unloaded after ten idle minutes. */
  loaded: z.boolean(),
  failure: z.strictObject({ code: VoiceEngineFailureCodeSchema, sentence: z.string().min(1).max(400) }).optional(),
  selfTest: VoiceEngineSelfTestSchema.optional(),
});
export type VoiceEngineView = z.infer<typeof VoiceEngineViewSchema>;

/** What one decode answers. Never stored: the text goes to whoever asked. */
export interface VoiceTranscription {
  readonly text: string;
  readonly decodeMs: number;
  /** `decodeMs` divided by the audio's length: below 1 is faster than real time. */
  readonly realTimeFactor: number;
}

/** Voice found in 16 kHz audio, as `[start, end)` sample offsets. */
export interface VoiceSpan {
  readonly start: number;
  readonly end: number;
}

/** The engine seen from the daemon: other plugins' code (the voice stream) and the routes. */
export interface VoiceEngineApi {
  view(): Promise<VoiceEngineView>;
  /** Starts the download in the background and answers at once; poll {@link view}. Idempotent while installing. */
  install(): Promise<VoiceEngineView>;
  /** Unloads, then deletes the downloaded files. */
  remove(): Promise<VoiceEngineView>;
  /** One whole take of 16 kHz mono samples in [-1, 1]. Loads the models first if they are not in memory. */
  transcribe(samples: Float32Array): Promise<VoiceTranscription>;
  /** Where the voice is in 16 kHz mono samples (Silero VAD), for the pause that ends a turn. */
  detectSpeech(samples: Float32Array): Promise<readonly VoiceSpan[]>;
}

/** The engine's refusal: a stable code and a sentence a person reads. */
export class VoiceEngineError extends Error {
  constructor(
    readonly code: VoiceEngineFailureCode | 'not_ready',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'VoiceEngineError';
  }
}

/** The hosts Install reaches (the manifest's `permissions.network`): the file hosts and the CDN Hugging Face redirects to. */
export const ENGINE_HOSTS = ['huggingface.co', '*.hf.co', 'cdn.jsdelivr.net'] as const;
