/**
 * The page's side of one Whisper worker: start it, ask it for text, and stop it.
 *
 * Like Parakeet's (`parakeet-engine.ts`), the model runs in a dedicated Web Worker
 * (`src/worker/whisper-worker.ts`) so a decode never freezes the page, and `unload()` terminates it,
 * which gives the model's memory back whole. The worker starts on first use; `preload()` starts
 * loading the model the moment the microphone opens, so the load overlaps with the person speaking.
 *
 * Each voice has its own engine and so its own worker, told which catalog model it is for in every
 * message. Every answer says which backend produced it — WebGPU or WebAssembly — so a dictation can
 * say where it ran.
 *
 * THREADS (`speed-plan.ts`) work as in `parakeet-engine.ts`: `speed.threads()` is a request; a worker
 * that answers `threads-failed` is replaced by a fresh one on one thread, the page is told once
 * (`onThreadsFailed`), and everything still waiting is repeated there.
 */

import type {
  WhisperBackend,
  WhisperWorkerFailure,
  WhisperWorkerReply,
  WhisperWorkerRequest,
} from './whisper-worker-core.ts';

/** The slice of `Worker` this module uses. */
export interface WhisperWorkerLike {
  postMessage(message: WhisperWorkerRequest, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  addEventListener(type: 'error', listener: (event: unknown) => void): void;
  terminate(): void;
}

export class WhisperEngineError extends Error {
  readonly code: WhisperWorkerFailure | 'worker-failed' | 'cancelled';

  constructor(code: WhisperEngineError['code'], message: string) {
    super(message);
    this.name = 'WhisperEngineError';
    this.code = code;
  }
}

/** One decode's answer and where it ran. */
export interface WhisperHeard {
  readonly text: string;
  readonly backend: WhisperBackend;
}

interface Pending {
  resolve(heard: WhisperHeard): void;
  reject(error: WhisperEngineError): void;
}

/** What the page decides about speed; every part optional. */
export interface WhisperEngineSpeed {
  /** Threads to ask the WebAssembly runtime for. 1 (the default) means no threads. */
  threads?(): number;
  /** Several threads did not work; the engine is now on one. `reason` is the runtime's own sentence, for a log line. */
  onThreadsFailed?(reason: string): void;
}

/** The `threads` field of a request: present only when more than one is asked for. */
const threadsField = (threads: number): { readonly threads?: number } => (threads > 1 ? { threads } : {});

const isReply = (data: unknown): data is WhisperWorkerReply =>
  typeof data === 'object' &&
  data !== null &&
  ['ready', 'result', 'failed'].includes((data as { type?: unknown }).type as string);

export class WhisperEngine {
  readonly #model: string;
  readonly #spawn: () => WhisperWorkerLike;
  readonly #now: () => number;
  #worker: WhisperWorkerLike | null = null;
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;
  /** When the model began loading in the current worker, until the worker says it is ready. */
  #loadStartedAt: number | null = null;
  #loadMs: number | null = null;

  readonly #speed: WhisperEngineSpeed;
  readonly #replay = new Map<number, Float32Array>();
  /** Set once several threads failed: this engine asks for one from then on. */
  #oneThread = false;
  /** The thread count the current worker was configured with; `null` while there is no worker. */
  #pinned: number | null = null;

  constructor(
    model: string,
    spawn: () => WhisperWorkerLike,
    now: () => number = () => globalThis.performance.now(),
    speed: WhisperEngineSpeed = {},
  ) {
    this.#model = model;
    this.#spawn = spawn;
    this.#now = now;
    this.#speed = speed;
  }

  /**
   * The thread count of the CURRENT worker. The first message a worker gets fixes it, because a worker
   * keeps the model it loaded: a later planner answer (another tab recorded a failure, say) changes
   * what the NEXT worker is asked for, never what this one is already running. Every message to this
   * worker repeats the pinned count, and replay is kept exactly while it is above one.
   */
  #threads(): number {
    if (this.#pinned !== null) return this.#pinned;
    let threads = 1;
    if (!this.#oneThread) {
      const asked = this.#speed.threads?.() ?? 1;
      threads = Number.isSafeInteger(asked) && asked > 1 ? asked : 1;
    }
    this.#pinned = threads;
    return threads;
  }

