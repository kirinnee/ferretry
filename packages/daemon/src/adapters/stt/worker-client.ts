import { STT_SAMPLE_RATE, type SttWorkerModel, type SttWorkerRequest, type SttWorkerStatus } from '@ferretry/protocol';
import {
  exitFailure,
  parseWorkerResponse,
  projectWorkerStatus,
  SttError,
  type WorkerFailure,
  workerRequestFailure,
} from '../../lib/index.ts';

/** A spawned worker as the supervisor sees it. */
export interface SttWorkerHandle {
  readonly pid: number | undefined;
  send(message: SttWorkerRequest): void;
  /** Ask the child to stop. Must be safe to call repeatedly. */
  terminate(): void;
  /** Stop the child now. Must be safe to call repeatedly and after it exited. */
  kill(): void;
}

export interface SpawnSttWorkerOptions {
  onMessage(message: unknown): void;
  onStderr(chunk: string): void;
  onExit(exitCode: number | null, signal: string | number | null): void;
}

export interface SttWorkerSpawner {
  spawn(options: SpawnSttWorkerOptions): SttWorkerHandle;
}

export interface SttWorkerTimers {
  set(callback: () => void, milliseconds: number): unknown;
  clear(handle: unknown): void;
}

export interface SttWorkerClock {
  nowIso(): string;
}

export interface SttWorkerClientOptions {
  /** Resolves the installed daemon model, or undefined when it is absent. */
  readonly model: () => Promise<SttWorkerModel | undefined>;
  readonly spawner: SttWorkerSpawner;
  readonly clock: SttWorkerClock;
  readonly timers?: SttWorkerTimers;
  readonly threads?: number;
  readonly loadTimeoutMs?: number;
  readonly decodeTimeoutMs?: number;
  /** How long a polite stop is given before the child is killed outright. */
  readonly shutdownTimeoutMs?: number;
  /** How long a kill is given before the supervisor stops waiting for the exit. */
  readonly killTimeoutMs?: number;
  /**
   * How long a loaded worker may sit idle before it is released, or `0` to keep it resident.
   *
   * A loaded speech model is hundreds of megabytes and the daemon is long-lived, so a worker that
   * transcribed once at breakfast holds that memory until the daemon restarts. Releasing it costs
   * the next caller one load; keeping it costs everything else on the box all day.
   */
  readonly idleTimeoutMs?: number;
  readonly onStderr?: (chunk: string) => void;
  readonly requestId?: () => string;
}

export interface SttWorkerTranscription {
  readonly text: string;
  readonly modelId: string;
  readonly audioMs: number;
  readonly decodeMs: number;
}

const STDERR_TAIL_CHARS = 2_000;
const DEFAULT_THREADS = 2;

type Outcome = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: SttError };

interface Pending {
  readonly requestId: string;
  readonly kind: 'load' | 'transcribe';
  readonly settle: (outcome: Outcome) => void;
  readonly timer: unknown;
}

