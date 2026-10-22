/**
 * ONE WORKER THREAD, ASKED BY REQUEST AND ANSWERED BY ID — the part every bundled worker's adapter
 * shares (docs/design/housekeeping-worker.md §2.1, §2.5).
 *
 * Each request gets an id, waits for the answer that carries it, and is refused if the thread errors,
 * stalls past the timeout, or is closed. The thread is started on the first request and ended once it
 * has been idle a while, so a worker nobody asks costs no memory. A message that answers no request — a
 * probe reply, a stray id, a worker's metrics — never settles one.
 *
 * A THREAD THAT FAILS IS ENDED, NEVER TRUSTED AGAIN. An error or a timeout ends the thread and refuses
 * everything waiting on it; anything the old thread posts after that is ignored, because the handlers
 * belong to the thread they were installed on. With a {@link WorkerRestartPolicy}, a failure also backs
 * the next start off (1 s, 2 s, 4 s … up to the cap), and too many failures in a window retire the
 * worker for good: {@link BundledWorkerHost.available} turns false, and a caller that has another way to
 * do the work — the same code on the main thread — does it there. Correctness never depends on a worker;
 * only where the cost lands does.
 */

/** The part of a Worker a host uses, so a test can stand in a thread that misbehaves on cue. */
export interface HostedWorker<Request, Response> {
  onmessage: ((event: MessageEvent<Response>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: Request): void;
  terminate(): void;
  unref?(): void;
}

/** What one message from the thread says about a request: its answer, its refusal — or nothing. */
export type HostedAnswer<Value> =
  | { readonly id: number; readonly ok: true; readonly value: Value }
  | { readonly id: number; readonly ok: false; readonly error: Error };

/** How a worker that keeps failing is backed off, and when it is retired. */
export interface WorkerRestartPolicy {
  /** The first back-off after a failure; each further failure doubles it. */
  readonly backoffMs: number;
  readonly maxBackoffMs: number;
  /** This many failures inside {@link windowMs} retire the worker until the daemon restarts. */
  readonly maxFailures: number;
  readonly windowMs: number;
}

export interface BundledWorkerHostOptions<Request, Response, Value> {
  /** How the thread is named in a refusal: `the analytics worker`. */
  readonly label: string;
  readonly spawn: () => HostedWorker<Request, Response>;
  /** Reads a message from the thread as an answer to a request, or `undefined` for any other message. */
  readonly answer: (message: Response) => HostedAnswer<Value> | undefined;
  /** Every message that answers no request: a worker's metrics, a probe reply. */
  readonly other?: (message: Response) => void;
  /** Sent to each new thread before its first request: settings it needs and must not be re-sent. */
  readonly greeting?: () => Request;
  /** How long one request may take before the thread is presumed stuck and replaced. */
  readonly timeoutMs: number;
  /** How long an idle thread is kept, read each time it goes idle. */
  readonly idleMs: () => number;
  /**
   * Why a thread failed, as a refusal says it. The default quotes the runtime's error, which is right for
   * a worker that handles no secret; one that does must never quote a message it did not write.
   */
  readonly failure?: (event: ErrorEvent) => string;
  readonly restart?: WorkerRestartPolicy;
  /** Told once, when {@link WorkerRestartPolicy.maxFailures} retires the worker. */
  readonly retired?: () => void;
  readonly now?: () => number;
}

interface Pending<Value> {
  readonly resolve: (value: Value) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

/** Asks one worker thread, by request, through every failure a thread can have. */
export class BundledWorkerHost<Request, Response, Value> {
  readonly #pending = new Map<number, Pending<Value>>();
  readonly #options: BundledWorkerHostOptions<Request, Response, Value>;
  readonly #now: () => number;
  readonly #failures: number[] = [];
  #worker: HostedWorker<Request, Response> | undefined;
  #idle: ReturnType<typeof setTimeout> | undefined;
  #next = 1;
  #backoffUntil = 0;
  #retired = false;

