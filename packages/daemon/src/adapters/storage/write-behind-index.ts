import {
  coalesceAll,
  coalesceIndexWrites,
  type EventPointer,
  type IndexedSession,
  type IndexPersister,
  type IndexWrite,
  type RebuildPlan,
  type SessionId,
  type SessionIndex,
} from '../../lib/index.ts';

export interface WriteBehindSessionIndexOptions {
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

/** A quarter second: a busy session's burst of writes becomes one, and a crash loses at most this much. */
const DEFAULT_BATCH_MS = 250;
const DEFAULT_RETRY_MS = 1_000;

/**
 * The session index answered from memory, with every write persisted behind it.
 *
 * Reads and writes are the copy in memory's — synchronous, as the port is, and without one byte of disk
 * IO. Each write that succeeds there is queued, merged with the writes it supersedes
 * ({@link coalesceIndexWrites}), and handed to the {@link IndexPersister} in a batch, one batch at a time.
 * A write the copy refused never reaches the queue, so the file is only ever asked what the copy accepted.
 *
 * WHAT A CRASH CAN LOSE. The writes still queued — at most a batch window and the batch in flight. That
 * is safe because the index was always disposable: every pointer names bytes of a journal that was
 * `fsync`ed before the pointer was written, and a boot reconciles every session's index row against its
 * journal (`DaemonStorage.reconcile`), rescanning whatever the file is behind on. A power cut could already
 * lose the index's last commits under `synchronous = NORMAL`; a crash now loses up to a window more, and
 * the next boot repairs both the same way. `close` persists everything that is queued.
 */
export class WriteBehindSessionIndex implements SessionIndex {
  readonly #batchMs: number;
  readonly #retryMs: number;
  #pending: readonly IndexWrite[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #inFlight: Promise<boolean> | undefined;
  #closed = false;

  constructor(
    private readonly memory: SessionIndex,
    private readonly persister: IndexPersister,
    private readonly options: WriteBehindSessionIndexOptions = {},
  ) {
    this.#batchMs = options.batchMs ?? DEFAULT_BATCH_MS;
    this.#retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  }

  /** How many writes are queued and not yet sent. */
  get pendingWrites(): number {
    return this.#pending.length;
  }

  replaceAll(plan: RebuildPlan): void {
    this.memory.replaceAll(plan);
    this.#queue({ kind: 'replace-all', sessions: plan.sessions, events: plan.events });
  }

  replaceSession(session: IndexedSession, events: readonly EventPointer[]): void {
    this.memory.replaceSession(session, events);
    this.#queue({ kind: 'replace-session', session, events });
  }

  refreshSession(session: IndexedSession): void {
    this.memory.refreshSession(session);
    this.#queue({ kind: 'refresh-session', session });
  }

  appendEvent(session: IndexedSession, event: EventPointer): void {
    this.memory.appendEvent(session, event);
    this.#queue({ kind: 'append-events', session, events: [event] });
  }

  appendEvents(session: IndexedSession, events: readonly EventPointer[]): void {
    this.memory.appendEvents(session, events);
    this.#queue({ kind: 'append-events', session, events });
  }

  removeSession(id: SessionId): void {
    this.memory.removeSession(id);
    this.#queue({ kind: 'remove-session', id });
  }

  findSession(id: SessionId): IndexedSession | undefined {
    return this.memory.findSession(id);
  }

  listSessions(): readonly IndexedSession[] {
    return this.memory.listSessions();
  }

  eventPointers(id: SessionId, afterSequence: number, limit: number): readonly EventPointer[] {
    return this.memory.eventPointers(id, afterSequence, limit);
  }

  fleetEventPointers(limit: number): readonly EventPointer[] {
    return this.memory.fleetEventPointers(limit);
  }

  countEvents(id: SessionId): number {
    return this.memory.countEvents(id);
  }

  /** Persists everything queued — once more after a failure, then gives up — and closes both copies. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    try {
      await this.#inFlight;
      // A batch that failed was put back; one more try, because the next boot can repair what is lost.
      for (let attempt = 0; attempt < 2 && this.#pending.length > 0; attempt += 1) await this.#send();
    } finally {
      try {
        await this.persister.close();
      } finally {
        await this.memory.close();
      }
    }
  }

  #queue(write: IndexWrite): void {
    this.#pending = coalesceIndexWrites(this.#pending, write);
    if (!this.#closed) this.#schedule(this.#batchMs);
  }

  #schedule(delayMs: number): void {
    if (this.#timer !== undefined || this.#inFlight !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#send().then(sent => {
        if (this.#closed || this.#pending.length === 0) return;
        this.#schedule(sent ? this.#batchMs : this.#retryMs);
      });
    }, delayMs);
    // The index must never be the reason a finished daemon stays alive; `close` persists what is queued.
    this.#timer.unref?.();
  }

  /** Sends what is queued as one batch; true when it was persisted. A failed batch is put back in front. */
  #send(): Promise<boolean> {
    const batch = this.#pending;
    this.#pending = [];
    const sent = this.persister.persist(batch).then(
      () => true,
      (error: unknown) => {
        this.#pending = coalesceAll(batch, this.#pending);
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
