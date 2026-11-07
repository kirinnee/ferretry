import type { SessionHealthSettings } from './settings.ts';
import { classifyWardenSweep } from './sweep.ts';
import type {
  SelfCheckLedger,
  SelfCheckTick,
  SelfCheckVerdict,
  SessionHealthEvent,
  SessionHealthObservation,
  WardenSweepObservation,
  WardenSweepVerdict,
} from './types.ts';
import { recordSelfCheckTick, wedgeEvent } from './wedge.ts';

/** The sweep facts, minus the clock reading the self-check already holds. */
export type WardenSweepInput = Omit<WardenSweepObservation, 'nowMs'>;

export interface SelfCheckInput {
  readonly tick: SelfCheckTick;
  /** Wall milliseconds, used only to age durable timestamps — never to measure the timer gap. */
  readonly nowMs: number;
  readonly sessions: readonly SessionHealthObservation[];
  readonly sweep: WardenSweepInput;
  readonly bootstrapErrors: readonly string[];
  /**
   * Whether this daemon runs per-session monitors at all. A repair the daemon cannot perform must
   * not be planned: it would be attempted, fail, and be re-planned on every tick forever. The flag
   * is the honest alternative to reporting an unmonitored session as monitored.
   */
  readonly supervisesMonitors: boolean;
  /** Whether this daemon arms a warden sweep timer. Same reasoning as `supervisesMonitors`. */
  readonly supervisesWarden: boolean;
}

export interface SelfCheckPlan {
  readonly verdict: SelfCheckVerdict;
  readonly sweep: WardenSweepVerdict;
  /** Whether the consistency pass must verify everything rather than only compare membership. */
  readonly deepPass: boolean;
  /** Live sessions with no monitor, in the order observed. Repairing one is safe and idempotent. */
  readonly startMonitors: readonly string[];
  readonly rearmWarden: boolean;
  readonly events: readonly SessionHealthEvent[];
}

/**
 * Whether a session's absent monitor is still explained by a launch in flight.
 *
 * A launch stamp grants amnesty from repair, so it has to expire: one hung tmux command holding the
 * bootstrap chain would otherwise hide its session from repair for the daemon's whole life. A stamp
 * dated in the future grants nothing — it is evidence of a broken clock, not of a live launch, and
 * repair is the safe direction when the evidence is unusable.
 */
export function launchingRecently(
  launchingSinceMs: number | undefined,
  nowMs: number,
  settings: SessionHealthSettings,
): boolean {
  if (launchingSinceMs === undefined || !Number.isFinite(launchingSinceMs) || !Number.isFinite(nowMs)) return false;
  const age = nowMs - launchingSinceMs;
  return age >= 0 && age <= settings.launchGraceMs;
}

/**
 * Decides what one self-check tick must do, without doing any of it.
 *
 * The two failures this catches are the silent-partial-boot shape — live sessions whose monitor was
 * never started, so nothing observes them — and a warden whose sweep stopped happening. Both look
 * identical to a healthy daemon from the outside, which is why they need a tick that measures its
 * own lateness rather than trusting that it ran.
 */
export function planSelfCheck(
  ledger: SelfCheckLedger,
  input: SelfCheckInput,
  settings: SessionHealthSettings,
): { readonly ledger: SelfCheckLedger; readonly plan: SelfCheckPlan } {
  const recorded = recordSelfCheckTick(ledger, input.tick, settings);
  const sweep = classifyWardenSweep({ ...input.sweep, nowMs: input.nowMs }, settings);
  const monitored = input.sessions.filter(session => session.monitored).length;
  const startMonitors = !input.supervisesMonitors
    ? []
    : input.sessions
        .filter(
          session =>
            !session.terminal &&
            !session.monitored &&
            !launchingRecently(session.launchingSinceMs, input.nowMs, settings),
        )
        .map(session => session.id);
  const rearmWarden = input.supervisesWarden && sweep.needsRearm;
  const wedge = wedgeEvent(recorded.verdict, monitored);
  const failed: readonly SessionHealthEvent[] =
    startMonitors.length === 0 && !rearmWarden
      ? []
      : [
          {
            type: 'fleet.self_check_failed',
            data: {
              unmonitoredRunning: startMonitors,
              wardenSweepState: sweep.state,
              wardenTimerArmed: input.sweep.timerArmed,
              ...(input.sweep.lastSweepAt === undefined ? {} : { wardenLastSweepAt: input.sweep.lastSweepAt }),
              bootstrapErrors: input.bootstrapErrors.length,
            },
          },
        ];
  return {
    ledger: recorded.ledger,
    plan: {
      verdict: recorded.verdict,
      sweep,
      deepPass: recorded.verdict.deepPass,
      startMonitors,
      rearmWarden,
      events: [...(wedge === undefined ? [] : [wedge]), ...failed],
    },
  };
}
