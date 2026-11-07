import type { SelfCheckLedger, SessionHealthObservation, WardenSweepVerdict } from './types.ts';

export type BootstrapState = 'running' | 'degraded' | 'complete';

export interface DaemonHealthInput {
  readonly bootstrapFinished: boolean;
  readonly bootstrapErrors: readonly string[];
  readonly sessions: readonly SessionHealthObservation[];
  readonly ledger: SelfCheckLedger;
  readonly sweep: WardenSweepVerdict;
  readonly version: string;
  readonly at: string;
  /** Whether this daemon runs per-session monitors; see `SelfCheckInput.supervisesMonitors`. */
  readonly supervisesMonitors: boolean;
  /** Whether this daemon arms a warden sweep timer. */
  readonly supervisesWarden: boolean;
}

export interface DaemonHealthReport {
  readonly ok: boolean;
  readonly bootstrapping: boolean;
  readonly bootstrapState: BootstrapState;
  readonly version: string;
  readonly sessions: number;
  readonly running: number;
  readonly monitors: number;
  readonly unmonitoredRunning: number;
  readonly supervisesMonitors: boolean;
  readonly supervisesWarden: boolean;
  readonly wardenSweepState: WardenSweepVerdict['state'];
  readonly wardenSweepAgeSeconds: number | null;
  readonly selfCheckFreshness: SelfCheckLedger['lastFreshness'];
  readonly selfChecks: number;
  readonly eventLoopLagMs: number;
  readonly lastSelfCheckAt: string | null;
  readonly wedgeCount: number;
  readonly bootstrapErrors: number;
  readonly bootstrapErrorMessages?: readonly string[];
  readonly time: string;
}

/** How many bootstrap error messages a health response carries before it just reports the count. */
const BOOTSTRAP_ERROR_SAMPLE = 10;

/**
 * The daemon's own health, as an operator and a monitoring system both read it.
 *
 * `ok` is current serviceability, not history: a bootstrap that failed and was then repaired must
 * stop condemning the fleet, which is why the errors stay visible below without holding `ok` down.
 *
 * What `ok` gained over the ancestor is the two supervision facts. That version answered
 * `bootstrapFinished && no unmonitored sessions && warden timer armed` — so a daemon whose timer was
 * armed but whose sweeps had stopped, or whose event loop had just been starved for minutes,
 * reported a clean bill of health. An armed timer is not evidence that anything swept, so the sweep
 * VERDICT is used instead, and a self-check that could not prove it ran on time disqualifies too.
 */
export function buildDaemonHealthReport(input: DaemonHealthInput): DaemonHealthReport {
  const running = input.sessions.filter(session => !session.terminal);
  const monitors = input.sessions.filter(session => session.monitored).length;
  const unmonitoredRunning = running.filter(session => !session.monitored).length;
  const bootstrapState: BootstrapState = !input.bootstrapFinished
    ? 'running'
    : input.bootstrapErrors.length > 0
      ? 'degraded'
      : 'complete';
  // A subsystem this daemon does not run cannot be unhealthy. Gating `ok` on it would report a
  // permanent outage for a capability that has simply not been mounted yet.
  const supervising = !input.supervisesWarden || input.sweep.state === 'fresh' || input.sweep.state === 'within-grace';
  const monitorsHealthy = !input.supervisesMonitors || unmonitoredRunning === 0;
  // An absent verdict is boot, not a fault: the first tick has simply not fired yet, and
  // `bootstrapping` already says so. Only a tick that ran and could not prove itself disqualifies.
  const selfCheckHealthy = input.ledger.lastFreshness !== 'wedged' && input.ledger.lastFreshness !== 'unknown';
  return {
    ok: input.bootstrapFinished && monitorsHealthy && supervising && selfCheckHealthy,
    bootstrapping: !input.bootstrapFinished,
    bootstrapState,
    version: input.version,
    sessions: input.sessions.length,
    running: running.length,
    monitors,
    unmonitoredRunning,
    supervisesMonitors: input.supervisesMonitors,
    supervisesWarden: input.supervisesWarden,
    wardenSweepState: input.sweep.state,
    wardenSweepAgeSeconds: input.sweep.ageMs === undefined ? null : Math.floor(input.sweep.ageMs / 1000),
    selfCheckFreshness: input.ledger.lastFreshness,
    selfChecks: input.ledger.ticks,
    eventLoopLagMs: input.ledger.eventLoopLagMs,
    lastSelfCheckAt: input.ledger.lastAt ?? null,
    wedgeCount: input.ledger.wedges,
    bootstrapErrors: input.bootstrapErrors.length,
    ...(input.bootstrapErrors.length > 0
      ? { bootstrapErrorMessages: input.bootstrapErrors.slice(0, BOOTSTRAP_ERROR_SAMPLE) }
      : {}),
    time: input.at,
  };
}
