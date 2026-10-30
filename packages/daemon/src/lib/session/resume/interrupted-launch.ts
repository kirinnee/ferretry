import type { SerialExecutor } from '../../ports.ts';
import type { SessionId } from '../../session-id.ts';
import type { LaunchGate, ResumableSessionStatus, ResumeLauncher, ResumeRepository } from './types.ts';

/**
 * The statuses that say a launch is under way: the record exists and a pane is being made for it.
 *
 * Both are claims about a PROCESS, not about the session. `created` is a start whose launch has not
 * begun and `starting` one whose launch (or a revive's relaunch) has not finished, and only the daemon
 * performing that launch can ever move the record on. A daemon that restarts mid-launch takes the
 * launch with it, so a record still saying either afterwards describes work nobody is doing.
 */
export const LAUNCH_IN_FLIGHT_STATUSES: ReadonlySet<ResumableSessionStatus> = new Set(['created', 'starting']);

/** What a launch a restart interrupted is recorded as having failed for. */
export const INTERRUPTED_LAUNCH_REASON = 'launch interrupted by a daemon restart';

/** Everything the reconciliation reads and writes, injected. */
export interface InterruptedLaunchPorts {
  readonly repository: Pick<ResumeRepository, 'list' | 'read' | 'transition'>;
  /** THIS process's launches in flight — the same gate a revive registers in. */
  readonly gate: Pick<LaunchGate, 'launching'>;
  /** Whether the session's pane is there, asked of the terminal rather than of any record. */
  readonly panes: Pick<ResumeLauncher, 'observe'>;
  /** The per-session queue every lifecycle, revive and stop takes, so none can interleave with a settle. */
  readonly serial: Pick<SerialExecutor, 'run'>;
  /** Frees the conversation a launch claimed; best effort, a terminal session's lease already reads stale. */
  readonly leases?: { release(id: SessionId): Promise<void> } | undefined;
  readonly clock: { now(): string };
}

/** Why a session in a launch status was left as it was. */
export type InterruptedLaunchKept =
  /** This process is launching it right now. */
  | 'launching'
  /** A live agent is in its pane: the launch got as far as a harness, and killing it is not this pass's call. */
  | 'pane-alive'
  /** Its pane could not be observed, which is not proof that it is gone. */
  | 'unobservable'
  /** Something else moved it on between the listing and the settle. */
  | 'moved'
  /** Reading or writing it failed; the next boot looks again. */
  | 'error';

export interface InterruptedLaunchOutcome {
  /** Sessions recorded `failed` with {@link INTERRUPTED_LAUNCH_REASON}. */
  readonly failed: readonly SessionId[];
  /** Sessions in a launch status that were deliberately left alone, and why. */
  readonly kept: readonly { readonly id: SessionId; readonly why: InterruptedLaunchKept }[];
}

/**
 * Settles every launch a daemon restart interrupted, once, at boot.
 *
 * WITHOUT THIS A SESSION IS STUCK FOREVER. The exit settle ignores `created` and `starting` on purpose —
 * a session mid-launch has no pane yet, and "it exited" would overwrite something true — so a record a
 * dead daemon left in either status is never moved on by anything: it counts as a running sub-ferret
 * against its parent's Pack limit, holds its conversation lease as a live writer, and reads as
 * "starting" on every surface for as long as the state home exists.
 *
 * A session is settled only when THIS process is not launching it AND its pane is provably not
 * running an agent. A live pane is left alone (the launch reached a harness; a person decides), and so
 * is one that could not be observed. The settle happens under the session's own queue and re-reads the
 * record inside it, so a start or a revive that won the race is never overwritten.
 *
 * `failed` is the verdict because it is the one status every remedy accepts: a revive relaunches it, a
 * stop ends it, and neither counts it as running.
 */
export class InterruptedLaunchReconciler {
  constructor(private readonly ports: InterruptedLaunchPorts) {}

  async reconcile(): Promise<InterruptedLaunchOutcome> {
    const failed: SessionId[] = [];
    const kept: { id: SessionId; why: InterruptedLaunchKept }[] = [];
    for (const listed of await this.ports.repository.list()) {
      if (!LAUNCH_IN_FLIGHT_STATUSES.has(listed.status)) continue;
      const why = await this.ports.serial
        .run(listed.id, async () => await this.settle(listed.id))
        .catch((): InterruptedLaunchKept => 'error');
      if (why === undefined) failed.push(listed.id);
      else kept.push({ id: listed.id, why });
    }
    return { failed, kept };
  }

  /** `undefined` once the session is recorded failed; otherwise why it was kept. */
  private async settle(id: SessionId): Promise<InterruptedLaunchKept | undefined> {
    if (this.ports.gate.launching(id)) return 'launching';
    const current = await this.ports.repository.read(id);
    if (current === undefined || !LAUNCH_IN_FLIGHT_STATUSES.has(current.status)) return 'moved';
    const pane = await this.ports.panes.observe(id).catch(() => undefined);
    if (pane === undefined) return 'unobservable';
    if (pane.alive && !pane.dead) return 'pane-alive';
    await this.ports.repository.transition(id, {
      event: 'session.failed',
      status: 'failed',
      reason: INTERRUPTED_LAUNCH_REASON,
      // Stamped now: the zombie scan reads a terminal session whose journal outlived its finish as a
      // session still working, and the journal is about to be written.
      finishedAt: this.ports.clock.now(),
      data: { from: current.status },
    });
    await this.ports.leases?.release(id).catch(() => undefined);
    return undefined;
  }
}
