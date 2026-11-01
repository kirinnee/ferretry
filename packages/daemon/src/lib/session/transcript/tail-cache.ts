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

/** The piece of the file-event hub this cache listens to (`FileEventHub` is one). */
export interface TranscriptChangeFeed {
  subscribe(path: string, listener: (path: string) => void): { live(): boolean; close(): void };
}

export interface TranscriptTailCacheEvents {
  readonly changes: TranscriptChangeFeed;
  /** Milliseconds, for how long a verified tail is trusted without a `stat`. */
  readonly now: () => number;
  readonly trustMs?: number;
}

/** A session's transcript under watch, and whether its remembered tail is known to be current. */
interface WatchedTail {
  readonly file: string;
  readonly subscription: { live(): boolean; close(): void };
  /** Bumped by every change event, so a `stat` taken before one is never mistaken for one taken after. */
  changes: number;
  /** When a `stat` taken under a live watch last matched the remembered tail; unset after any change. */
  verifiedAt: number | undefined;
}

/** How many sessions' tails are remembered; the least recently asked-for is forgotten first. */
export const TRANSCRIPT_TAIL_CACHE_CAPACITY = 256;
/** How many transcript tails are parsed at once across the whole daemon. */
export const TRANSCRIPT_TAIL_CONCURRENCY = 2;
/**
 * How long a tail verified under a live watch is answered without a `stat`. The watch is what keeps it
 * current; this bound is only the backstop for an event the platform lost, which inotify does only on a
 * queue overflow (reported to every watch) and FSEvents coalesces rather than drops. It is longer than
 * the slowest roster pass (the warden's 30 s) on purpose: a bound shorter than the asks re-stats every one.
 */
export const TRANSCRIPT_TAIL_TRUST_MS = 300_000;

const sameBytes = (a: TranscriptFingerprint, b: TranscriptFingerprint): boolean =>
  a.file === b.file && a.size === b.size && a.mtimeMs === b.mtimeMs;

/**
 * One daemon-wide memory of the transcript tails it has already parsed.
 *
 * THIS IS THE STALL A REAL FLEET HIT. Every session read, every roster listing — the warden's 30-second
 * liveness pass, the session monitor's 15-second question reconcile — asked
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
 * And, given a change feed, an idle fleet costs no `stat` at all: see {@link tail}.
 *
 * A read that fails is not remembered, so the next ask tries again.
 */
export class TranscriptTailCache {
  readonly #tails = new Map<string, CachedTail>();
  readonly #pending = new Map<string, PendingTail>();
  readonly #watched = new Map<string, WatchedTail>();
  readonly #waiting: Array<() => void> = [];
  #running = 0;

  constructor(
    private readonly capacity: number = TRANSCRIPT_TAIL_CACHE_CAPACITY,
    private readonly concurrency: number = TRANSCRIPT_TAIL_CONCURRENCY,
    private readonly watch?: TranscriptTailCacheEvents,
  ) {}

  /**
   * The newest `limit` events of the session `key` from `file`, re-validated on a file event instead of
   * on every ask.
   *
   * A remembered tail is answered WITHOUT a `stat` only when all of these hold: its file is watched and
   * the watch is live; a `stat` taken after the watch began matched it; no change event has arrived
   * since; and that match is younger than the trust bound. Anything else falls back to exactly what
   * {@link events} has always done — `fingerprint` (a `stat`) and a re-parse when the bytes differ — so
   * the fingerprint stays the correctness backstop and a platform without events behaves as before.
   * An unreadable fingerprint reads the transcript uncached.
   */
  async tail(
    key: string,
    file: string,
    limit: number,
    fingerprint: () => Promise<TranscriptFingerprint | undefined>,
    read: () => Promise<readonly TranscriptEvent[] | undefined>,
  ): Promise<readonly TranscriptEvent[] | undefined> {
    const watched = this.#watched.get(key);
    const cached = this.#tails.get(key);
    if (
      watched !== undefined &&
      cached !== undefined &&
      cached.fingerprint.file === file &&
      cached.limit >= limit &&
      this.#trusted(watched, file)
    ) {
      this.#tails.delete(key);
      this.#tails.set(key, cached);
      return cached.events.slice(-limit);
    }
    // Which change the `stat` below is taken after: only a watch that predates it can vouch for it.
    const before = watched?.file === file ? { watched, changes: watched.changes } : undefined;
    const current = await fingerprint();
    if (current === undefined) return await read();
    const events = await this.events(key, current, limit, read);
    this.#track(key, current, before);
    return events;
  }

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

  /** Stop watching every transcript. The remembered tails stay, answered by `stat` as before. */
  close(): void {
    for (const key of [...this.#watched.keys()]) this.#unwatch(key);
  }

  #trusted(watched: WatchedTail, file: string): boolean {
    return (
      this.watch !== undefined &&
      watched.file === file &&
      watched.verifiedAt !== undefined &&
      this.watch.now() - watched.verifiedAt < (this.watch.trustMs ?? TRANSCRIPT_TAIL_TRUST_MS) &&
      watched.subscription.live()
    );
  }

  /** After an ask: watch the remembered tail's file, and trust it if a post-watch `stat` matched it. */
  #track(
    key: string,
    fingerprint: TranscriptFingerprint,
    before: { readonly watched: WatchedTail; readonly changes: number } | undefined,
  ): void {
    if (this.watch === undefined) return;
    const remembered = this.#tails.get(key);
    if (remembered === undefined) {
      this.#unwatch(key);
      return;
    }
    const watched = this.#watched.get(key);
    if (watched === undefined || watched.file !== remembered.fingerprint.file) {
      this.#unwatch(key);
      const fresh: WatchedTail = {
        file: remembered.fingerprint.file,
        subscription: this.watch.changes.subscribe(remembered.fingerprint.file, () => {
          fresh.changes += 1;
          fresh.verifiedAt = undefined;
        }),
        changes: 0,
        verifiedAt: undefined,
      };
      this.#watched.set(key, fresh);
      return;
    }
    if (
      before?.watched === watched &&
      before.changes === watched.changes &&
      sameBytes(remembered.fingerprint, fingerprint) &&
      watched.subscription.live()
    )
      watched.verifiedAt = this.watch.now();
  }

  #unwatch(key: string): void {
    this.#watched.get(key)?.subscription.close();
    this.#watched.delete(key);
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
      this.#unwatch(oldest);
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
