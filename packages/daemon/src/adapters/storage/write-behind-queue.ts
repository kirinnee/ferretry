/**
 * HOW A STORE PERSISTS BEHIND ITS MEMORY: queue each write, merge it with the ones it supersedes, and send
 * what is queued as one batch after a short window — one batch in flight at a time, a failed batch put
 * back in front and retried.
 *
 * It knows nothing of what a write is: the caller says how two writes merge, and where a batch goes. The
 * analytics store uses it; the session index (`write-behind-index.ts`) keeps its own copy of the same
 * scheduling over `IndexWrite`s and can adopt this one without any change of behaviour.
 */

export interface WriteBehindOptions {
  /**
   * How long a write waits for others to join its batch before the batch is sent. The window opens at the
   * FIRST write and is not reset by later ones, so a steady stream of writes is still persisted on time.
   */
  readonly batchMs?: number;
  /** How long to wait after a batch failed before it is sent again. */
  readonly retryMs?: number;
  /** Told about every batch that could not be persisted; it is kept and sent again. */
  readonly persistFailed?: (error: Error) => void;
}

/** A quarter second: a burst of writes becomes one batch, and a crash loses at most this much. */
const DEFAULT_BATCH_MS = 250;
const DEFAULT_RETRY_MS = 1_000;

export interface WriteBehindSpec<Batch> {
  /** `earlier` followed by `later`, as the one batch that says both. */
  readonly merge: (earlier: Batch, later: Batch) => Batch;
  readonly empty: Batch;
  readonly isEmpty: (batch: Batch) => boolean;
  /** Makes one batch durable, all or nothing. */
  readonly persist: (batch: Batch) => Promise<void>;
}

export class WriteBehindQueue<Batch> {
  readonly #batchMs: number;
  readonly #retryMs: number;
  #pending: Batch;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #inFlight: Promise<boolean> | undefined;
  #closed = false;

  constructor(
    private readonly spec: WriteBehindSpec<Batch>,
    private readonly options: WriteBehindOptions = {},
  ) {
    this.#batchMs = options.batchMs ?? DEFAULT_BATCH_MS;
    this.#retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
    this.#pending = spec.empty;
  }

  /** What is queued and not yet sent. */
  get pending(): Batch {
    return this.#pending;
  }

  /** Queues `write` behind what is queued, and opens the batch window if none is open. */
  push(write: Batch): void {
    this.#pending = this.spec.merge(this.#pending, write);
    if (!this.#closed) this.#schedule(this.#batchMs);
  }

  /** Persists everything queued — once more after a failure, then gives up — and accepts no timers after. */
  async drain(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#inFlight;
    // A batch that failed was put back; one more try, because the next boot can repair what is lost.
    for (let attempt = 0; attempt < 2 && !this.spec.isEmpty(this.#pending); attempt += 1) await this.#send();
  }

  #schedule(delayMs: number): void {
    if (this.#timer !== undefined || this.#inFlight !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#send().then(sent => {
        if (this.#closed || this.spec.isEmpty(this.#pending)) return;
        this.#schedule(sent ? this.#batchMs : this.#retryMs);
      });
    }, delayMs);
    // The store must never be the reason a finished daemon stays alive; `drain` persists what is queued.
    this.#timer.unref?.();
  }

  /** Sends what is queued as one batch; true when it was persisted. A failed batch is put back in front. */
  #send(): Promise<boolean> {
    const batch = this.#pending;
    this.#pending = this.spec.empty;
    const sent = this.spec.persist(batch).then(
      () => true,
      (error: unknown) => {
        this.#pending = this.spec.merge(batch, this.#pending);
        this.options.persistFailed?.(error instanceof Error ? error : new Error(String(error)));
        return false;
      },
    );
    this.#inFlight = sent;
    return sent.finally(() => {
      this.#inFlight = undefined;
    });
  }
}
