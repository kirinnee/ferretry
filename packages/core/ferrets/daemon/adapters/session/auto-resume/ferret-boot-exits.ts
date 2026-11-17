import type { FerretId, FerretRecord } from '../../../../contract/index.ts';
import {
  claimsRunningAgent,
  type ExitedSessionTransition,
  exitedSessionTransition,
  type SessionExitObservation,
} from '../../../lib/session/health/exit.ts';
import type { SessionExitPort } from '../../../lib/session/health/service.ts';

/** Today's word for a session at its prompt between turns: what decides that a revived ferret is not told "mid-turn". */
const BETWEEN_TURNS = 'awaiting_user';

/**
 * The statuses a ferret holds while the daemon has it PARKED between panes: `rate_limited` (on a usage limit), `retrying`
 * (a relaunch is being retried) and `kill_failed` (a stop that could not finish). The health port's
 * `claimsRunningAgent` leaves them out on purpose, because while the daemon lives each says something truer than "it
 * exited". After a host restart that reason is gone for `retrying` and `kill_failed`: their pane was lost with the
 * host, and v4 brought them back like any other. `rate_limited` is the exception: v4 NEVER took it at boot, because
 * its login is still limited (see {@link claimsBootAgent}). A converted v4 ferret still holds one of them in its state
 * document, so the boot pass counts them as claiming an agent, and ONLY the boot pass: nothing else in the daemon reads
 * them as running.
 */
const PARKED_STATUSES: ReadonlySet<string> = new Set(['rate_limited', 'retrying', 'kill_failed']);

/**
 * Whether a state document's status claims an agent the host restart took down: a running one, or a parked one.
 *
 * A `rate_limited` ferret claims one ONLY when its document names the reset time (`quota.retryAt`) and that time has
 * already passed: relaunching it earlier would land it straight back on the login that is still limited. While the reset
 * is in the future, or the document is at its limit with no reset time at all, it is left for the Warden's
 * `rate_limited` auto-move or the owner, as v4 did.
 */
export const claimsBootAgent = (
  status: string | undefined,
  retryAt: number | undefined,
  nowMs: number,
): status is string => {
  if (status === undefined) return false;
  if (status === 'rate_limited') return retryAt !== undefined && retryAt <= nowMs;
  return claimsRunningAgent(status) || PARKED_STATUSES.has(status);
};

/**
 * The status a ferret's state document says when it claims an agent the restart took down, else `undefined`: the ONE
 * reading the boot pass and the pass's sweep-first ferrets agree on.
 *
 * `afterSettle` is for a ferret something else already settled `terminal_gone`. That settle's stop edge rewrites a live
 * document to `stopped` (keeping its `quota`), so `stopped` is read as what it was, `running`, or as `rate_limited`
 * when the quota still says it is at its limit. A document an END had already moved (`completed`, `failed`,
 * `stalled`: the registry still said working when the pane was lost) is left as it was, and claims nothing.
 */
export async function bootClaim(
  ferrets: Pick<BootExitFerrets, 'status' | 'quota'>,
  ferret: FerretId,
  nowMs: number,
  afterSettle = false,
): Promise<string | undefined> {
  const status = await ferrets.status(ferret).catch(() => undefined);
  if (status === undefined) return undefined;
  const settledStop = afterSettle && status === 'stopped';
  if (status !== 'rate_limited' && !settledStop) return claimsBootAgent(status, undefined, nowMs) ? status : undefined;
  const quota = await ferrets.quota?.(ferret).catch(() => undefined);
  if (settledStop && quota?.atLimit !== true) return 'running';
  return claimsBootAgent('rate_limited', quota?.retryAt, nowMs) ? 'rate_limited' : undefined;
}

/**
 * The record a boot exit gets. A parked status is read as the running one it was before the pane was lost: the exit is
 * the same `gone`, and `exitedSessionTransition` (the health port's rule, which refuses a parked status) is left as it
 * is. The observation itself keeps the real status: it is what the journal's `from` and the revive's notice read.
 */
export function bootExitTransition(observation: SessionExitObservation): ExitedSessionTransition | undefined {
  return exitedSessionTransition(
    PARKED_STATUSES.has(observation.status) ? { ...observation, status: 'running' } : observation,
  );
}

