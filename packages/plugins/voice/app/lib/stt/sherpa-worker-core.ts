/**
 * The sherpa worker's behaviour, with the worker taken out: what it does with each message.
 *
 * `src/worker/sherpa-worker.ts` is the composition root — it binds the sherpa-onnx WebAssembly module
 * to {@link SherpaRuntime} and the worker's `postMessage` to `post`, and nothing else. Every decision is
 * here, where a test drives it with a fake recognizer:
 *
 *   - the model is loaded lazily, once, from the INSTALLED bytes the store verifies again on the way
 *     out — the worker has no network path and never downloads — and a failed load is not remembered;
 *   - one message at a time, in arrival order: a recognizer has no concurrency contract;
 *   - a STREAM is fed the recording a slice at a time. After each slice it answers the words so far,
 *     split into `committed` (phrases the endpoint detector closed when the speaker paused — they never
 *     change again) and `interim` (the phrase still being heard). Closing it flushes the tail and
 *     answers the whole text;
 *   - a stream starts with a short silence and ends with one: a streaming Zipformer drops the first
 *     words of audio that starts mid-speech and the last of audio that stops abruptly;
 *   - a model that prints only capitals is put into sentence case here, once, for every answer.
 */

import { onDeviceModel } from './model-catalog.ts';
import type { SherpaCatalogModel } from './sherpa-models.ts';

/** 16 kHz mono, the only rate the recognizers are fed. */
export const SHERPA_SAMPLE_RATE = 16_000;
/** Silence before a stream's first slice and after its last. */
export const STREAM_LEAD_SAMPLES = SHERPA_SAMPLE_RATE * 0.5;
export const STREAM_TAIL_SAMPLES = SHERPA_SAMPLE_RATE * 0.6;

/** Messages the page sends the worker. */
export type SherpaWorkerRequest =
  | { readonly type: 'load'; readonly model: string }
  | { readonly type: 'transcribe'; readonly id: number; readonly samples: Float32Array }
  | { readonly type: 'stream-open'; readonly id: number }
  | { readonly type: 'stream-push'; readonly id: number; readonly samples: Float32Array }
  | { readonly type: 'stream-close'; readonly id: number }
  | { readonly type: 'stream-drop'; readonly id: number };

export type SherpaWorkerFailure = 'not-installed' | 'integrity' | 'load-failed' | 'transcribe-failed';

/** Messages the worker sends back. */
export type SherpaWorkerReply =
  | { readonly type: 'ready'; readonly loadMs: number }
  | { readonly type: 'partial'; readonly id: number; readonly committed: string; readonly interim: string }
  | { readonly type: 'result'; readonly id: number; readonly text: string }
  | {
      readonly type: 'failed';
      /** The request that failed, or `null` for a `load` nobody is waiting on. */
      readonly id: number | null;
      readonly code: SherpaWorkerFailure;
      readonly message: string;
    };

/** One streaming recognizer stream, as thin as the bindings are. */
export interface SherpaStreamPort {
  accept(samples: Float32Array): void;
  /** Decode everything the stream is ready for. */
  decode(): void;
  /** The current phrase's words. */
  text(): string;
  /** Whether the speaker paused long enough to close the phrase. */
  isEndpoint(): boolean;
  /** Start a new phrase on the same stream. */
  reset(): void;
  /** No more audio is coming. */
  inputFinished(): void;
  free(): void;
}

/** A loaded model. */
export interface SherpaLoadedModel {
  /** A streaming model's stream; `null` for a model that only decodes whole takes. */
  openStream(): SherpaStreamPort | null;
  /** Decode one whole take; `null` for a streaming-only model. */
  transcribe(samples: Float32Array): string | null;
}

/** Turns the runtime binary and a model's verified files into a recognizer. */
interface SherpaRuntime {
  load(
    model: SherpaCatalogModel,
    runtime: Uint8Array,
    files: ReadonlyMap<string, Uint8Array>,
  ): Promise<SherpaLoadedModel>;
}

interface SherpaInstalledBytes {
  readonly runtime: Uint8Array;
  readonly files: ReadonlyMap<string, Uint8Array>;
}

export interface SherpaWorkerCoreOptions {
  /** Reads and re-verifies the installed runtime and model. */
  read(model: SherpaCatalogModel): Promise<SherpaInstalledBytes>;
  readonly runtime: SherpaRuntime;
  post(reply: SherpaWorkerReply): void;
  /** Milliseconds on a monotonic clock, for the load time. */
  now(): number;
  /** The catalog entry for a model id; the shipped catalog by default, a suite's own otherwise. */
  readonly lookup?: (id: string) => SherpaCatalogModel | null;
}

const catalogLookup = (id: string): SherpaCatalogModel | null => {
  const model = onDeviceModel(id);
  return model?.runtime === 'sherpa-onnx' ? model : null;
};

const isSamples = (value: unknown): value is Float32Array => value instanceof Float32Array;

/** Parse a message from the page; anything else is ignored rather than trusted. */
export const parseSherpaRequest = (data: unknown): SherpaWorkerRequest | null => {
  if (typeof data !== 'object' || data === null) return null;
  const message = data as Record<string, unknown>;
  if (message.type === 'load') return typeof message.model === 'string' ? { type: 'load', model: message.model } : null;
  if (!Number.isSafeInteger(message.id)) return null;
  const id = message.id as number;
  if (message.type === 'transcribe' && isSamples(message.samples))
    return { type: 'transcribe', id, samples: message.samples };
  if (message.type === 'stream-open') return { type: 'stream-open', id };
  if (message.type === 'stream-push' && isSamples(message.samples))
    return { type: 'stream-push', id, samples: message.samples };
  if (message.type === 'stream-close') return { type: 'stream-close', id };
  if (message.type === 'stream-drop') return { type: 'stream-drop', id };
  return null;
};

