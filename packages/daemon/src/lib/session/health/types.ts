import { z } from 'zod';

/**
 * Elapsed time from a source that cannot move backwards.
 *
 * Health detection measures how late a timer was, which is a DURATION, not a pair of dates. Reading
 * it off the wall clock — as the source did — makes an NTP step or a laptop suspend indistinguishable
 * from a starved event loop: a forward step fabricates a wedge and disturbs a healthy fleet, and a
 * backward step hides a real one. Wall-clock instants are still recorded, but only for reporting.
 */
export interface MonotonicClockPort {
  /** Milliseconds since an arbitrary fixed origin. Only differences are meaningful. */
  elapsedMs(): number;
}

/** One firing of the self-check timer: a monotonic reading for the gap, a wall instant to report. */
export interface SelfCheckTick {
  readonly elapsedMs: number;
  readonly at: string;
}

/**
 * `unknown` is a first-class outcome, not an error case. When the gap cannot be established the
 * daemon has NOT been shown to be current, and treating that as `fresh` is how a wedged fleet
 * reports all-clear — the defect the warden unit already found in this codebase's ancestor.
 */
export type SelfCheckFreshness = 'first-tick' | 'fresh' | 'unknown' | 'wedged';

export interface SelfCheckVerdict {
  readonly freshness: SelfCheckFreshness;
  /** Undefined whenever the gap could not be established; never a fabricated zero. */
  readonly gapMs: number | undefined;
  /** How much of the gap exceeded the expected cadence. Zero when the gap is unknown. */
  readonly lagMs: number;
  /**
   * Whether this tick must run the deep consistency pass. True for anything but a proven-fresh
   * tick: nothing the daemon believes about the fleet survives an unverified gap.
   */
  readonly deepPass: boolean;
  /** Wall instant the gap began, for the operator-facing event. Undefined with an unknown gap. */
  readonly since: string | undefined;
}

/**
 * Self-check history as a value. It is threaded through `recordSelfCheckTick` rather than held in a
 * field so nothing in `lib` owns mutable state and a test can replay any history it likes.
 */
export interface SelfCheckLedger {
  readonly ticks: number;
  readonly wedges: number;
  readonly lastElapsedMs: number | undefined;
  readonly lastAt: string | undefined;
  readonly lastFreshness: SelfCheckFreshness | undefined;
  readonly eventLoopLagMs: number;
}

/** What the daemon can observe about the warden's sweep timer. */
export interface WardenSweepObservation {
  readonly timerArmed: boolean;
  /** ISO instant of the last completed sweep, as persisted. Absent before the first one. */
  readonly lastSweepAt?: string | undefined;
  /** Wall milliseconds at which the timer was armed; the deadline runs from here before a sweep. */
  readonly armedAtMs?: number | undefined;
  readonly nowMs: number;
  readonly intervalMs: number;
}

export type WardenSweepState = 'fresh' | 'within-grace' | 'stale' | 'timer-dead' | 'unknown';

export interface WardenSweepVerdict {
  readonly state: WardenSweepState;
  /** True whenever the warden must be re-armed — including every state that cannot prove freshness. */
  readonly needsRearm: boolean;
  /** Age of the evidence used, in milliseconds. Undefined when there was none to age. */
  readonly ageMs: number | undefined;
  readonly deadlineMs: number;
}

/** One session as the self-check sees it, with no notion of how any of it was obtained. */
export interface SessionHealthObservation {
  readonly id: string;
  /** True once the session has reached a status from which it will never run again. */
  readonly terminal: boolean;
  readonly monitored: boolean;
  /** Wall milliseconds at which an in-flight launch was registered, if one is. */
  readonly launchingSinceMs?: number | undefined;
}

/** A journal event this slice asks the caller to append. `lib` never writes one itself. */
export interface SessionHealthEvent {
  readonly type:
    | 'fleet.daemon_wedge'
    | 'fleet.self_check_failed'
    | 'fleet.index_incoherent'
    | 'fleet.daemon_self_restart';
  readonly data: Readonly<Record<string, unknown>>;
}

/** Consistency-pass history as a value, for the same reason as the self-check ledger. */
export interface IncoherenceLedger {
  readonly consecutive: number;
}

/** What one consistency pass found, after it tried to repair. */
export interface IncoherencePass {
  readonly missingFromIndex: readonly string[];
  readonly staleRows: readonly string[];
  readonly zombies: readonly string[];
  readonly repaired: readonly string[];
  /** On disk but still invisible to the index or unreadable AFTER repair. */
  readonly unhealable: readonly string[];
}

export const SelfRestartStampSchema = z.object({
  at: z.iso.datetime({ offset: true }),
  sessions: z.array(z.string().min(1)).default([]),
});
export type SelfRestartStamp = z.infer<typeof SelfRestartStampSchema>;

/**
 * The durable cooldown record. It has to outlive the process — its whole purpose is stopping a
 * daemon that cannot fix itself from restarting every few minutes forever.
 */
export interface SelfRestartStampStore {
  /** Undefined when absent; the store must not invent a stamp it could not read. */
  read(): Promise<SelfRestartStamp | undefined>;
  write(stamp: SelfRestartStamp): Promise<void>;
  clear(): Promise<void>;
}

/** Asks the entrypoint for a clean restart. Resolves false when nothing would re-spawn the daemon. */
export interface SelfRestartHandler {
  restart(): Promise<boolean>;
}
