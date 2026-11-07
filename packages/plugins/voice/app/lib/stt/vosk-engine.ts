/**
 * The page's side of the Vosk worker: start it, stream audio into it, and stop it.
 *
 * The model runs in a dedicated Web Worker (`src/worker/vosk-worker.ts`) so decoding never blocks the
 * page, and giving its memory back is one call: `unload()` terminates the worker, which the browser
 * reclaims whole.
 *
 * Unlike Parakeet's engine, which answers one whole take, this one is a STREAM: `open` starts an
 * utterance, `feed` sends each new stretch of audio as it is recorded (the samples are transferred,
 * not copied), the worker answers the words so far through `onHeard`, and `finish` resolves with the
 * whole text once the last audio is in. The worker is started on first use and `preload()` starts
 * loading the model the moment the microphone opens, so the load overlaps with the person speaking.
 */

import type { VoskWorkerFailure, VoskWorkerReply, VoskWorkerRequest } from './vosk-worker-core.ts';

/** The slice of `Worker` this module uses. */
export interface VoskWorkerLike {
  postMessage(message: VoskWorkerRequest, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  addEventListener(type: 'error', listener: (event: unknown) => void): void;
  terminate(): void;
}

export class VoskEngineError extends Error {
  readonly code: VoskWorkerFailure | 'worker-failed' | 'cancelled';

  constructor(code: VoskEngineError['code'], message: string) {
    super(message);
    this.name = 'VoskEngineError';
    this.code = code;
  }
}

/** The words so far in one utterance: committed at an endpoint, interim after it. */
export interface VoskHeardState {
  readonly committed: string;
  readonly interim: string;
}

export interface VoskStreamListeners {
  onHeard(state: VoskHeardState): void;
  /** The utterance cannot go on (the model would not load, or the worker died). Said once. */
  onFailure(error: VoskEngineError): void;
}

/** One utterance being streamed. */
export interface VoskStream {
  /** Send the next stretch of 16 kHz mono audio. Its buffer is transferred to the worker. */
  feed(samples: Float32Array): void;
  /** No more audio: resolves with the whole text. Rejects with the failure if the stream failed. */
  finish(signal?: AbortSignal): Promise<string>;
  /** Drop the utterance. Safe to call more than once, and after `finish`. */
  cancel(): void;
}

interface Open {
  readonly listeners: VoskStreamListeners;
  failure: VoskEngineError | null;
  finishing: { resolve(text: string): void; reject(error: VoskEngineError): void } | null;
}

const isReply = (data: unknown): data is VoskWorkerReply =>
  typeof data === 'object' &&
  data !== null &&
  ['ready', 'heard', 'result', 'failed'].includes((data as { type?: unknown }).type as string);

export class VoskEngine {
  readonly #spawn: () => VoskWorkerLike;
  readonly #now: () => number;
  #worker: VoskWorkerLike | null = null;
  readonly #open = new Map<number, Open>();
  #nextId = 1;
  /** When the model began loading in the current worker, until the worker says it is ready. */
  #loadStartedAt: number | null = null;
  #loadMs: number | null = null;

  constructor(spawn: () => VoskWorkerLike, now: () => number = () => globalThis.performance.now()) {
    this.#spawn = spawn;
    this.#now = now;
  }

  /** Start loading the model now, so the first words do not wait for it. */
  preload(): void {
    const worker = this.#ensure();
    this.#loadStartedAt ??= this.#now();
    worker.postMessage({ type: 'load' });
  }

  /**
   * How long the model took to load in the worker started most recently, once: the first dictation
   * after a (re)load is the only one that paid it, so the next call answers `undefined`.
   */
  consumeLoadMs(): number | undefined {
    const loaded = this.#loadMs;
    this.#loadMs = null;
    return loaded ?? undefined;
  }

