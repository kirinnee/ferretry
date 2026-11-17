import type { FerretId, FerretRecord } from '../../../../contract/index.ts';
import {
  claimsRunningAgent,
  type ExitedSessionTransition,
  type SessionExitObservation,
} from '../../../lib/session/health/exit.ts';
import type { SessionExitPort } from '../../../lib/session/health/service.ts';

/** Today's word for a session at its prompt between turns: what decides that a revived ferret is not told "mid-turn". */
const BETWEEN_TURNS = 'awaiting_user';

/** What the boot exit pass reads and does, each through its one owner (W2-a). */
export interface BootExitFerrets {
  /** Every ferret the registry holds. */
  list(): readonly Pick<FerretRecord, 'id' | 'state' | 'handle'>[];
  /** The session document's status (`state.json`), or `undefined` when it has none or it cannot be read. */
  status(ferret: FerretId): Promise<string | undefined>;
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
  constructor(private readonly ferrets: BootExitFerrets) {}

  async observe(): Promise<readonly SessionExitObservation[]> {
    const observed: BootExitObservation[] = [];
    for (const record of this.ferrets.list()) {
      if (record.state !== 'working' && record.state !== 'idle') continue;
      const status = await this.ferrets.status(record.id).catch(() => undefined);
      if (!claimsRunningAgent(status) || status === undefined) continue;
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