  /** Start loading the model now, so the first utterance does not wait for it. */
  preload(): void {
    const worker = this.#ensure();
    this.#loadStartedAt ??= this.#now();
    worker.postMessage({ type: 'load', model: this.#model, ...threadsField(this.#threads()) });
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
  transcribe(samples: Float32Array, signal?: AbortSignal): Promise<WhisperHeard> {
    const id = this.#nextId;
    this.#nextId += 1;
    const worker = this.#ensure();
    this.#loadStartedAt ??= this.#now();
    return new Promise<WhisperHeard>((resolve, reject) => {
      const onAbort = (): void => {
        // ONNX cannot interrupt a decode in flight; the answer is simply not waited for.
        this.#pending.delete(id);
        this.#replay.delete(id);
        reject(new WhisperEngineError('cancelled', 'Transcription was cancelled.'));
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
      const threads = this.#threads();
      if (threads > 1) this.#replay.set(id, samples.slice());
      worker.postMessage({ type: 'transcribe', id, model: this.#model, samples, ...threadsField(threads) }, [
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
    this.#replay.clear();
    this.#pinned = null;
    worker?.terminate();
    this.#failAll(new WhisperEngineError('cancelled', 'The speech model was unloaded.'));
  }

  #ensure(): WhisperWorkerLike {
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
      this.#pinned = null;
      this.#loadStartedAt = null;
      worker.terminate();
      this.#failAll(
        new WhisperEngineError('worker-failed', 'The on-device speech engine could not start in this browser.'),
      );
    });
    return worker;
  }

  #receive(data: unknown): void {
    if (!isReply(data)) return;
    if (data.type === 'ready') {
      this.#loaded();
      return;
    }
    if (data.type === 'result') {
      // A transcribe that loaded the model itself (no preload) paid the load inside its own decode, so
      // there is no separate load time to report, and a later preload must not measure from here.
      this.#loadStartedAt = null;
      const pending = this.#pending.get(data.id);
      this.#pending.delete(data.id);
      this.#replay.delete(data.id);
      pending?.resolve({ text: data.text, backend: data.backend === 'webgpu' ? 'webgpu' : 'wasm' });
      return;
    }
    if (data.code === 'threads-failed') {
      this.#retryOnOneThread(data.message);
      return;
    }
    if (data.id === null) return;
    const pending = this.#pending.get(data.id);
    this.#pending.delete(data.id);
    this.#replay.delete(data.id);
    pending?.reject(new WhisperEngineError(data.code, data.message));
  }

  /**
   * Threads did not work: tell the page, start a fresh worker on one thread, and repeat what is waiting.
   * Every request to a threaded worker kept its audio (retention follows the worker's pinned thread
   * count), so every waiting one is repeated. A one-thread worker that reports a thread failure cannot be
   * retried, so everything waiting is SETTLED with a clear error rather than left waiting forever.
   */
  #retryOnOneThread(reason: string): void {
    if (this.#oneThread || this.#pinned === 1) {
      this.#failAll(new WhisperEngineError('worker-failed', 'The on-device speech engine failed on one thread.'));
      return;
    }
    this.#oneThread = true;
    this.#speed.onThreadsFailed?.(reason);
    const stale = this.#worker;
    this.#worker = null;
    this.#pinned = null;
    stale?.terminate();
    let worker: WhisperWorkerLike | null = null;
    try {
      worker = this.#ensure();
      this.#pinned = 1;
      worker.postMessage({ type: 'load', model: this.#model });
      const jobs = [...this.#replay];
      this.#replay.clear();
      for (const [id, samples] of jobs)
        worker.postMessage({ type: 'transcribe', id, model: this.#model, samples }, [samples.buffer]);
    } catch {
      // The replacement could not start (a runtime out of workers or memory) or could not be given the
      // audio. Nothing waiting can be answered now, so release the partial worker and settle every caller.
      this.#worker = null;
      this.#pinned = null;
      this.#loadStartedAt = null;
      worker?.terminate();
      this.#failAll(
        new WhisperEngineError('worker-failed', 'The on-device speech engine could not restart on one thread.'),
      );
    }
  }

  #loaded(): void {
    if (this.#loadStartedAt === null) return;
    this.#loadMs = Math.max(0, this.#now() - this.#loadStartedAt);
    this.#loadStartedAt = null;
  }

  #failAll(error: WhisperEngineError): void {
    this.#replay.clear();
    const waiting = [...this.#pending.values()];
    this.#pending.clear();
    for (const pending of waiting) pending.reject(error);
  }
}
