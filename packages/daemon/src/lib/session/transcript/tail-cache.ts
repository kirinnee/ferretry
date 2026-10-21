import type { TranscriptEvent } from '../../transcript/types.ts';

/** Which bytes a tail was read from: the same file, the same size, the same modification time. */
export interface TranscriptFingerprint {
  readonly file: string;
  readonly size: number;
  readonly mtimeMs: number;
}

interface CachedTail {
  readonly fingerprint: TranscriptFingerprint;
  readonly limit: number;
  readonly events: readonly TranscriptEvent[];
}

interface PendingTail {
  readonly fingerprint: TranscriptFingerprint;
  readonly limit: number;
  readonly events: Promise<readonly TranscriptEvent[] | undefined>;
}

/** How many sessions' tails are remembered; the least recently asked-for is forgotten first. */
export const TRANSCRIPT_TAIL_CACHE_CAPACITY = 256;
/** How many transcript tails are parsed at once across the whole daemon. */
export const TRANSCRIPT_TAIL_CONCURRENCY = 2;

const sameBytes = (a: TranscriptFingerprint, b: TranscriptFingerprint): boolean =>
  a.file === b.file && a.size === b.size && a.mtimeMs === b.mtimeMs;

/**
 * One daemon-wide memory of the transcript tails it has already parsed.
 *
 * THIS IS THE STALL A REAL FLEET HIT. Every session read, every roster listing — the warden's 30-second
 * liveness pass, the quota-failover roster, the session monitor's 15-second question reconcile — asked
 * for the newest events of EVERY session, and each ask parsed up to 16 MiB of that session's transcript
 * again. A parse is synchronous: about a third of a second for one 200 MB conversation, and a fleet of
 * them made one listing tens of seconds of an event loop that could do nothing else — no request, no
 * relay heartbeat, no timer. Nothing remembered that the bytes had not changed since the last ask.
 *
 * THREE RULES, each closing one way the old cost came back:
 *
 * - A tail is re-parsed only when its file has CHANGED — a different file, size or modification time.
 *   An idle fleet costs a `stat` per session per ask.
 * - Callers asking for the same session at once share ONE parse instead of each starting their own.
 * - At most {@link TRANSCRIPT_TAIL_CONCURRENCY} parses run at a time daemon-wide, so a cold listing of a
 *   hundred sessions is a queue of short parses the loop can interleave other work between, rather
 *   than a hundred parses and their garbage landing on the heap at once.
 *
 * A read that fails is not remembered, so the next ask tries again.
 */
export class TranscriptTailCache {
  readonly #tails = new Map<string, CachedTail>();
  readonly #pending = new Map<string, PendingTail>();
  readonly #waiting: Array<() => void> = [];
  #running = 0;

  constructor(
    private readonly capacity: number = TRANSCRIPT_TAIL_CACHE_CAPACITY,
    private readonly concurrency: number = TRANSCRIPT_TAIL_CONCURRENCY,
  ) {}

  /**
   * The newest `limit` events of the session `key`, whose transcript currently has `fingerprint`,
   * parsing them with `read` only when nothing remembered or in flight already covers them.
   */
  async events(
    key: string,
    fingerprint: TranscriptFingerprint,
    limit: number,
    read: () => Promise<readonly TranscriptEvent[] | undefined>,
  ): Promise<readonly TranscriptEvent[] | undefined> {
    const cached = this.#tails.get(key);
    if (cached !== undefined && cached.limit >= limit && sameBytes(cached.fingerprint, fingerprint)) {
      // Asked for again, so it is the most recently used: move it to the back of the eviction order.
      this.#tails.delete(key);
      this.#tails.set(key, cached);
      return cached.events.slice(-limit);
    }
    const pending = this.#pending.get(key);
    if (pending !== undefined && pending.limit >= limit && sameBytes(pending.fingerprint, fingerprint))
      return (await pending.events)?.slice(-limit);
    const events = this.#parse(key, fingerprint, limit, read);
    this.#pending.set(key, { fingerprint, limit, events });
    return await events;
  }

  async #parse(
    key: string,
    fingerprint: TranscriptFingerprint,
    limit: number,
    read: () => Promise<readonly TranscriptEvent[] | undefined>,
  ): Promise<readonly TranscriptEvent[] | undefined> {
    await this.#slot();
    try {
      const events = await read();
      if (events !== undefined) this.#remember(key, { fingerprint, limit, events });
      return events;
    } finally {
      this.#release();
      if (this.#pending.get(key)?.fingerprint === fingerprint) this.#pending.delete(key);
    }
  }

  #remember(key: string, tail: CachedTail): void {
    this.#tails.delete(key);
    this.#tails.set(key, tail);
    while (this.#tails.size > this.capacity) {
      const oldest = this.#tails.keys().next().value;
      if (oldest === undefined) break;
      this.#tails.delete(oldest);
    }
  }

  async #slot(): Promise<void> {
    if (this.#running < this.concurrency) {
      this.#running += 1;
      return;
    }
    // The slot is handed over directly by `#release`, so `#running` already counts this caller.
    await new Promise<void>(resolve => this.#waiting.push(resolve));
  }

  #release(): void {
    const next = this.#waiting.shift();
    if (next !== undefined) next();
    else this.#running -= 1;
  }
}
