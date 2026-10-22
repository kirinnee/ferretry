/**
 * WHEN A HOUSEKEEPING PASS RUNS, NOW THAT ITS INPUTS ARRIVE AS EVENTS.
 *
 * Analytics ingestion, the terminal reaper and their siblings each ran on a fixed timer — once a
 * minute, every five seconds — whether or not anything they read had changed. The events that DO change
 * their answer (a session reaching a terminal state, a pricing edit, a pass that left work over) now say
 * so with {@link PassTrigger.nudge}, and the pass runs soon after: one pass for a burst of events,
 * because the earliest nudge already armed stands and a later one joins it.
 *
 * ONE SLOW BACKSTOP REMAINS, and it is named rather than hidden. Some inputs have no event this daemon
 * can hear — a document edited behind its back, a refusal that only time clears, a session directory
 * removed by hand — so a pass also runs at most {@link PassTriggerOptions.backstopMs} after the last
 * one, whatever happened. That cadence is what a profile's limitations name for this pass.
 *
 * ONE TIMER, the earlier of the two deadlines. Nothing here runs the pass itself: `due` is told it is
 * time, and the composition root decides where the pass runs (the housekeeping lane).
 */

/** The one-shot timers a trigger arms, injected so a test fires them by hand. */
export interface PassTriggerTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface PassTriggerOptions {
  /** The slow backstop: a pass at most this long after the last one, events or none. */
  readonly backstopMs: number;
  readonly timers: PassTriggerTimers;
  /** Monotonic milliseconds, for comparing deadlines. */
  readonly now: () => number;
}

export class PassTrigger {
  #due: (() => void) | undefined;
  #handle: unknown;
  /** When the armed timer fires, by {@link PassTriggerOptions.now}. */
  #at: number | undefined;
  /** The earliest nudge heard before arming, kept so it is not lost to the boot order. */
  #early: number | undefined;

  constructor(private readonly options: PassTriggerOptions) {}

  /**
   * Starts telling `due` when a pass is due: on the earliest nudge heard so far, else one backstop from
   * now. Answers the disarm, after which nothing fires and a nudge is ignored.
   */
  arm(due: () => void): () => void {
    this.#due = due;
    const early = this.#early;
    this.#early = undefined;
    this.#schedule(early ?? this.options.now() + this.options.backstopMs);
    return () => {
      this.#due = undefined;
      this.#clear();
    };
  }

  /**
   * A pass is wanted within `withinMs`. An earlier pass already armed stands; a later one is brought
   * forward. Heard before {@link arm}, it is kept for the arming.
   */
  nudge(withinMs: number): void {
    const at = this.options.now() + Math.max(0, withinMs);
    if (this.#due === undefined) {
      this.#early = this.#early === undefined ? at : Math.min(this.#early, at);
      return;
    }
    if (this.#at === undefined || at < this.#at) this.#schedule(at);
  }

  #fire(): void {
    this.#handle = undefined;
    this.#at = undefined;
    const due = this.#due;
    if (due === undefined) return;
    // The backstop counts from this pass, so it is armed before `due` runs and may nudge again.
    this.#schedule(this.options.now() + this.options.backstopMs);
    due();
  }

  #schedule(at: number): void {
    this.#clear();
    this.#at = at;
    this.#handle = this.options.timers.setTimeout(() => this.#fire(), Math.max(0, at - this.options.now()));
  }

  #clear(): void {
    if (this.#handle !== undefined) this.options.timers.clearTimeout(this.#handle);
    this.#handle = undefined;
    this.#at = undefined;
  }
}
