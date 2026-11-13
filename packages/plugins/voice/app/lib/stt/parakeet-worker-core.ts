/**
 * The speech worker's behaviour, with the worker taken out: what it does with each message.
 *
 * `src/worker/parakeet-worker.ts` is the composition root — it binds ONNX Runtime and parakeet.js to
 * {@link ParakeetRuntime} and the worker's `postMessage` to `post`, and nothing else. Every decision is
 * here, where a test drives it with a fake model:
 *
 *   - the model is loaded lazily, once, and a failed load is not remembered, so the next utterance
 *     genuinely retries;
 *   - loading reads the INSTALLED bytes through the store (`parakeet-store.ts`), which verifies them
 *     again — the worker has no network path and never downloads;
 *   - one decode at a time: `ParakeetModel` has no concurrency contract, so messages are handled in
 *     arrival order on one queue.
 *   - a `timed` transcribe (near-live words, `near-live.ts`) also answers where each word sits, so the
 *     page can commit words and move its window past them;
 *   - THREADS ARE A REQUEST, NEVER A DEMAND. The page asks for a thread count (`speed-plan.ts`). If the
 *     runtime will not start with it, or a decode fails with it (a sub-worker the page policy refused,
 *     an out-of-memory), the answer is `threads-failed` — not `load-failed` — and the PAGE starts a
 *     fresh worker on one thread and repeats the work (`parakeet-engine.ts`). The core cannot retry in
 *     place: ONNX Runtime Web initialises its WebAssembly backend once per worker and never again.
 */

import type { TimedWord } from './near-live.ts';
import type { ParakeetModelBytes } from './parakeet-store.ts';

/** Messages the page sends the worker. */
export type ParakeetWorkerRequest =
  | { readonly type: 'load'; readonly threads?: number }
  | {
      readonly type: 'transcribe';
      readonly id: number;
      readonly samples: Float32Array;
      readonly timed?: true;
      readonly threads?: number;
    };

export type ParakeetWorkerFailure =
  | 'not-installed'
  | 'integrity'
  | 'load-failed'
  | 'transcribe-failed'
  /** Several threads were asked for and did not work; the page retries on one. */
  | 'threads-failed';

/** Messages the worker sends back. */
export type ParakeetWorkerReply =
  | { readonly type: 'ready' }
  | {
      readonly type: 'result';
      readonly id: number;
      readonly text: string;
      readonly words?: readonly TimedWord[];
    }
  | {
      readonly type: 'failed';
      /** The utterance that failed, or `null` for a `load` nobody is waiting on. */
      readonly id: number | null;
      readonly code: ParakeetWorkerFailure;
      readonly message: string;
    };

/** A loaded model: decode 16 kHz mono samples to text. */
export interface ParakeetLoadedModel {
  transcribe(samples: Float32Array): Promise<string>;
  /** The same decode, with each word's start and end in seconds. */
  transcribeTimed(samples: Float32Array): Promise<{ readonly text: string; readonly words: readonly TimedWord[] }>;
}

/** Turns verified bytes into a model. The worker entry implements it over ONNX Runtime. */
export interface ParakeetRuntime {
  /** `threads` is how many the runtime may use; 1 is the floor. */
  load(bytes: ParakeetModelBytes, threads: number): Promise<ParakeetLoadedModel>;
}

export interface ParakeetWorkerCoreOptions {
  /** Reads and re-verifies the installed model. */
  read(): Promise<ParakeetModelBytes>;
  readonly runtime: ParakeetRuntime;
  post(reply: ParakeetWorkerReply): void;
}

/** Threads asked for, clamped to something the runtime can take; absent (one) unless more than one was asked. */
const threadsOf = (value: unknown): { readonly threads?: number } => {
  const asked = typeof value === 'number' && Number.isSafeInteger(value) ? Math.min(8, value) : 1;
  return asked > 1 ? { threads: asked } : {};
};

/** Parse a message from the page; anything else is ignored rather than trusted. */
export const parseWorkerRequest = (data: unknown): ParakeetWorkerRequest | null => {
  if (typeof data !== 'object' || data === null) return null;
  const message = data as Record<string, unknown>;
  if (message.type === 'load') return { type: 'load', ...threadsOf(message.threads) };
  if (message.type === 'transcribe' && Number.isSafeInteger(message.id) && message.samples instanceof Float32Array)
    return {
      type: 'transcribe',
      id: message.id as number,
      samples: message.samples,
      ...threadsOf(message.threads),
      ...(message.timed === true ? { timed: true as const } : {}),
    };
  return null;
};

const messageOf = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message.trim() !== '' ? error.message : fallback;

const codeOf = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
};

export class ParakeetWorkerCore {
  readonly #options: ParakeetWorkerCoreOptions;
  #model: ParakeetLoadedModel | null = null;
  /** Threads the loaded model was built with. */
  #modelThreads = 1;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: ParakeetWorkerCoreOptions) {
    this.#options = options;
  }

  /** Queue one message. Resolves once it has been answered. */
  handle(data: unknown): Promise<void> {
    const request = parseWorkerRequest(data);
    if (request === null) return Promise.resolve();
    const run = this.#tail.then(() => this.#run(request));
    this.#tail = run;
    return run;
  }

  async #run(request: ParakeetWorkerRequest): Promise<void> {
    const id = request.type === 'transcribe' ? request.id : null;
    let model: ParakeetLoadedModel;
    try {
      model = await this.#load(request.threads ?? 1);
    } catch (error) {
      const code = codeOf(error);
      this.#options.post({
        type: 'failed',
        id,
        code:
          code === 'not-installed' || code === 'integrity'
            ? code
            : (request.threads ?? 1) > 1
              ? 'threads-failed'
              : 'load-failed',
        message: messageOf(error, 'The on-device speech model could not be loaded.'),
      });
      return;
    }
    if (request.type === 'load') {
      this.#options.post({ type: 'ready' });
      return;
    }
    try {
      if (request.timed === true) {
        const heard = await model.transcribeTimed(request.samples);
        this.#options.post({ type: 'result', id: request.id, text: heard.text.trim(), words: heard.words });
      } else {
        const text = (await model.transcribe(request.samples)).trim();
        this.#options.post({ type: 'result', id: request.id, text });
      }
    } catch (error) {
      const threaded = this.#modelThreads > 1;
      // A model that failed on several threads is not trusted again in this worker.
      if (threaded) this.#model = null;
      this.#options.post({
        type: 'failed',
        id: request.id,
        code: threaded ? 'threads-failed' : 'transcribe-failed',
        message: messageOf(error, 'The on-device speech model could not transcribe that.'),
      });
    }
  }

  async #load(threads: number): Promise<ParakeetLoadedModel> {
    if (this.#model !== null) return this.#model;
    const model = await this.#options.runtime.load(await this.#options.read(), threads);
    this.#model = model;
    this.#modelThreads = threads;
    return model;
  }
}
