/**
 * The Whisper worker's behaviour, with the worker taken out: what it does with each message.
 *
 * `src/worker/whisper-worker.ts` is the composition root — it binds transformers.js and ONNX Runtime
 * to {@link WhisperRuntime}, WebGPU's adapter probe to `gpu`, and the worker's `postMessage` to `post`.
 * Every decision is here, where a test drives it with a fake runtime:
 *
 *   - the model is loaded lazily, once, from the INSTALLED bytes, which the store verifies again — the
 *     worker has no network path and never downloads;
 *   - WEBGPU FIRST, WEBASSEMBLY ALWAYS. When this worker can reach a WebGPU adapter the model is built
 *     on WebGPU; if that fails — a provider that will not start, a driver that refuses a shader — it is
 *     built again on WebAssembly, and a decode that fails on WebGPU drops the model so the next one
 *     loads on WebAssembly. Every answer says which backend produced it, so Settings can say which ran;
 *   - a failed load is not remembered, so the next utterance genuinely retries;
 *   - THREADS ARE A REQUEST, NEVER A DEMAND (`speed-plan.ts`). On WebAssembly the page may ask for
 *     several; if the runtime will not start with them, or a decode fails with them, the answer is
 *     `threads-failed` and the PAGE starts a fresh worker on one thread (`whisper-engine.ts`) — ONNX
 *     Runtime Web initialises its backend once per worker, so the core cannot retry in place;
 *   - one decode at a time, in arrival order, on one queue.
 */

import { ON_DEVICE_MODELS } from './model-catalog.ts';

/** Where a model ran. */
export type WhisperBackend = 'webgpu' | 'wasm';

/** Messages the page sends the worker. `model` is the catalog id the voice is for. */
export type WhisperWorkerRequest =
  | { readonly type: 'load'; readonly model: string; readonly threads?: number }
  | {
      readonly type: 'transcribe';
      readonly id: number;
      readonly model: string;
      readonly samples: Float32Array;
      readonly threads?: number;
    };

export type WhisperWorkerFailure =
  | 'not-installed'
  | 'integrity'
  | 'load-failed'
  | 'transcribe-failed'
  /** Several threads were asked for and did not work; the page retries on one. */
  | 'threads-failed';

/** Messages the worker sends back. */
export type WhisperWorkerReply =
  | { readonly type: 'ready'; readonly backend: WhisperBackend }
  | { readonly type: 'result'; readonly id: number; readonly text: string; readonly backend: WhisperBackend }
  | {
      readonly type: 'failed';
      /** The utterance that failed, or `null` for a `load` nobody is waiting on. */
      readonly id: number | null;
      readonly code: WhisperWorkerFailure;
      readonly message: string;
    };

/** A loaded model: decode 16 kHz mono samples to text. */
export interface WhisperLoadedModel {
  transcribe(samples: Float32Array): Promise<string>;
  /** Free what the model holds (its ONNX sessions) before another replaces it. */
  dispose(): Promise<void>;
}

/** Turns verified bytes into a model on one backend. The worker entry implements it over transformers.js. */
interface WhisperRuntime<Bytes> {
  /** `threads` applies to the WebAssembly backend only; 1 is the floor. */
  load(model: string, bytes: Bytes, backend: WhisperBackend, threads: number): Promise<WhisperLoadedModel>;
}

export interface WhisperWorkerCoreOptions<Bytes> {
  /** Reads and re-verifies one installed model and its runtime. */
  read(model: string): Promise<Bytes>;
  readonly runtime: WhisperRuntime<Bytes>;
  /** Whether this worker can reach a WebGPU adapter. Asked once. */
  gpu(): Promise<boolean>;
  post(reply: WhisperWorkerReply): void;
  /** Says why WebGPU was given up on, for the console; never shown as a failure. */
  warn?(message: string): void;
}

/** The catalog ids this worker runs: every model on the transformers.js runtime. */
const KNOWN_MODELS: ReadonlySet<string> = new Set(
  ON_DEVICE_MODELS.filter(model => model.runtime === 'transformers-js').map(model => model.id),
);

/** Parse a message from the page; anything else is ignored rather than trusted. */
/** Threads asked for, clamped to something the runtime can take; absent (one) unless more than one was asked. */
const threadsOf = (value: unknown): { readonly threads?: number } => {
  const asked = typeof value === 'number' && Number.isSafeInteger(value) ? Math.min(8, value) : 1;
  return asked > 1 ? { threads: asked } : {};
};

