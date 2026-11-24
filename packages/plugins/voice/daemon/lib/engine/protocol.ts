import type { VoiceSpan } from '../../../contract/index.ts';

/**
 * What the main thread and the speech worker say to each other. Audio and model bytes move as transferred
 * ArrayBuffers, so a 650 MB encoder is never copied on the way in; the native engine reads the three big graphs from their
 * own paths and is sent no model bytes at all.
 */

/** The files a WebAssembly load needs, by role: the two runtimes, Parakeet's three graphs and its vocabulary, and Silero. */
export const LOAD_ROLES = ['sherpa-wasm', 'ort-wasm', 'encoder', 'decoder', 'joiner', 'tokens', 'vad'] as const;
export type LoadRole = (typeof LOAD_ROLES)[number];

/** The small files a native load still sends: Silero stays on onnxruntime-web (it costs 0.2 s a minute of audio). */
export const NATIVE_LOAD_ROLES = ['ort-wasm', 'vad'] as const;
export type NativeLoadRole = (typeof NATIVE_LOAD_ROLES)[number];

/** Where the native recognizer reads Parakeet from. */
interface SpeechPaths {
  readonly encoder: string;
  readonly decoder: string;
  readonly joiner: string;
  readonly tokens: string;
}

export type SpeechRequest =
  | {
      readonly id: number;
      readonly kind: 'load';
      readonly engine: 'wasm';
      readonly files: Readonly<Record<LoadRole, ArrayBuffer>>;
    }
  | {
      readonly id: number;
      readonly kind: 'load';
      readonly engine: 'native';
      /** The native addon's path; its two libraries sit beside it. */
      readonly addon: string;
      readonly threads: number;
      readonly paths: SpeechPaths;
      readonly files: Readonly<Record<NativeLoadRole, ArrayBuffer>>;
    }
  /** Loads the native addon alone, to learn whether this machine can run it, before the models are downloaded. */
  | { readonly id: number; readonly kind: 'probe'; readonly addon: string }
  /**
   * Lets go of the native engine's handles and runs the garbage collector until their finalizers have freed the models. A
   * worker that is only terminated keeps them: Bun frees a native handle when the collector gets to it, on a later turn of
   * the event loop, and a terminated worker never has one. Measured: each load that was only terminated kept 0.5-0.7 GB.
   */
  | { readonly id: number; readonly kind: 'release' }
  | { readonly id: number; readonly kind: 'transcribe'; readonly samples: Float32Array }
  | { readonly id: number; readonly kind: 'detect'; readonly samples: Float32Array };

/** A request before the thread numbers it. */
export type SpeechCall = SpeechRequest extends infer R ? (R extends unknown ? Omit<R, 'id'> : never) : never;

type SpeechAnswer =
  | { readonly kind: 'load'; readonly loadMs: number; readonly memoryMb: number }
  | { readonly kind: 'probe'; readonly version: string }
  | { readonly kind: 'release' }
  | { readonly kind: 'transcribe'; readonly text: string; readonly decodeMs: number }
  | { readonly kind: 'detect'; readonly spans: readonly VoiceSpan[] };

/** One reply per request, by `id`. A failure carries a sentence only: never audio, never text that was decoded. */
export type SpeechReply =
  | ({ readonly id: number; readonly ok: true } & SpeechAnswer)
  | { readonly id: number; readonly ok: false; readonly sentence: string };

/** Speech is 16 kHz mono; the models are trained on nothing else. */
export const SPEECH_SAMPLE_RATE = 16_000;
