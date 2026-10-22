import type { SessionId } from '../../session-id.ts';
import type { LivenessSample } from '../../warden/liveness.ts';
import type { LivenessTarget } from '../../warden/liveness-monitor.ts';
import type { TurnWatchLoop } from '../turn/service.ts';

/**
 * WHERE THE SESSION OBSERVER RUNS — the port the composition root's existing timers drive.
 *
 * Stage 3a ships one host, `InlineObserverHost`: the observer on the main thread, on the timers that
 * already exist (the 2 s turn tick, the 15 s monitor question pass, the 30 s liveness tick). Stage 3b
 * adds `WorkerObserverHost`, the same fold on a per-session worker thread; it drops in here and nothing
 * that drives a host changes. Every method is total: a look that fails is reported, never thrown into a
 * timer.
 */
export interface SessionObserverHost {
  /** The turn part, as the 2 s turn tick runs it. */
  readonly turns: TurnWatchLoop;
  /**
   * The question part for one session, now: the read path's "what the transcript says is in the
   * document I return". Rejects only when the session's evidence could not be projected.
   */
  project(id: SessionId): Promise<void>;
  /** The question part for every live session, as the monitor's pass runs it: failures by session. */
  questions(): Promise<ReadonlyMap<string, string>>;
  /** The liveness sample for one working ferret, as the Warden's liveness tick takes it. */
  liveness(target: LivenessTarget): Promise<LivenessSample>;
  /** How many sessions the observer last saw mid-turn — what an update waits out. */
  midTurn(): Promise<number>;
  /** Ends whatever the host started (worker threads); the timers that drive it are the root's to stop. */
  close(): void;
}
