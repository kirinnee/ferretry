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
    handle: string,
    exited: { readonly from: string; readonly reason: string },
  ): Promise<boolean>;
}

/**
 * The exit part of today's FIRST self-check after boot, over 5.0's registry (W2-a): every ferret that still claims a
 * live agent (registry `working`/`idle` on a handle, and a session document whose status claims one, today's
 * `claimsRunningAgent`) and whose terminal the runner PROVES gone is observed `gone`. Nothing else is observed: a pane
 * tmux kept dead with an exit status is an agent that ended on its own and is left to the health port (GAP), and a
 * ferret still `starting` is a launch the restart interrupted, never an exit.
 *
 * Wrapped by today's `BootExitRecorder`, so the ferrets a settle here moved are exactly the auto-resume's candidates.
 * Nothing in it kills or launches anything: a verdict costs a write.
 */
export class FerretBootExits implements SessionExitPort {
  constructor(private readonly ferrets: BootExitFerrets) {}

  async observe(): Promise<readonly SessionExitObservation[]> {
    const observed: SessionExitObservation[] = [];
    for (const record of this.ferrets.list()) {
      if ((record.state !== 'working' && record.state !== 'idle') || record.handle === undefined) continue;
      const status = await this.ferrets.status(record.id).catch(() => undefined);
      if (!claimsRunningAgent(status) || status === undefined) continue;
      if (!(await this.ferrets.gone(record.id).catch(() => false))) continue;
      observed.push({
        id: record.id,
        // 5.0 keeps the turn on the registry, so a ferret between turns is told what today told an idle session.
        status: record.state === 'idle' ? BETWEEN_TURNS : status,
        // Only the pane id is compared by the settle: the registry's handle is the one registration 5.0 keeps.
        registration: {
          daemonId: '',
          sessionId: record.id,
          tmuxSession: '',
          paneId: record.handle,
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
    if (observation.exit.kind !== 'gone' || transition.status !== 'failed') return false;
    return await this.ferrets.settle(observation.id as FerretId, observation.registration.paneId, {
      from: observation.status,
      reason: transition.reason,
    });
  }
}
