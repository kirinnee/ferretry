/** A session's lease, its renewal lead and its cap, in milliseconds. */
export interface LeaseTimings {
  readonly leaseMs: number;
  readonly renewLeadMs: number;
  readonly maxSessionMs: number;
}

/** The daemon's time-bound rules (`kernel.timings`). */
export interface DaemonTimings {
  readonly lease: LeaseTimings;
  /** How long one idle day is: the unit `idleExpiryDays` counts in. */
  readonly idleDayMs: number;
}