const defaultTimers: SttWorkerTimers = {
  set: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clear: handle => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/**
 * Supervises exactly one batch worker child.
 *
 * Invariants this class is responsible for:
 *
 * - **No zombies.** Every path that abandons a child — load timeout, decode
 *   timeout, close, or an unexpected exit — kills it, and a child that ignores a
 *   polite stop is killed outright after a bounded grace. Waiting for an exit is
 *   itself bounded, so a child that refuses to die cannot hang the daemon.
 * - **One request at a time.** The recognizer is single-threaded, so a second
 *   transcription is refused with `busy` rather than queued behind a decode.
 * - **No silent hangs.** Load and decode both have deadlines; a deadline reaps
 *   the child and fails the caller with a code, never a pending promise.
 */
export class SttWorkerClient {
  private readonly timers: SttWorkerTimers;
  private readonly threads: number;
  private readonly loadTimeoutMs: number;
  private readonly decodeTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly killTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private idleTimer: unknown;
  private readonly nextRequestId: () => string;
  private readonly exitWaiters: (() => void)[] = [];
  private child: SttWorkerHandle | undefined;
  private generation = 0;
  private pending: Pending | undefined;
  private loading: Promise<{ modelId: string; loadMs: number }> | undefined;
  private loadedModel: SttWorkerModel | undefined;
  private loadedAt: string | undefined;
  private busy = false;
  private closed = false;
  private lastError: WorkerFailure | undefined;
  private stderrTail = '';
  private counter = 0;

  constructor(private readonly options: SttWorkerClientOptions) {
    this.timers = options.timers ?? defaultTimers;
    this.threads = options.threads ?? DEFAULT_THREADS;
    this.loadTimeoutMs = options.loadTimeoutMs ?? 120_000;
    this.decodeTimeoutMs = options.decodeTimeoutMs ?? 120_000;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 2_000;
    this.killTimeoutMs = options.killTimeoutMs ?? 1_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 5 * 60_000;
    this.nextRequestId =
      options.requestId ??
      (() => {
        this.counter += 1;
        return `r${this.counter}`;
      });
  }

  status(): SttWorkerStatus {
    return projectWorkerStatus({
      closed: this.closed,
      loading: this.loading !== undefined,
      busy: this.busy,
      ...(this.child?.pid === undefined ? {} : { pid: this.child.pid }),
      ...(this.loadedModel === undefined ? {} : { modelId: this.loadedModel.id }),
      ...(this.loadedAt === undefined ? {} : { loadedAt: this.loadedAt }),
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
    });
  }

  /** Spawns and loads the model if needed; concurrent callers share one load. */
  async ensureReady(): Promise<{ modelId: string; loadMs: number }> {
    if (this.closed) throw new SttError('service_closed', 'speech-to-text is shutting down');
    this.cancelIdle();
    if (this.child !== undefined && this.loadedModel !== undefined && this.loadedAt !== undefined) {
      this.scheduleIdle();
      return { modelId: this.loadedModel.id, loadMs: 0 };
    }
    const existing = this.loading;
    if (existing !== undefined) return await existing;
    const warming = this.warm();
    this.loading = warming;
    try {
      return await warming;
    } finally {
      if (this.loading === warming) this.loading = undefined;
      this.scheduleIdle();
    }
  }

  async transcribe(samples: Float32Array<ArrayBuffer>): Promise<SttWorkerTranscription> {
    if (this.closed) throw new SttError('service_closed', 'speech-to-text is shutting down');
    if (this.busy) throw new SttError('busy', 'the batch transcriber is busy');
    await this.ensureReady();
    const child = this.child;
    if (child === undefined) throw new SttError('worker_unavailable', 'the batch transcriber is not running');
    this.busy = true;
    this.cancelIdle();
    try {
      const value = await this.exchange(
        child,
        requestId => ({ type: 'transcribe', requestId, sampleRate: STT_SAMPLE_RATE, audio: samples }),
        'transcribe',
        this.decodeTimeoutMs,
        'the batch transcription timed out',
      );
      return value as SttWorkerTranscription;
    } finally {
      this.busy = false;
      this.scheduleIdle();
    }
  }

  /** Stops the worker for good. Safe to call twice; never leaves a child alive. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.cancelIdle();
    const child = this.child;
    this.failPending(new SttError('service_closed', 'speech-to-text is shutting down'));
    if (child !== undefined) await this.stop(child);
    this.child = undefined;
    this.loadedModel = undefined;
    this.loadedAt = undefined;
  }

  private async warm(): Promise<{ modelId: string; loadMs: number }> {
    const model = await this.options.model();
    if (model === undefined) throw new SttError('model_missing', 'the daemon model is not installed');
    if (this.closed) throw new SttError('service_closed', 'speech-to-text is shutting down');
    const child = this.child ?? this.launch();
    const ready = (await this.exchange(
      child,
      requestId => ({ type: 'load', requestId, model, threads: this.threads }),
      'load',
      this.loadTimeoutMs,
      'loading the batch model timed out',
    )) as { modelId: string; loadMs: number };
    this.loadedModel = model;
    this.loadedAt = this.options.clock.nowIso();
    this.lastError = undefined;
    return ready;
  }

  private launch(): SttWorkerHandle {
    this.generation += 1;
    const generation = this.generation;
    const child = this.options.spawner.spawn({
      onMessage: message => {
        this.receive(generation, message);
      },
      onStderr: chunk => {
        this.stderrTail = `${this.stderrTail}${chunk}`.slice(-STDERR_TAIL_CHARS);
        this.options.onStderr?.(chunk);
      },
      onExit: (exitCode, signal) => {
        this.handleExit(generation, exitCode, signal);
      },
    });
    this.child = child;
    return child;
  }

  private receive(generation: number, message: unknown): void {
    const pending = this.pending;
    const response = parseWorkerResponse(message);
    if (generation !== this.generation || pending === undefined || response === undefined) return;
    if (response.type === 'bye') return;
    if (response.type === 'error') {
      if (response.requestId !== undefined && response.requestId !== pending.requestId) return;
      this.settle(pending, { ok: false, error: workerRequestFailure(response) });
      return;
    }
    if (response.requestId !== pending.requestId) return;
    if (response.type === 'ready') {
      if (pending.kind === 'load') {
        this.settle(pending, { ok: true, value: { modelId: response.modelId, loadMs: response.loadMs } });
      }
      return;
    }
    if (pending.kind !== 'transcribe') return;
    this.settle(pending, {
      ok: true,
      value: {
        text: response.text,
        modelId: response.modelId,
        audioMs: response.audioMs,
        decodeMs: response.decodeMs,
      },
    });
  }

  private handleExit(generation: number, exitCode: number | null, signal: string | number | null): void {
    this.releaseExitWaiters();
    if (generation !== this.generation) return;
    this.cancelIdle();
    this.child = undefined;
    this.loadedModel = undefined;
    this.loadedAt = undefined;
    this.busy = false;
    if (this.closed) return;
    const failure = exitFailure(exitCode, signal, this.stderrTail, this.options.clock.nowIso());
    this.lastError = failure;
    this.failPending(new SttError('worker_crashed', failure.message));
  }

  private releaseExitWaiters(): void {
    const waiters = this.exitWaiters.splice(0, this.exitWaiters.length);
    for (const waiter of waiters) waiter();
  }

  private settle(pending: Pending, outcome: Outcome): void {
    if (this.pending === pending) this.pending = undefined;
    this.timers.clear(pending.timer);
    pending.settle(outcome);
  }

  private failPending(error: SttError): void {
    const pending = this.pending;
    if (pending === undefined) return;
    this.pending = undefined;
    this.timers.clear(pending.timer);
    pending.settle({ ok: false, error });
  }

  /** One request, one reply, one deadline. A deadline always reaps the child. */
  private async exchange(
    child: SttWorkerHandle,
    build: (requestId: string) => SttWorkerRequest,
    kind: Pending['kind'],
    timeoutMs: number,
    timeoutMessage: string,
  ): Promise<unknown> {
    if (this.pending !== undefined) throw new SttError('busy', 'the batch transcriber is busy');
    const requestId = this.nextRequestId();
    return await new Promise<unknown>((resolve, reject) => {
      const settle = (outcome: Outcome): void => {
        if (outcome.ok) resolve(outcome.value);
        else reject(outcome.error);
      };
      const timer = this.timers.set(() => {
        const failure: WorkerFailure = {
          code: 'worker_unavailable',
          message: timeoutMessage,
          at: this.options.clock.nowIso(),
        };
        this.lastError = failure;
        const pending = this.pending;
        this.pending = undefined;
        this.discard(child);
        pending?.settle({ ok: false, error: new SttError(failure.code, failure.message) });
      }, timeoutMs);
      this.pending = { requestId, kind, settle, timer };
      try {
        child.send(build(requestId));
      } catch (error) {
        this.failPending(
          new SttError('worker_unavailable', 'the batch transcriber could not be reached', { cause: error }),
        );
      }
    });
  }

  private cancelIdle(): void {
    if (this.idleTimer === undefined) return;
    this.timers.clear(this.idleTimer);
    this.idleTimer = undefined;
  }

  /**
   * Arm the idle release, if there is anything to release.
   *
   * Every guard here is a state in which firing would be wrong: a closed client has no child to
   * free, a busy or loading one is mid-request, and a client with no child has already released it.
   * The timer re-checks them when it fires, because the client can become busy in between — a
   * release that raced a decode would kill the child out from under it.
   */
  private scheduleIdle(): void {
    this.cancelIdle();
    if (this.idleTimeoutMs <= 0 || this.closed || this.busy || this.child === undefined) return;
    this.idleTimer = this.timers.set(() => {
      this.idleTimer = undefined;
      const child = this.child;
      if (this.closed || this.busy || this.pending !== undefined || child === undefined) return;
      this.discard(child);
    }, this.idleTimeoutMs);
  }

  /** Abandon a child we no longer trust: it is killed, never merely dropped. */
  private discard(child: SttWorkerHandle): void {
    if (this.child === child) {
      this.child = undefined;
      this.loadedModel = undefined;
      this.loadedAt = undefined;
      this.busy = false;
      this.generation += 1;
    }
    child.kill();
  }

  /**
   * Ask politely, then insist, then stop waiting — but kill once more on the way
   * out, so a child that ignored both signals still cannot outlive the daemon.
   */
  private async stop(child: SttWorkerHandle): Promise<void> {
    const exited = new Promise<void>(resolve => {
      this.exitWaiters.push(resolve);
    });
    const insist = this.timers.set(() => {
      child.kill();
    }, this.shutdownTimeoutMs);
    const giveUp = this.timers.set(() => {
      this.releaseExitWaiters();
    }, this.shutdownTimeoutMs + this.killTimeoutMs);
    try {
      child.terminate();
    } catch {
      child.kill();
    }
    await exited;
    this.timers.clear(insist);
    this.timers.clear(giveUp);
    child.kill();
  }
}
