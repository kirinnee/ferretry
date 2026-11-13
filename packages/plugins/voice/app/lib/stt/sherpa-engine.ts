/**
 * The page's side of the sherpa worker (`src/worker/sherpa-worker.ts`): start it, name its model, feed
 * it audio, and stop it.
 *
 * One worker per model, started on first use — `preload()` starts the load the moment the microphone
 * opens, so it overlaps with the person speaking — and `unload()` terminates it, which gives the whole
 * WebAssembly heap back at once.
 *
 * A STREAM is how a streaming model hears a take: `openStream` returns a handle the session pushes
 * slices of the recording into; every pushed slice is answered with the words so far (`onPartial`),
 * and `close` answers the final text. Samples are transferred to the worker, not copied.
 */

import type { SherpaWorkerFailure, SherpaWorkerReply, SherpaWorkerRequest } from './sherpa-worker-core.ts';

/** The slice of `Worker` this module uses. */
export interface SherpaWorkerLike {
  postMessage(message: SherpaWorkerRequest, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  addEventListener(type: 'error', listener: (event: unknown) => void): void;
  terminate(): void;
}

export class SherpaEngineError extends Error {
  readonly code: SherpaWorkerFailure | 'worker-failed' | 'cancelled';

  constructor(code: SherpaEngineError['code'], message: string) {
    super(message);
    this.name = 'SherpaEngineError';
    this.code = code;
  }
}

/** The words so far: phrases that will not change, then the one still being heard. */
export interface StreamWords {
  readonly committed: string;
  readonly interim: string;
}

/** One take's stream in the worker. */
export interface SherpaStreamHandle {
  /** Hear the next slice of the recording. */
  push(samples: Float32Array): void;
  /** No more audio: the whole text. */
  close(): Promise<string>;
  /** Drop it and what it heard. */
  drop(): void;
}

export interface SherpaStreamCallbacks {
  onPartial(words: StreamWords): void;
  /** The stream died before `close` (a failed load or decode): the take cannot finish. */
  onFailure(error: SherpaEngineError): void;
}

interface Pending {
  resolve(text: string): void;
  reject(error: SherpaEngineError): void;
}

const REPLY_TYPES = new Set(['ready', 'partial', 'result', 'failed']);

const isReply = (data: unknown): data is SherpaWorkerReply =>
  typeof data === 'object' && data !== null && REPLY_TYPES.has((data as { type?: unknown }).type as string);

export class SherpaEngine {
  readonly #spawn: () => SherpaWorkerLike;
  readonly #model: string;
  #worker: SherpaWorkerLike | null = null;
  readonly #pending = new Map<number, Pending>();
  readonly #streams = new Map<number, SherpaStreamCallbacks>();
  #nextId = 1;
  #loadMs: number | undefined;

  constructor(spawn: () => SherpaWorkerLike, model: string) {
    this.#spawn = spawn;
    this.#model = model;
  }

  /** Start loading the model now, so the first words do not wait for it. */
  preload(): void {
    this.#ensure();
  }

  /** How long the model took to load, once: the first take after a load reports it. */
  consumeLoadMs(): number | undefined {
    const loadMs = this.#loadMs;
    this.#loadMs = undefined;
    return loadMs;
  }

  /** Decode one whole take. */
  transcribe(samples: Float32Array, signal?: AbortSignal): Promise<string> {
    const id = this.#id();
    const worker = this.#ensure();
    return new Promise<string>((resolve, reject) => {
      const onAbort = (): void => {
        this.#pending.delete(id);
        reject(new SherpaEngineError('cancelled', 'Transcription was cancelled.'));
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#pending.set(id, {
        resolve: text => {
          signal?.removeEventListener('abort', onAbort);
          resolve(text);
        },
        reject: error => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
      });
      worker.postMessage({ type: 'transcribe', id, samples }, [samples.buffer]);
    });
  }

  /** Open a stream for one take. */
  openStream(callbacks: SherpaStreamCallbacks): SherpaStreamHandle {
    const id = this.#id();
    const worker = this.#ensure();
    this.#streams.set(id, callbacks);
    worker.postMessage({ type: 'stream-open', id });
    let closed = false;
    return {
      push: samples => {
        if (closed || this.#worker !== worker) return;
        worker.postMessage({ type: 'stream-push', id, samples }, [samples.buffer]);
      },
      close: () => {
        if (closed) return Promise.reject(new SherpaEngineError('cancelled', 'The stream was already closed.'));
        closed = true;
        if (this.#worker !== worker || !this.#streams.has(id))
          return Promise.reject(
            new SherpaEngineError('cancelled', 'The speech model stopped before the take finished.'),
          );
        return new Promise<string>((resolve, reject) => {
          this.#pending.set(id, {
            resolve: text => {
              this.#streams.delete(id);
              resolve(text);
            },
            reject: error => {
              this.#streams.delete(id);
              reject(error);
            },
          });
          worker.postMessage({ type: 'stream-close', id });
        });
      },
      drop: () => {
        if (closed) return;
        closed = true;
        this.#streams.delete(id);
        this.#pending.delete(id);
        if (this.#worker === worker) worker.postMessage({ type: 'stream-drop', id });
      },
    };
  }

  /** Stop the worker and free its memory. The next use starts a fresh one. */
  unload(): void {
    const worker = this.#worker;
    this.#worker = null;
    worker?.terminate();
    this.#failAll(new SherpaEngineError('cancelled', 'The speech model was unloaded.'));
  }

  #id(): number {
    const id = this.#nextId;
    this.#nextId += 1;
    return id;
  }

  #ensure(): SherpaWorkerLike {
    if (this.#worker !== null) return this.#worker;
    const worker = this.#spawn();
    this.#worker = worker;
    worker.addEventListener('message', event => {
      if (this.#worker === worker) this.#receive(event.data);
    });
    worker.addEventListener('error', () => {
      if (this.#worker !== worker) return;
      // The worker script itself failed — refused by the page's policy, or a runtime that would not
      // start. Nothing it was asked will be answered, so every caller hears it now.
      this.#worker = null;
      worker.terminate();
      this.#failAll(
        new SherpaEngineError('worker-failed', 'The on-device speech engine could not start in this browser.'),
      );
    });
    worker.postMessage({ type: 'load', model: this.#model });
    return worker;
  }

  #receive(data: unknown): void {
    if (!isReply(data)) return;
    if (data.type === 'ready') {
      this.#loadMs = data.loadMs;
      return;
    }
    if (data.type === 'partial') {
      this.#streams.get(data.id)?.onPartial({ committed: data.committed, interim: data.interim });
      return;
    }
    if (data.type === 'result') {
      const pending = this.#pending.get(data.id);
      this.#pending.delete(data.id);
      pending?.resolve(data.text);
      return;
    }
    if (data.id === null) return;
    const error = new SherpaEngineError(data.code, data.message);
    const pending = this.#pending.get(data.id);
    this.#pending.delete(data.id);
    if (pending !== undefined) {
      pending.reject(error);
      return;
    }
    const stream = this.#streams.get(data.id);
    this.#streams.delete(data.id);
    stream?.onFailure(error);
  }

  #failAll(error: SherpaEngineError): void {
    const waiting = [...this.#pending.values()];
    const streams = [...this.#streams.entries()].filter(([id]) => !this.#pending.has(id)).map(([, stream]) => stream);
    this.#pending.clear();
    this.#streams.clear();
    for (const pending of waiting) pending.reject(error);
    for (const stream of streams) stream.onFailure(error);
  }
}