export const parseWhisperRequest = (data: unknown): WhisperWorkerRequest | null => {
  if (typeof data !== 'object' || data === null) return null;
  const message = data as Record<string, unknown>;
  if (typeof message.model !== 'string' || !KNOWN_MODELS.has(message.model)) return null;
  if (message.type === 'load') return { type: 'load', model: message.model, ...threadsOf(message.threads) };
  if (message.type === 'transcribe' && Number.isSafeInteger(message.id) && message.samples instanceof Float32Array)
    return {
      type: 'transcribe',
      id: message.id as number,
      model: message.model,
      samples: message.samples,
      ...threadsOf(message.threads),
    };
  return null;
};

const messageOf = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message.trim() !== '' ? error.message : fallback;

const codeOf = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
};

interface Loaded {
  readonly model: string;
  readonly backend: WhisperBackend;
  /** Threads the WebAssembly model was built with; 1 on WebGPU. */
  readonly threads: number;
  readonly instance: WhisperLoadedModel;
}

export class WhisperWorkerCore<Bytes> {
  readonly #options: WhisperWorkerCoreOptions<Bytes>;
  #loaded: Loaded | null = null;
  #gpu: Promise<boolean> | null = null;
  /** Set once WebGPU failed here: every later load goes straight to WebAssembly. */
  #wasmOnly = false;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: WhisperWorkerCoreOptions<Bytes>) {
    this.#options = options;
  }

  /** Queue one message. Resolves once it has been answered. */
  handle(data: unknown): Promise<void> {
    const request = parseWhisperRequest(data);
    if (request === null) return Promise.resolve();
    const run = this.#tail.then(() => this.#run(request));
    this.#tail = run;
    return run;
  }

  async #run(request: WhisperWorkerRequest): Promise<void> {
    const id = request.type === 'transcribe' ? request.id : null;
    let loaded: Loaded;
    try {
      loaded = await this.#load(request.model, request.threads ?? 1);
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
      this.#options.post({ type: 'ready', backend: loaded.backend });
      return;
    }
    try {
      const text = (await loaded.instance.transcribe(request.samples)).trim();
      this.#options.post({ type: 'result', id: request.id, text, backend: loaded.backend });
    } catch (error) {
      if (loaded.backend === 'webgpu') {
        // A GPU that loaded the model and then failed a decode (a lost device, a refused shader) is
        // not trusted again in this worker: the next utterance loads on WebAssembly.
        this.#options.warn?.(`WebGPU failed a decode; WebAssembly from now on (${messageOf(error, 'no reason')})`);
        this.#wasmOnly = true;
        await this.#drop();
      }
      const threaded = loaded.backend === 'wasm' && loaded.threads > 1;
      // A model that failed on several threads is not trusted again in this worker.
      if (threaded) await this.#drop();
      this.#options.post({
        type: 'failed',
        id: request.id,
        code: threaded ? 'threads-failed' : 'transcribe-failed',
        message: messageOf(error, 'The on-device speech model could not transcribe that.'),
      });
    }
  }

  async #load(model: string, threads: number): Promise<Loaded> {
    if (this.#loaded?.model === model) return this.#loaded;
    await this.#drop();
    const bytes = await this.#options.read(model);
    const { runtime } = this.#options;
    if (!this.#wasmOnly && (await this.#hasGpu())) {
      try {
        return this.#keep({
          model,
          backend: 'webgpu',
          threads: 1,
          instance: await runtime.load(model, bytes, 'webgpu', 1),
        });
      } catch (error) {
        this.#options.warn?.(`WebGPU could not load the model; using WebAssembly (${messageOf(error, 'no reason')})`);
        this.#wasmOnly = true;
      }
    }
    return this.#keep({ model, backend: 'wasm', threads, instance: await runtime.load(model, bytes, 'wasm', threads) });
  }

  #hasGpu(): Promise<boolean> {
    this.#gpu ??= this.#options.gpu().catch(() => false);
    return this.#gpu;
  }

  #keep(loaded: Loaded): Loaded {
    this.#loaded = loaded;
    return loaded;
  }

  async #drop(): Promise<void> {
    const loaded = this.#loaded;
    this.#loaded = null;
    await loaded?.instance.dispose().catch(() => undefined);
  }
}
