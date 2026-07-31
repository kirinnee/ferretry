/**
 * Readiness policy for `daemon start` / `restart` / `install`.
 *
 * kteam's original loop was a flat 40×250 ms = 10 s and could not tell "still coming up" from
 * "died": legitimate pre-bind cliffs exceed 10 s (a schema rebuild, or the bind retry riding out a
 * draining predecessor for up to 30 s), so a perfectly healthy slow boot reported "did not become
 * ready". This one waits up to ~90 s, keeps the happy-path cadence fast, notes progress once past
 * 10 s, and exits early with a distinct message when the daemon is observed to have died.
 *
 * The same decision table exists in `@ferretry/daemon`. It is duplicated here deliberately and
 * narrowly, because the plan's §4 ruling is that `packages/cli` imports `@ferretry/protocol` and
 * nothing else in this workspace — a shared "utils" package would recreate the coupling the split
 * exists to remove.
 */

/** What the supervisor can tell us about the daemon process while we wait for HTTP. */
export type DaemonLiveness = 'alive' | 'dead' | 'absent';

export interface ReadinessPolicy {
  readonly deadlineMs: number;
  readonly cadenceMs: number;
  readonly progressAfterMs: number;
}

export const defaultReadinessPolicy = (): ReadinessPolicy => ({
  deadlineMs: 90_000,
  cadenceMs: 250,
  progressAfterMs: 10_000,
});

export interface ReadinessState {
  readonly startedAtMs: number;
  /** Whether the process was ever seen alive during THIS wait. */
  readonly sawAlive: boolean;
  readonly progressNoted: boolean;
}

export type ReadinessDecision =
  | { readonly kind: 'continue'; readonly state: ReadinessState }
  | { readonly kind: 'progress'; readonly elapsedSeconds: number; readonly state: ReadinessState }
  | { readonly kind: 'exited' }
  | { readonly kind: 'timeout' };

export function beginReadinessWait(startedAtMs: number): ReadinessState {
  return { startedAtMs, sawAlive: false, progressNoted: false };
}

/**
 * Decides the next action after a health probe came back unready.
 *
 * Only fast-fails on a `dead` verdict AFTER the process was seen `alive` in this same wait: a `dead`
 * first probe is far more likely a supervisor that has not started the job yet, and presuming death
 * there turns every start into a spurious failure.
 */
export function decideReadiness(
  state: ReadinessState,
  liveness: DaemonLiveness,
  nowMs: number,
  policy: ReadinessPolicy,
): ReadinessDecision {
  const elapsedMs = nowMs - state.startedAtMs;
  if (liveness === 'dead' && state.sawAlive) return { kind: 'exited' };
  if (elapsedMs >= policy.deadlineMs) return { kind: 'timeout' };

  const advanced: ReadinessState = { ...state, sawAlive: state.sawAlive || liveness === 'alive' };
  if (!advanced.progressNoted && elapsedMs >= policy.progressAfterMs) {
    return {
      kind: 'progress',
      elapsedSeconds: Math.round(elapsedMs / 1_000),
      state: { ...advanced, progressNoted: true },
    };
  }
  return { kind: 'continue', state: advanced };
}

/** How long to give the daemon to release its address before a restart brings a new one up. */
export interface ShutdownPolicy {
  readonly deadlineMs: number;
  readonly cadenceMs: number;
  /** After this long a `SIGTERM` that produced nothing is escalated. */
  readonly escalateAfterMs: number;
}

export const defaultShutdownPolicy = (): ShutdownPolicy => ({
  deadlineMs: 20_000,
  cadenceMs: 100,
  escalateAfterMs: 10_000,
});

export type ShutdownDecision = 'wait' | 'escalate' | 'give-up';

/**
 * Decides how to keep pressing a stop.
 *
 * kteam's `restart` was `stop(); sleep(500); start()` — a fixed sleep is not a confirmation, so a
 * daemon that took longer than half a second to release its port met its own successor and the new
 * process died on `EADDRINUSE`. Here a restart waits for the address to actually go quiet.
 */
export function decideShutdown(elapsedMs: number, escalated: boolean, policy: ShutdownPolicy): ShutdownDecision {
  if (elapsedMs >= policy.deadlineMs) return 'give-up';
  if (!escalated && elapsedMs >= policy.escalateAfterMs) return 'escalate';
  return 'wait';
}
