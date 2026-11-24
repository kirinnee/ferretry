import type { VoiceSpan } from '../../../contract/index.ts';

/**
 * What the main thread and the speech worker say to each other. Audio and model bytes move as transferred
 * ArrayBuffers, so a 650 MB encoder is never copied on the way in.
 */

/** The files a load needs, by role: the two WebAssembly runtimes, Parakeet's three graphs and its vocabulary, and Silero. */
export const LOAD_ROLES = ['sherpa-wasm', 'ort-wasm', 'encoder', 'decoder', 'joiner', 'tokens', 'vad'] as const;
export type LoadRole = (typeof LOAD_ROLES)[number];

export type SpeechRequest =
  | { readonly id: number; readonly kind: 'load'; readonly files: Readonly<Record<LoadRole, ArrayBuffer>> }
  | { readonly id: number; readonly kind: 'transcribe'; readonly samples: Float32Array }
  | { readonly id: number; readonly kind: 'detect'; readonly samples: Float32Array };

/** A request before the thread numbers it. */
export type SpeechCall = SpeechRequest extends infer R ? (R extends unknown ? Omit<R, 'id'> : never) : never;

type SpeechAnswer =
  | { readonly kind: 'load'; readonly loadMs: number; readonly memoryMb: number }
  | { readonly kind: 'transcribe'; readonly text: string; readonly decodeMs: number }
  | { readonly kind: 'detect'; readonly spans: readonly VoiceSpan[] };

/** One reply per request, by `id`. A failure carries a sentence only: never audio, never text that was decoded. */
export type SpeechReply =
  | ({ readonly id: number; readonly ok: true } & SpeechAnswer)
  | { readonly id: number; readonly ok: false; readonly sentence: string };

/** Speech is 16 kHz mono; the models are trained on nothing else. */
export const SPEECH_SAMPLE_RATE = 16_000;