/** What the boot exit pass reads and does, each through its one owner (W2-a). */
export interface BootExitFerrets {
  /** Every ferret the registry holds. */
  list(): readonly Pick<FerretRecord, 'id' | 'state' | 'handle'>[];
  /** The session document's status (`state.json`), or `undefined` when it has none or it cannot be read. */
  status(ferret: FerretId): Promise<string | undefined>;
  /**
   * The document's `quota`: whether it is at its limit and when the limited login resets (`retryAt`, epoch ms), or
   * `undefined` when it names none or cannot be read. Absent: no ferret names a reset time, so a `rate_limited` one is
   * never resumed at boot.
   */
  quota?(ferret: FerretId): Promise<{ readonly atLimit?: boolean; readonly retryAt?: number } | undefined>;
  /** Whether the runner PROVES the ferret's terminal gone (`Runner.gone`); false when it cannot prove it. */
  gone(ferret: FerretId): Promise<boolean>;
  /** The compare-and-set settle (`FerretsService.settleGone`): true only when it landed. */
  settle(
    ferret: FerretId,
    /** The handle the registry held when the exit was observed; `undefined` for a record that held none. */
    handle: string | undefined,
    exited: { readonly from: string; readonly reason: string },
  ): Promise<boolean>;
}

/**
 * What this pass observes: the legacy observation shape plus the registry's own handle, `undefined` for a record that
 * holds none. The observation's `registration.paneId` cannot say "no pane" (it is the legacy registration's string), so
 * the handle the settle compares travels beside it and is never read back from the registry later (a handle gained in
 * between is a relaunch, which the compare-and-set must see as a difference).
 */
interface BootExitObservation extends SessionExitObservation {
  readonly handle: string | undefined;
}

const isBootExit = (observation: SessionExitObservation): observation is BootExitObservation => 'handle' in observation;

/**
 * The exit part of today's FIRST self-check after boot, over 5.0's registry (W2-a): every ferret that still claims a
 * live agent (registry `working`/`idle` on a handle, and a session document whose status claims one, today's
 * `claimsRunningAgent`) and whose terminal the runner PROVES gone is observed `gone`. A record with NO handle (a converted
 * v4 ferret: a handle without proof of its pane is dropped) is observed all the same: the runner proves gone by the
 * ferret, not by the handle, and without this nothing could ever settle it. Nothing else is observed: a pane
 * tmux kept dead with an exit status is an agent that ended on its own and is left to the health port (GAP), and a
 * ferret still `starting` is a launch the restart interrupted, never an exit.
 *
 * Wrapped by today's `BootExitRecorder`, so the ferrets a settle here moved are exactly the auto-resume's candidates.
 * Nothing in it kills or launches anything: a verdict costs a write.
 */
export class FerretBootExits implements SessionExitPort {
  constructor(
    private readonly ferrets: BootExitFerrets,
    /** The clock a reset time is judged against. */
    private readonly nowMs: () => number,
  ) {}

  async observe(): Promise<readonly SessionExitObservation[]> {
    const observed: BootExitObservation[] = [];
    for (const record of this.ferrets.list()) {
      if (record.state !== 'working' && record.state !== 'idle') continue;
      const status = await bootClaim(this.ferrets, record.id, this.nowMs());
      if (status === undefined) continue;
      if (!(await this.ferrets.gone(record.id).catch(() => false))) continue;
      observed.push({
        id: record.id,
        // 5.0 keeps the turn on the registry, so a ferret between turns is told what today told an idle session.
        status: record.state === 'idle' ? BETWEEN_TURNS : status,
        // The settle compares `handle`, not this registration: the registry's handle is the one 5.0 keeps.
        handle: record.handle,
        registration: {
          daemonId: '',
          sessionId: record.id,
          tmuxSession: '',
          paneId: record.handle ?? '',
          pid: 0,
          processStartTicks: 0,
          sessionCreated: 0,
        },
        exit: { kind: 'gone' },
      });
    }
    return observed;
  }

  async settle(observation: SessionExitObservation, transition: ExitedSessionTransition): Promise<boolean> {
    if (observation.exit.kind !== 'gone' || transition.status !== 'failed' || !isBootExit(observation)) return false;
    return await this.ferrets.settle(observation.id as FerretId, observation.handle, {
      from: observation.status,
      reason: transition.reason,
    });
  }
}
