import type { Log } from '@ferretry/kernel/contract';
import type { FerretId, FerretRecord } from '../../contract/index.ts';
import type { SerialExecutor } from '../lib/ports.ts';
import { type SessionId } from '../lib/session-id.ts';
import {
  INTERRUPTED_LAUNCH_REASON,
  type InterruptedLaunchOutcome,
  InterruptedLaunchReconciler,
  type LaunchGate,
  type PaneObservation,
  type ResumeRepository,
} from '../lib/session/resume/index.ts';

/** The job that settles the launches a host restart interrupted (once the daemon serves). */
export const INTERRUPTED_LAUNCH_JOB = 'ferrets.interrupted-launches';

/** The journal event a ferret's history says its interrupted launch with (the notice a restart owes the person). */
const INTERRUPTED_LAUNCH_EVENT = 'session.launch_interrupted';

/** The most launches one pass records failed: the rest wait for the next boot's pass. */
const INTERRUPTED_LAUNCH_PASS_CAP = 25;

/** What the pass stands on, each through its one owner. */
interface InterruptedLaunchesDeps {
  readonly repository: Pick<ResumeRepository, 'list' | 'read' | 'transition'>;
  /** The ONE per-session queue every start, stop and resume takes (`SessionFiles.serial`). */
  readonly serial: Pick<SerialExecutor, 'run'>;
  /** The in-memory launch gate the session lifecycle registers its launches in. */
  readonly gate: Pick<LaunchGate, 'launching'>;
  /** The registry's record of a ferret: its last state change is what tells this process's launches from a dead one's. */
  readonly record: (ferret: FerretId) => Pick<FerretRecord, 'stateAt'> | undefined;
  /** When this process booted: a record that changed state at or after it was changed by THIS process. */
  readonly bootedAtMs: number;
  /**
   * Whether the runner PROVES the ferret's terminal is not there (`Runner.gone`); `undefined` when there is no runner or
   * it cannot prove anything (nothing is then settled).
   */
  readonly gone: (ferret: FerretId) => Promise<boolean | undefined>;
  /** The ferret's journal (history.jsonl), on its one append chain. */
  readonly history: (ferret: FerretId, type: string, data: Readonly<Record<string, unknown>>) => Promise<void>;
  readonly clock: { now(): string };
  readonly log: Pick<Log, 'warn'>;
  readonly cap?: number | undefined;
}

interface InterruptedLaunches {
  /** One pass: every launch a restart took with it is recorded failed (up to the cap), and the notice is said. */
  readonly run: () => Promise<InterruptedLaunchOutcome>;
}

/**
 * Mounts today's `InterruptedLaunchReconciler` over 5.0's owners.
 *
 * FerretsService starts a ferret through its own queue and does not register in the lifecycle's launch gate, so the gate
 * alone cannot tell a launch THIS process is making from one a dead daemon left. The registry can: a ferret this process
 * started or resumed has a `stateAt` at or after the boot, a record a restart left has one from before it. A launch is
 * "under way here" when either says so.
 *
 * A pane is observed only through the runner's own `gone` proof: a terminal that is not proven gone (alive, kept dead
 * with an exit status, or unreadable) is left as it was, because killing or failing it is not this pass's call.
 */
export function buildInterruptedLaunches(deps: InterruptedLaunchesDeps): InterruptedLaunches {
  const reconciler = new InterruptedLaunchReconciler({
    repository: deps.repository,
    serial: deps.serial,
    gate: {
      launching: (id: SessionId) => {
        if (deps.gate.launching(id)) return true;
        const stateAt = deps.record(id as unknown as FerretId)?.stateAt;
        return stateAt !== undefined && Date.parse(stateAt) >= deps.bootedAtMs;
      },
    },
    panes: {
      observe: async (id: SessionId): Promise<PaneObservation> => {
        const gone = await deps.gone(id as unknown as FerretId);
        // Not provable: thrown, so the reconciler reads it as an unobservable pane (kept), never as a gone one.
        if (gone === undefined) throw new Error('the runner cannot prove whether this pane is gone');
        return { alive: !gone, dead: false, promptReady: false };
      },
    },
    clock: deps.clock,
    cap: deps.cap ?? INTERRUPTED_LAUNCH_PASS_CAP,
  });
  return {
    run: async () => {
      const outcome = await reconciler.reconcile();
      // The notice: each ferret's own journal says its launch was cut off by the restart (the document's own
      // `session.failed` line carries the reason already), and the daemon log says how many in all.
      for (const ferret of outcome.failed)
        await deps
          .history(ferret as unknown as FerretId, INTERRUPTED_LAUNCH_EVENT, { reason: INTERRUPTED_LAUNCH_REASON })
          .catch(() => undefined);
      if (outcome.failed.length > 0)
        deps.log.warn('launches a host restart interrupted were recorded failed', {
          failed: outcome.failed.length,
          left: outcome.kept.filter(each => each.why === 'over-cap').length,
        });
      return outcome;
    },
  };
}
