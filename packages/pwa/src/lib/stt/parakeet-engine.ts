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

import type { TimedTranscript, TimedWord } from './near-live.ts';
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
  resolve(heard: TimedTranscript): void;
  reject(error: ParakeetEngineError): void;
}

/** Word times from the worker, kept only where they are what they claim to be. */
const timedWords = (words: unknown): TimedWord[] =>
  Array.isArray(words)
    ? words.filter(
        (word): word is TimedWord =>
          typeof word === 'object' &&
          word !== null &&
          typeof (word as TimedWord).text === 'string' &&
          Number.isFinite((word as TimedWord).start) &&
          Number.isFinite((word as TimedWord).end),
      )
    : [];

const isReply = (data: unknown): data is ParakeetWorkerReply =>
  typeof data === 'object' &&
  data !== null &&
  ['ready', 'result', 'failed'].includes((data as { type?: unknown }).type as string);

export class ParakeetEngine {
  readonly #spawn: () => ParakeetWorkerLike;
  readonly #now: () => number;
  #worker: ParakeetWorkerLike | null = null;
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;
  /** When the model began loading in the current worker, until the worker says it is ready. */
  #loadStartedAt: number | null = null;
  #loadMs: number | null = null;

  constructor(spawn: () => ParakeetWorkerLike, now: () => number = () => globalThis.performance.now()) {
    this.#spawn = spawn;
    this.#now = now;
  }

  /** Start loading the model now, so the first utterance does not wait for it. */
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

  /** Decode one utterance. The samples are transferred to the worker, not copied. */
  async transcribe(samples: Float32Array, signal?: AbortSignal): Promise<string> {
    return (await this.#request(samples, false, signal)).text;
  }

  /** Decode one near-live window, with each word's place in it (`near-live.ts`). */
  transcribeTimed(samples: Float32Array, signal?: AbortSignal): Promise<TimedTranscript> {
    return this.#request(samples, true, signal);
  }

  #request(samples: Float32Array, timed: boolean, signal: AbortSignal | undefined): Promise<TimedTranscript> {
    const id = this.#nextId;
    this.#nextId += 1;
    const worker = this.#ensure();
    this.#loadStartedAt ??= this.#now();
    return new Promise<TimedTranscript>((resolve, reject) => {
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
        resolve: heard => {
          signal?.removeEventListener('abort', onAbort);
          resolve(heard);
        },
        reject: error => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
      });
      worker.postMessage({ type: 'transcribe', id, samples, ...(timed ? { timed: true as const } : {}) }, [
        samples.buffer,
      ]);
    });
  }

  /** Stop the worker and free its memory. The next use starts a fresh one. */
  unload(): void {
    const worker = this.#worker;
    this.#worker = null;
    this.#loadStartedAt = null;
    this.#loadMs = null;
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
      this.#loadStartedAt = null;
      worker.terminate();
      this.#failAll(
        new ParakeetEngineError('worker-failed', 'The on-device speech engine could not start in this browser.'),
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
    if (data.type === 'result') {
      const pending = this.#pending.get(data.id);
      this.#pending.delete(data.id);
      pending?.resolve({ text: data.text, words: timedWords(data.words) });
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
