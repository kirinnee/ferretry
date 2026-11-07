/**
 * Time, for the tunnel carrier: a timer it can cancel, and how long to wait after a failure.
 *
 * Ports rather than `setTimeout` and `Math.random`, so every retry decision in this domain is driven
 * by a test's own clock and its own dice rather than by waiting.
 */

/** One armed timer. Cancelling one that already fired is harmless. */
export interface ScheduledAction {
  cancel(): void;
}

export interface TunnelScheduler {
  after(milliseconds: number, action: () => void): ScheduledAction;
}

/** A capped exponential backoff. */
export interface BackoffPolicy {
  readonly baseMs: number;
  readonly capMs: number;
}

/**
 * The wait before retry number `attempt` (from 0): the exponential step, capped, with EQUAL JITTER —
 * half of it fixed and half random — so a fleet of daemons refused by one outage does not retry in
 * lockstep, and no retry is ever sooner than half its step.
 */
export function backoffDelayMs(policy: BackoffPolicy, attempt: number, random: () => number): number {
  const step = Math.min(policy.capMs, policy.baseMs * 2 ** Math.min(attempt, 30));
  return Math.round(step / 2 + (step / 2) * random());
}

/** A duration as a reader wants it in a boot line: whole seconds, never "0s". */
export function secondsPhrase(milliseconds: number): string {
  return `${String(Math.max(1, Math.round(milliseconds / 1_000)))}s`;
}
