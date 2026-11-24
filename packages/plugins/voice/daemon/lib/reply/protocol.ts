/**
 * What the main thread and the reply voice's worker say to each other. The model files are NEVER sent: both runtimes read
 * them from their own paths, so the 114 MB (WebAssembly) or 326 MB (native) model is never copied into a second buffer.
 * The WebAssembly runtime's bytes cross as a transferred ArrayBuffer; the native engine is a path, verified by the main
 * thread against its pinned hashes before it is named here.
 */
interface ReplyPaths {
  readonly model: string;
  readonly voices: string;
  readonly tokens: string;
  readonly lexicon: string;
}

export type ReplyRequest =
  | {
      readonly id: number;
      readonly kind: 'load';
      readonly engine: 'wasm';
      readonly runtime: ArrayBuffer;
      readonly paths: ReplyPaths;
    }
  | {
      readonly id: number;
      readonly kind: 'load';
      readonly engine: 'native';
      /** The native addon's path; its two libraries sit beside it. */
      readonly addon: string;
      readonly threads: number;
      readonly paths: ReplyPaths;
    }
  /** Loads the native addon alone, to learn whether this machine can run it, before the big model is downloaded. */
  | { readonly id: number; readonly kind: 'probe'; readonly addon: string }
  /**
   * Lets go of the native engine's handles and runs the garbage collector until their finalizers have freed the models. A
   * worker that is only terminated keeps them: Bun frees a native handle when the collector gets to it, on a later turn of
   * the event loop, and a terminated worker never has one. Measured: each load that was only terminated kept 0.5-0.7 GB.
   */
  | { readonly id: number; readonly kind: 'release' }
  | { readonly id: number; readonly kind: 'speak'; readonly text: string; readonly speaker: number };

/** A request before the thread numbers it. */
export type ReplyCall = ReplyRequest extends infer R ? (R extends unknown ? Omit<R, 'id'> : never) : never;

type ReplyAnswer =
  | { readonly kind: 'load'; readonly loadMs: number; readonly memoryMb: number }
  | { readonly kind: 'probe'; readonly version: string }
  | { readonly kind: 'release' }
  /** `samples` are at 16 kHz (the worker resamples the model's 24 kHz), mono, in [-1, 1]. */
  | { readonly kind: 'speak'; readonly samples: Float32Array; readonly speakMs: number };

/** One reply per request, by `id`. A failure carries a sentence only: never the text that was being spoken. */
export type ReplyReply =
  | ({ readonly id: number; readonly ok: true } & ReplyAnswer)
  | { readonly id: number; readonly ok: false; readonly sentence: string };