  /** Start one utterance. */
  open(listeners: VoskStreamListeners): VoskStream {
    const id = this.#nextId;
    this.#nextId += 1;
    const worker = this.#ensure();
    this.#loadStartedAt ??= this.#now();
    const open: Open = { listeners, failure: null, finishing: null };
    this.#open.set(id, open);
    worker.postMessage({ type: 'open', id });
    let ended = false;
    const end = (): boolean => {
      if (ended) return false;
      ended = true;
      return true;
    };
    return {
      feed: samples => {
        if (ended || open.failure !== null || this.#open.get(id) !== open) return;
        this.#worker?.postMessage({ type: 'audio', id, samples }, [samples.buffer]);
      },
      finish: signal => {
        if (!end()) return Promise.reject(new VoskEngineError('cancelled', 'Dictation already ended.'));
        if (open.failure !== null) {
          this.#open.delete(id);
          return Promise.reject(open.failure);
        }
        return new Promise<string>((resolve, reject) => {
          const onAbort = (): void => {
            this.#open.delete(id);
            this.#worker?.postMessage({ type: 'close', id });
            reject(new VoskEngineError('cancelled', 'Transcription was cancelled.'));
          };
          if (signal?.aborted) {
            onAbort();
            return;
          }
          signal?.addEventListener('abort', onAbort, { once: true });
          open.finishing = {
            resolve: text => {
              signal?.removeEventListener('abort', onAbort);
              resolve(text);
            },
            reject: error => {
              signal?.removeEventListener('abort', onAbort);
              reject(error);
            },
          };
          this.#worker?.postMessage({ type: 'finish', id });
        });
      },
      cancel: () => {
        if (!end()) return;
        if (this.#open.get(id) !== open) return;
        this.#open.delete(id);
        this.#worker?.postMessage({ type: 'close', id });
      },
    };
  }

  /** Stop the worker and free its memory. The next use starts a fresh one. */
  unload(): void {
    const worker = this.#worker;
    this.#worker = null;
    this.#loadStartedAt = null;
    this.#loadMs = null;
    worker?.terminate();
    this.#failAll(new VoskEngineError('cancelled', 'The speech model was unloaded.'));
  }

  #ensure(): VoskWorkerLike {
    if (this.#worker !== null) return this.#worker;
    const worker = this.#spawn();
    this.#worker = worker;
    worker.addEventListener('message', event => {
      if (this.#worker === worker) this.#receive(event.data);
    });
    worker.addEventListener('error', () => {
      if (this.#worker !== worker) return;
      // The worker script itself failed — refused by the page's policy, or a runtime that would not
      // start. Nothing it was asked will be answered, so every utterance hears it now.
      this.#worker = null;
      this.#loadStartedAt = null;
      worker.terminate();
      this.#failAll(
        new VoskEngineError('worker-failed', 'The on-device speech engine could not start in this browser.'),
      );
    });
    return worker;
  }

  #receive(data: unknown): void {
    if (!isReply(data)) return;
    if (data.type === 'ready') {
      if (this.#loadStartedAt !== null) {
        this.#loadMs = Math.max(0, this.#now() - this.#loadStartedAt);
        this.#loadStartedAt = null;
      }
      return;
    }
    if (data.id === null) return;
    const open = this.#open.get(data.id);
    if (open === undefined) return;
    if (data.type === 'heard') {
      if (open.finishing === null) open.listeners.onHeard({ committed: data.committed, interim: data.interim });
      return;
    }
    if (data.type === 'result') {
      this.#open.delete(data.id);
      open.finishing?.resolve(data.text);
      return;
    }
    this.#fail(data.id, open, new VoskEngineError(data.code, data.message));
  }

  #fail(id: number, open: Open, error: VoskEngineError): void {
    if (open.failure !== null) return;
    open.failure = error;
    if (open.finishing !== null) {
      this.#open.delete(id);
      open.finishing.reject(error);
      return;
    }
    open.listeners.onFailure(error);
  }

  #failAll(error: VoskEngineError): void {
    for (const [id, open] of [...this.#open]) this.#fail(id, open, error);
    this.#open.clear();
  }
}
