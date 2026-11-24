/**
 * What the main thread and the reply voice's worker say to each other. The runtime's bytes cross as a transferred
 * ArrayBuffer; the model files are NOT sent at all: the runtime reads them from their own paths (its file system is the
 * host's), so the 114 MB model is never copied into a second buffer.
 */
interface ReplyPaths {
  readonly model: string;
  readonly voices: string;
  readonly tokens: string;
  readonly lexicon: string;
}

export type ReplyRequest =
  | { readonly id: number; readonly kind: 'load'; readonly runtime: ArrayBuffer; readonly paths: ReplyPaths }
  | { readonly id: number; readonly kind: 'speak'; readonly text: string; readonly speaker: number };

/** A request before the thread numbers it. */
export type ReplyCall = ReplyRequest extends infer R ? (R extends unknown ? Omit<R, 'id'> : never) : never;

type ReplyAnswer =
  | { readonly kind: 'load'; readonly loadMs: number; readonly memoryMb: number }
  /** `samples` are at 16 kHz (the worker resamples the model's 24 kHz), mono, in [-1, 1]. */
  | { readonly kind: 'speak'; readonly samples: Float32Array; readonly speakMs: number };

/** One reply per request, by `id`. A failure carries a sentence only: never the text that was being spoken. */
export type ReplyReply =
  | ({ readonly id: number; readonly ok: true } & ReplyAnswer)
  | { readonly id: number; readonly ok: false; readonly sentence: string };
