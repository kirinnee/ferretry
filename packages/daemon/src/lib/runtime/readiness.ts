export type PidLiveness = 'alive' | 'dead' | 'absent';

export interface DaemonFetchPort {
  fetch(url: string, init: RequestInit): Promise<Response>;
}

export interface MillisecondClockPort {
  now(): number;
}

export interface SleepPort {
  sleep(milliseconds: number): Promise<void>;
}

export interface DaemonReadinessPorts extends MillisecondClockPort, SleepPort {
  health(): Promise<Record<string, unknown>>;
  pidLiveness(): Promise<PidLiveness>;
  progress?(elapsedSeconds: number): void;
}

export interface ReadinessPolicy {
  readonly deadlineMs: number;
  readonly cadenceMs: number;
  readonly progressAfterMs: number;
}

export interface ReadinessState {
  readonly startedAtMs: number;
  readonly sawAlive: boolean;
  readonly progressNoted: boolean;
}

export type ReadinessDecision =
  | { readonly kind: 'continue'; readonly state: ReadinessState }
  | { readonly kind: 'progress'; readonly elapsedSeconds: number; readonly state: ReadinessState }
  | { readonly kind: 'exited' }
  | { readonly kind: 'timeout' };

export const defaultReadinessPolicy = (): ReadinessPolicy => ({
  deadlineMs: 90_000,
  cadenceMs: 250,
  progressAfterMs: 10_000,
});

export function beginReadinessWait(startedAtMs: number): ReadinessState {
  return { startedAtMs, sawAlive: false, progressNoted: false };
}

/** Decides the next readiness action after a failed health probe. */
export function decideReadiness(
  state: ReadinessState,
  liveness: PidLiveness,
  nowMs: number,
  policy: ReadinessPolicy,
): ReadinessDecision {
  const elapsedMs = nowMs - state.startedAtMs;
  if (liveness === 'dead' && state.sawAlive) return { kind: 'exited' };
  if (elapsedMs >= policy.deadlineMs) return { kind: 'timeout' };

  const nextState = { ...state, sawAlive: state.sawAlive || liveness === 'alive' };
  if (!nextState.progressNoted && elapsedMs >= policy.progressAfterMs) {
    return {
      kind: 'progress',
      elapsedSeconds: Math.round(elapsedMs / 1_000),
      state: { ...nextState, progressNoted: true },
    };
  }
  return { kind: 'continue', state: nextState };
}