  constructor(options: BundledWorkerHostOptions<Request, Response, Value>) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /** A fresh request id. */
  nextId(): number {
    return this.#next++;
  }

  /** How many requests the thread holds right now: the queue depth a performance profile samples. */
  get inFlight(): number {
    return this.#pending.size;
  }

  /** Whether a request may be sent now: not retired, and not backing off after a failure. */
  get available(): boolean {
    return !this.#retired && this.#now() >= this.#backoffUntil;
  }

  /** Whether too many failures retired the worker until the daemon restarts. */
  get retired(): boolean {
    return this.#retired;
  }

  /**
   * Sends `message` (which carries `id`) and resolves with its answer. `what` finishes the sentence a
   * timeout is refused with: `the analytics worker did not <what> within 120000 ms`.
   */
  request(id: number, message: Request, what: string): Promise<Value> {
    if (!this.available) {
      return Promise.reject(new Error(`${this.#options.label} is not available`));
    }
    const worker = this.#ensure();
    return new Promise<Value>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#fail(new Error(`${this.#options.label} did not ${what} within ${String(this.#options.timeoutMs)} ms`));
      }, this.#options.timeoutMs);
      this.#pending.set(id, { resolve, reject, timeout });
      worker.postMessage(message);
    });
  }

  /** Ends the thread and refuses every request still waiting on it. */
  close(): void {
    this.#discard(new Error(`${this.#options.label} was closed`));
  }

  #ensure(): HostedWorker<Request, Response> {
    if (this.#idle !== undefined) clearTimeout(this.#idle);
    this.#idle = undefined;
    if (this.#worker !== undefined) return this.#worker;
    const worker = this.#options.spawn();
    // The thread must never be the reason a finished daemon stays alive.
    worker.unref?.();
    // Each handler answers only for the thread it was installed on: a thread already replaced is ignored.
    worker.onmessage = event => {
      if (this.#worker === worker) this.#settle(event.data);
    };
    worker.onerror = event => {
      if (this.#worker !== worker) return;
      const said = this.#options.failure?.(event) ?? `${this.#options.label} failed: ${event.message}`;
      this.#fail(new Error(said));
    };
    this.#worker = worker;
    const greeting = this.#options.greeting?.();
    if (greeting !== undefined) worker.postMessage(greeting);
    return worker;
  }

  #settle(message: Response): void {
    const answer = this.#options.answer(message);
    if (answer === undefined) {
      this.#options.other?.(message);
      return;
    }
    const pending = this.#pending.get(answer.id);
    if (pending === undefined) return;
    this.#pending.delete(answer.id);
    clearTimeout(pending.timeout);
    if (answer.ok) pending.resolve(answer.value);
    else pending.reject(answer.error);
    if (this.#pending.size === 0) {
      this.#idle = setTimeout(
        () => this.#discard(new Error(`${this.#options.label} was ended`)),
        this.#options.idleMs(),
      );
    }
  }

  /** A thread that errored or stalled: ended, its requests refused, and the next start backed off. */
  #fail(error: Error): void {
    this.#discard(error);
    const policy = this.#options.restart;
    if (policy === undefined) return;
    const now = this.#now();
    this.#failures.push(now);
    while (this.#failures.length > 0 && now - (this.#failures[0] ?? now) > policy.windowMs) this.#failures.shift();
    if (this.#failures.length >= policy.maxFailures) {
      if (!this.#retired) {
        this.#retired = true;
        this.#options.retired?.();
      }
      return;
    }
    const backoff = Math.min(policy.maxBackoffMs, policy.backoffMs * 2 ** (this.#failures.length - 1));
    this.#backoffUntil = now + backoff;
  }

  #discard(error: Error): void {
    if (this.#idle !== undefined) clearTimeout(this.#idle);
    this.#idle = undefined;
    this.#worker?.terminate();
    this.#worker = undefined;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
