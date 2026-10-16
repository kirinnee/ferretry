/**
 * The page's side of the speech worker: start it, ask it for text, and stop it.
 *
 * The model runs in a dedicated Web Worker (`src/worker/parakeet-worker.ts`) so a multi-second
 * decode never freezes the page, and so that giving its ~1 GB of memory back is one call:
 * `unload()` terminates the worker, which the browser reclaims whole — there is no half-released
 * ONNX session to reason about.
 *
 * The worker is started on first use, not at page load; `preload()` starts loading the model the
 * moment the microphone opens, so the load overlaps with the person speaking.
 */

import type { ParakeetWorkerFailure, ParakeetWorkerReply, ParakeetWorkerRequest } from './parakeet-worker-core.ts';

/** The slice of `Worker` this module uses. */
export interface ParakeetWorkerLike {
  postMessage(message: ParakeetWorkerRequest, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  addEventListener(type: 'error', listener: (event: unknown) => void): void;
  terminate(): void;
}

export class ParakeetEngineError extends Error {
  readonly code: ParakeetWorkerFailure | 'worker-failed' | 'cancelled';

  constructor(code: ParakeetEngineError['code'], message: string) {
    super(message);
    this.name = 'ParakeetEngineError';
    this.code = code;
  }
}

interface Pending {
  resolve(text: string): void;
  reject(error: ParakeetEngineError): void;
}

const isReply = (data: unknown): data is ParakeetWorkerReply =>
  typeof data === 'object' &&
  data !== null &&
  ['ready', 'result', 'failed'].includes((data as { type?: unknown }).type as string);

export class ParakeetEngine {
  readonly #spawn: () => ParakeetWorkerLike;
  #worker: ParakeetWorkerLike | null = null;
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;

  constructor(spawn: () => ParakeetWorkerLike) {
    this.#spawn = spawn;
  }

  /** Start loading the model now, so the first utterance does not wait for it. */
  preload(): void {
    this.#ensure().postMessage({ type: 'load' });
  }

  /** Decode one utterance. The samples are transferred to the worker, not copied. */
  transcribe(samples: Float32Array, signal?: AbortSignal): Promise<string> {
    const id = this.#nextId;
    this.#nextId += 1;
    const worker = this.#ensure();
    return new Promise<string>((resolve, reject) => {
      const onAbort = (): void => {
        // ONNX cannot interrupt a decode in flight; the answer is simply not waited for.
        this.#pending.delete(id);
        reject(new ParakeetEngineError('cancelled', 'Transcription was cancelled.'));
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

  /** Stop the worker and free its memory. The next use starts a fresh one. */
  unload(): void {
    const worker = this.#worker;
    this.#worker = null;
    worker?.terminate();
    this.#failAll(new ParakeetEngineError('cancelled', 'The speech model was unloaded.'));
  }

  #ensure(): ParakeetWorkerLike {
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
        new ParakeetEngineError('worker-failed', 'The on-device speech engine could not start in this browser.'),
      );
    });
    return worker;
  }

  #receive(data: unknown): void {
    if (!isReply(data) || data.type === 'ready') return;
    if (data.type === 'result') {
      const pending = this.#pending.get(data.id);
      this.#pending.delete(data.id);
      pending?.resolve(data.text);
      return;
    }
    if (data.id === null) return;
    const pending = this.#pending.get(data.id);
    this.#pending.delete(data.id);
    pending?.reject(new ParakeetEngineError(data.code, data.message));
  }

  #failAll(error: ParakeetEngineError): void {
    const waiting = [...this.#pending.values()];
    this.#pending.clear();
    for (const pending of waiting) pending.reject(error);
  }
}
