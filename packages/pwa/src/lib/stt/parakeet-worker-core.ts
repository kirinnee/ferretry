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
 */

import type { ParakeetModelBytes } from './parakeet-store.ts';

/** Messages the page sends the worker. */
export type ParakeetWorkerRequest =
  | { readonly type: 'load' }
  | { readonly type: 'transcribe'; readonly id: number; readonly samples: Float32Array };

export type ParakeetWorkerFailure = 'not-installed' | 'integrity' | 'load-failed' | 'transcribe-failed';

/** Messages the worker sends back. */
export type ParakeetWorkerReply =
  | { readonly type: 'ready' }
  | { readonly type: 'result'; readonly id: number; readonly text: string }
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
}

/** Turns verified bytes into a model. The worker entry implements it over ONNX Runtime. */
export interface ParakeetRuntime {
  load(bytes: ParakeetModelBytes): Promise<ParakeetLoadedModel>;
}

export interface ParakeetWorkerCoreOptions {
  /** Reads and re-verifies the installed model. */
  read(): Promise<ParakeetModelBytes>;
  readonly runtime: ParakeetRuntime;
  post(reply: ParakeetWorkerReply): void;
}

/** Parse a message from the page; anything else is ignored rather than trusted. */
export const parseWorkerRequest = (data: unknown): ParakeetWorkerRequest | null => {
  if (typeof data !== 'object' || data === null) return null;
  const message = data as Record<string, unknown>;
  if (message.type === 'load') return { type: 'load' };
  if (message.type === 'transcribe' && Number.isSafeInteger(message.id) && message.samples instanceof Float32Array)
    return { type: 'transcribe', id: message.id as number, samples: message.samples };
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
      model = await this.#load();
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
    if (request.type === 'load') {
      this.#options.post({ type: 'ready' });
      return;
    }
    try {
      const text = (await model.transcribe(request.samples)).trim();
      this.#options.post({ type: 'result', id: request.id, text });
    } catch (error) {
      this.#options.post({
        type: 'failed',
        id: request.id,
        code: 'transcribe-failed',
        message: messageOf(error, 'The on-device speech model could not transcribe that.'),
      });
    }
  }

  async #load(): Promise<ParakeetLoadedModel> {
    if (this.#model !== null) return this.#model;
    const model = await this.#options.runtime.load(await this.#options.read());
    this.#model = model;
    return model;
  }
}
