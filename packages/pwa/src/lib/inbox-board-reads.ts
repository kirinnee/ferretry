/**
 * WHICH OF THE INBOX'S BOARDS COULD NOT BE READ.
 *
 * The inbox reads one board per conversation that has something open, keyed on its summary: a moved summary
 * reads it again, a still one reads nothing. That keying used to be all there was, so a read that FAILED — a
 * machine that stopped answering while its session list stayed on screen from the cache, a relay that dropped
 * the request, a board the daemon refused — was never asked again until the summary moved, and a machine that is
 * down never moves its summary. Its conversations stayed "not read yet" for good: the Inbox said "Updating"
 * forever, and every badge counted their items while the page listed none of them.
 *
 * So a board whose read settles without it is FAILED here: said as such (its machine's own line, not a spinner)
 * and asked again on a backoff. A retry is quiet — a failed board stays failed until a read lands — so a machine
 * that is down does not flash "Updating" every few seconds. Everything else is the agenda store's to say: a board
 * it holds is read, and one it does not hold and that has not failed is still on its first read.
 */

import type { DeferredTimers } from './agenda-inbox.ts';

/** One board the inbox wants held: its identity, the summary it is wanted for, and how to read it. */
export interface InboxBoardWant {
  /** The board's daemon-scoped key (`daemonSessionKey`). */
  readonly id: string;
  /** The summary it is wanted for: a different one reads the board again. */
  readonly key: string;
  /** Reads the board into the agenda store. How it settles says nothing: `held` is asked afterwards. */
  readonly read: () => Promise<void>;
  /** Whether the agenda store holds this board now. */
  readonly held: () => boolean;
}

/** The first retry of a failed board; each one after waits twice as long, up to {@link RETRY_MAX_MS}. */
export const RETRY_FIRST_MS = 15_000;
export const RETRY_MAX_MS = 5 * 60_000;

/** How long the retry after `failures` failed reads in a row (at least one) waits. */
export const retryDelay = (failures: number): number => Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** (failures - 1));

interface Tracked {
  readonly want: InboxBoardWant;
  /** Moves with every read started for this board: a settlement from an older one is ignored. */
  readonly run: number;
  /** Reads in a row that settled without the board. */
  readonly failures: number;
  readonly retry: unknown;
}

const NONE: ReadonlySet<string> = new Set();

export class InboxBoardReads {
  readonly #tracked = new Map<string, Tracked>();
  readonly #listeners = new Set<() => void>();
  #failed: ReadonlySet<string> = NONE;
  #runs = 0;

  constructor(private readonly timers: DeferredTimers) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** The boards whose last read settled without them. Identity-stable while that set holds still. */
  readonly getSnapshot = (): ReadonlySet<string> => this.#failed;

  /**
   * Makes the wanted boards the tracked ones: a board wanted for a summary it was not read for is read now, and
   * one no longer wanted is forgotten, its retry cancelled. A board listed twice is read once. A board that had
   * failed stays failed through a new read until one lands.
   */
  sync(wants: readonly InboxBoardWant[]): void {
    const seen = new Set<string>();
    for (const want of wants) {
      if (seen.has(want.id)) continue;
      seen.add(want.id);
      const tracked = this.#tracked.get(want.id);
      if (tracked?.want.key === want.key) continue;
      if (tracked !== undefined) this.#cancel(tracked);
      this.#start(want, tracked?.failures ?? 0);
    }
    for (const [id, tracked] of [...this.#tracked]) {
      if (seen.has(id)) continue;
      this.#cancel(tracked);
      this.#tracked.delete(id);
    }
    this.#publish();
  }

  /** Cancels every retry and forgets every board: the next `sync` reads them all afresh. */
  dispose(): void {
    for (const tracked of this.#tracked.values()) this.#cancel(tracked);
    this.#tracked.clear();
    this.#publish();
  }

  #start(want: InboxBoardWant, failures: number): void {
    this.#runs += 1;
    const run = this.#runs;
    this.#tracked.set(want.id, { want, run, failures, retry: undefined });
    void want
      .read()
      .catch(() => undefined)
      .then(() => this.#settled(want.id, run));
  }

  #settled(id: string, run: number): void {
    const tracked = this.#tracked.get(id);
    if (tracked?.run !== run) return;
    if (tracked.want.held()) {
      this.#tracked.set(id, { ...tracked, failures: 0 });
    } else {
      const failures = tracked.failures + 1;
      const retry = this.timers.setTimeout(() => {
        if (this.#tracked.get(id)?.run !== run) return;
        this.#start(tracked.want, failures);
      }, retryDelay(failures));
      this.#tracked.set(id, { ...tracked, failures, retry });
    }
    this.#publish();
  }

  #cancel(tracked: Tracked): void {
    if (tracked.retry !== undefined) this.timers.clearTimeout(tracked.retry);
  }

  #publish(): void {
    const failed = [...this.#tracked].filter(([, tracked]) => tracked.failures > 0).map(([id]) => id);
    if (failed.length === this.#failed.size && failed.every(id => this.#failed.has(id))) return;
    this.#failed = failed.length === 0 ? NONE : new Set(failed);
    for (const listener of [...this.#listeners]) listener();
  }
}