/** Words joined by single spaces, empty parts dropped. */
const join = (...parts: readonly string[]): string =>
  parts
    .map(part => part.trim())
    .filter(Boolean)
    .join(' ');

/**
 * ALL-CAPS ENGLISH → sentence case: lower case, then a capital at the start and for the pronoun "I"
 * (and its contractions). Proper nouns stay lower case; that is what the dictionary is for.
 */
export const sentenceCase = (text: string, startsSentence: boolean): string => {
  const lower = text.toLowerCase().replace(/\bi(?=$|\s|')/gu, 'I');
  return startsSentence ? lower.replace(/^\s*\p{L}/u, letter => letter.toUpperCase()) : lower;
};

const messageOf = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message.trim() !== '' ? error.message : fallback;

const codeOf = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
};

interface OpenStream {
  readonly port: SherpaStreamPort;
  committed: string;
}

export class SherpaWorkerCore {
  readonly #options: SherpaWorkerCoreOptions;
  #model: SherpaCatalogModel | null = null;
  #loaded: SherpaLoadedModel | null = null;
  readonly #streams = new Map<number, OpenStream>();
  #tail: Promise<void> = Promise.resolve();

  constructor(options: SherpaWorkerCoreOptions) {
    this.#options = options;
  }

  /** Queue one message. Resolves once it has been answered. */
  handle(data: unknown): Promise<void> {
    const request = parseSherpaRequest(data);
    if (request === null) return Promise.resolve();
    const run = this.#tail.then(() => this.#run(request));
    this.#tail = run;
    return run;
  }

  async #run(request: SherpaWorkerRequest): Promise<void> {
    if (request.type === 'load') {
      const model = (this.#options.lookup ?? catalogLookup)(request.model);
      if (model !== null && this.#model === null) this.#model = model;
    }
    if (request.type === 'stream-drop') {
      this.#streams.get(request.id)?.port.free();
      this.#streams.delete(request.id);
      return;
    }
    const id = request.type === 'load' ? null : request.id;
    let loaded: SherpaLoadedModel;
    try {
      loaded = await this.#load();
    } catch (error) {
      const code = codeOf(error);
      this.#options.post({
        type: 'failed',
        id,
        code: code === 'not-installed' || code === 'integrity' ? code : 'load-failed',
        message: messageOf(error, 'The on-device speech model could not be loaded.'),
      });
      return;
    }
    if (request.type === 'load') return;
    try {
      this.#answer(request, loaded);
    } catch (error) {
      if (request.type !== 'transcribe') {
        this.#streams.get(request.id)?.port.free();
        this.#streams.delete(request.id);
      }
      this.#options.post({
        type: 'failed',
        id: request.id,
        code: 'transcribe-failed',
        message: messageOf(error, 'The on-device speech model could not transcribe that.'),
      });
    }
  }

  #answer(request: Exclude<SherpaWorkerRequest, { type: 'load' | 'stream-drop' }>, loaded: SherpaLoadedModel): void {
    const post = this.#options.post;
    if (request.type === 'transcribe') {
      const text = loaded.transcribe(request.samples);
      if (text === null) throw new Error('This model only listens while you speak; it cannot transcribe a whole take.');
      post({ type: 'result', id: request.id, text: this.#present(text.trim(), true) });
      return;
    }
    if (request.type === 'stream-open') {
      const port = loaded.openStream();
      if (port === null) throw new Error('This model transcribes after you stop; it cannot listen while you speak.');
      port.accept(new Float32Array(STREAM_LEAD_SAMPLES));
      this.#streams.set(request.id, { port, committed: '' });
      return;
    }
    const stream = this.#streams.get(request.id);
    if (stream === undefined) throw new Error('That stream is not open.');
    const { port } = stream;
    if (request.type === 'stream-push') {
      port.accept(request.samples);
      port.decode();
      let interim = port.text().trim();
      if (port.isEndpoint()) {
        stream.committed = join(stream.committed, interim);
        interim = '';
        port.reset();
      }
      const committed = this.#present(stream.committed, true);
      post({ type: 'partial', id: request.id, committed, interim: this.#present(interim, committed === '') });
      return;
    }
    port.accept(new Float32Array(STREAM_TAIL_SAMPLES));
    port.inputFinished();
    port.decode();
    const text = join(stream.committed, port.text());
    port.free();
    this.#streams.delete(request.id);
    post({ type: 'result', id: request.id, text: this.#present(text, true) });
  }

  #present(text: string, startsSentence: boolean): string {
    return this.#model?.textCase === 'upper' ? sentenceCase(text, startsSentence) : text;
  }

  async #load(): Promise<SherpaLoadedModel> {
    if (this.#loaded !== null) return this.#loaded;
    const model = this.#model;
    if (model === null) throw new Error('No sherpa model was named before the first request.');
    const startedAt = this.#options.now();
    const { runtime, files } = await this.#options.read(model);
    const loaded = await this.#options.runtime.load(model, runtime, files);
    this.#loaded = loaded;
    this.#options.post({ type: 'ready', loadMs: Math.max(0, this.#options.now() - startedAt) });
    return loaded;
  }
}
