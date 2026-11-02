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
 *
 * A FAILED BOARD SAYS WHY, in one short clause: "Couldn't read 3 items" alone sent the owner to a machine whose
 * daemon answered every other request in a second, when the boards were in fact refused with a 500 for a file
 * the daemon could not read. The clause is the last failed read's, so a board that fails differently says so.
 */

import type { DeferredTimers } from './agenda-inbox.ts';
import { MachineDeadlineError } from './machine-deadline.ts';
import { DaemonResponseError } from './runtime-models.ts';

/**
 * Why a board's last read settled without it. `unsettled` is a read that ended without an error — the machine
 * was unpaired or paired again while it ran — and has nothing to say beyond "Couldn't read".
 */
export type BoardReadFailure =
  | 'error'
  | 'refused'
  | 'not-found'
  | 'timed-out'
  | 'unexpected'
  | 'no-answer'
  | 'unsettled';

/** What each failure says after "Couldn't read N items on <machine> —"; `unsettled` says nothing more. */
export const BOARD_READ_FAILURE_WORDS: Readonly<Record<BoardReadFailure, string | undefined>> = {
  error: 'the machine hit an error',
  refused: 'refused',
  'not-found': 'not found',
  'timed-out': 'timed out',
  unexpected: 'unexpected answer',
  'no-answer': 'no answer',
  unsettled: undefined,
};

/** The failure a read's rejection is: the machine's own status when it answered, else how it did not. */
export const boardReadFailure = (cause: unknown): BoardReadFailure => {
  if (cause instanceof DaemonResponseError) {
    if (cause.status >= 500) return 'error';
    if (cause.status === 401 || cause.status === 403) return 'refused';
    return cause.status === 404 ? 'not-found' : 'unexpected';
  }
  if (cause instanceof MachineDeadlineError || (cause instanceof Error && cause.name === 'TimeoutError'))
    return 'timed-out';
  // The board's schema refused what the machine sent: it answered, with something this app cannot read.
  return cause instanceof Error && cause.name === 'ZodError' ? 'unexpected' : 'no-answer';
};

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
  /** Why the last of them did; kept through a retry, so a board stays said the same way until a read lands. */
  readonly failure?: BoardReadFailure;
  readonly retry: unknown;
}

const NONE: ReadonlyMap<string, BoardReadFailure> = new Map();

export class InboxBoardReads {
  readonly #tracked = new Map<string, Tracked>();
  readonly #listeners = new Set<() => void>();
  #failed: ReadonlyMap<string, BoardReadFailure> = NONE;
  #runs = 0;

  constructor(private readonly timers: DeferredTimers) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** The boards whose last read settled without them, and why. Identity-stable while that map holds still. */
  readonly getSnapshot = (): ReadonlyMap<string, BoardReadFailure> => this.#failed;

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
      this.#start(want, tracked?.failures ?? 0, tracked?.failure);
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

  #start(want: InboxBoardWant, failures: number, failure: BoardReadFailure | undefined): void {
    this.#runs += 1;
    const run = this.#runs;
    this.#tracked.set(want.id, {
      want,
      run,
      failures,
      ...(failure === undefined ? {} : { failure }),
      retry: undefined,
    });
    void want.read().then(
      () => this.#settled(want.id, run, 'unsettled'),
      (cause: unknown) => this.#settled(want.id, run, boardReadFailure(cause)),
    );
  }

  #settled(id: string, run: number, failure: BoardReadFailure): void {
    const tracked = this.#tracked.get(id);
    if (tracked?.run !== run) return;
    if (tracked.want.held()) {
      const { failure: _failure, ...rest } = tracked;
      this.#tracked.set(id, { ...rest, failures: 0 });
    } else {
      const failures = tracked.failures + 1;
      // A read that only ended says nothing, so it never overwrites a reason an earlier read gave.
      const said = failure === 'unsettled' ? (tracked.failure ?? failure) : failure;
      const retry = this.timers.setTimeout(() => {
        if (this.#tracked.get(id)?.run !== run) return;
        this.#start(tracked.want, failures, said);
      }, retryDelay(failures));
      this.#tracked.set(id, { ...tracked, failures, failure: said, retry });
    }
    this.#publish();
  }

  #cancel(tracked: Tracked): void {
    if (tracked.retry !== undefined) this.timers.clearTimeout(tracked.retry);
  }

  #publish(): void {
    const failed = [...this.#tracked].flatMap(([id, tracked]): [string, BoardReadFailure][] =>
      tracked.failures > 0 && tracked.failure !== undefined ? [[id, tracked.failure]] : [],
    );
    if (failed.length === this.#failed.size && failed.every(([id, failure]) => this.#failed.get(id) === failure))
      return;
    this.#failed = failed.length === 0 ? NONE : new Map(failed);
    for (const listener of [...this.#listeners]) listener();
  }
}
