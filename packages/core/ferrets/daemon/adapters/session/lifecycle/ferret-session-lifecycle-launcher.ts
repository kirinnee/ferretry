import type { SessionLaunchInstructions } from '../../../lib/protocol/session.ts';
import type { SessionLifecycleLauncher, SessionLifecycleRecord } from '../../../lib/session/lifecycle/index.ts';
import type { FerretEndCause, FerretId, Runner, RunnerHandle } from '../../../../contract/index.ts';
import type { Result } from '@ferretry/std';

/** How long `ready` waits for the harness to show a prompt it will accept input at, and how often it looks. */
export const READY_BOUND_MS = 30_000;
export const READY_POLL_MS = 250;

/**
 * What the lifecycle's pane launcher reaches Ferrets through. ONE launch path: `launch` and `stop` are the service's own
 * (the held variants: the lifecycle already holds the ferret's key on the shared queue), so a lifecycle opens a pane
 * with the credential, home, environment and limits any other launch gets, and stops one the way any other stop does.
 */
export interface FerretLaunchPorts {
  /** `FerretsService.launchHeld`: the relaunch of a ferret the registry holds, refused when the owner cut it off. */
  launch(ferret: FerretId): Promise<Result<FerretId, { readonly reason: string }>>;
  /** `FerretsService.stopHeld`. */
  stop(ferret: FerretId, how: 'now', reason: string | undefined, cause: FerretEndCause): Promise<void>;
  /** `FerretsService.heldLaunchRefusal`: why a launch must be refused before it changes anything, or `undefined`. */
  refusal(ferret: FerretId): Promise<string | undefined>;
  /** The runner handle the registry holds for the ferret's live pane, if it holds one. */
  handleOf(ferret: FerretId): RunnerHandle | undefined;
  /** The runner that owns the pane; `undefined` while its plugin is off. */
  runner(): Runner | undefined;
  sleep(ms: number): Promise<void>;
  nowMs(): number;
}

/**
 * The session lifecycle's pane launcher, as a thin adapter over Ferrets' own launch and stop.
 *
 * Nothing here opens, signals or kills a process itself: `launch` is the service's launch, `stop` the service's stop, and
 * `alive`, `ready`, `deliver` and `settled` ask the runner about (or type through) the handle the registry holds. A ferret
 * the registry holds no handle for has no pane: `alive` says no, and the rest refuse rather than guess one.
 */
export class FerretSessionLifecycleLauncher implements SessionLifecycleLauncher {
  constructor(private readonly ports: FerretLaunchPorts) {}

  async alive(record: SessionLifecycleRecord): Promise<boolean> {
    const handle = this.ports.handleOf(this.ferret(record));
    const runner = this.ports.runner();
    if (handle === undefined || runner === undefined) return false;
    return await runner.alive(handle);
  }

  async refuseLaunch(record: SessionLifecycleRecord): Promise<string | undefined> {
    return await this.ports.refusal(this.ferret(record));
  }

  async launch(record: SessionLifecycleRecord): Promise<SessionLaunchInstructions | undefined> {
    const launched = await this.ports.launch(this.ferret(record));
    if (!launched.ok) throw new Error(launched.error.reason);
    // The service records what the launch told the ferret itself; a launcher that says nothing keeps what the record held.
    return undefined;
  }

  /**
   * The harness is at a prompt that will accept input, bounded. Dead, or never ready in time, throws: the lifecycle
   * then records the failure and the first turn is never typed. Reads only; no key is written.
   */
  async ready(record: SessionLifecycleRecord): Promise<void> {
    const { handle, runner } = this.pane(record);
    if (runner.observe === undefined) throw new Error('this runner cannot tell whether the harness is ready');
    const started = this.ports.nowMs();
    for (;;) {
      const look = await runner.observe(handle);
      if (look?.promptReady === true) return;
      if (look === undefined || look.dead || !look.alive)
        throw new Error('the harness pane ended before it was ready for its first turn');
      if (this.ports.nowMs() - started >= READY_BOUND_MS)
        throw new Error('the harness was not ready for its first turn in time');
      await this.ports.sleep(READY_POLL_MS);
    }
  }

  async deliver(record: SessionLifecycleRecord, instruction: string, beforeWrite?: () => Promise<void>): Promise<void> {
    const { handle, runner } = this.pane(record);
    await runner.deliver(handle, { text: instruction, ...(beforeWrite === undefined ? {} : { beforeWrite }) });
  }

  async settled(record: SessionLifecycleRecord): Promise<'settled' | 'timed-out'> {
    const { handle, runner } = this.pane(record);
    // A runner that cannot tell never waits: the start then measures delivery alone.
    return (await runner.settled?.(handle)) ?? 'settled';
  }

  /** The service's stop keeps the ferret's last screen itself, just before it stops the pane. */
  async snapshot(): Promise<void> {}

  async stop(record: SessionLifecycleRecord): Promise<void> {
    await this.ports.stop(this.ferret(record), 'now', undefined, { kind: 'stopped' });
  }

  private ferret(record: SessionLifecycleRecord): FerretId {
    return record.config.id as unknown as FerretId;
  }

  private pane(record: SessionLifecycleRecord): { readonly handle: RunnerHandle; readonly runner: Runner } {
    const handle = this.ports.handleOf(this.ferret(record));
    const runner = this.ports.runner();
    if (handle === undefined) throw new Error(`session ${record.config.id} has no terminal to use`);
    if (runner === undefined) throw new Error('no runner plugin is on');
    return { handle, runner };
  }
}

/**
 * The part of Ferrets' service a lifecycle's pane launcher may reach, and nothing more: the HELD variants, which a
 * lifecycle that already holds the ferret's key on the shared queue must call (the queued `resume` and `stop` would wait
 * on that very key forever), and the check ahead of them. Naming the type narrows the composition root: wiring another
 * method into the launcher does not typecheck, and {@link heldLifecycleLauncher} is the one place that maps them.
 */
export interface HeldLaunchService {
  launchHeld: FerretLaunchPorts['launch'];
  stopHeld: FerretLaunchPorts['stop'];
  heldLaunchRefusal: FerretLaunchPorts['refusal'];
}

/**
 * The lifecycle's pane launcher over Ferrets' held launch and stop, with the daemon's own handle, runner and clock reads.
 * The service is asked for at each call, not now: the root builds the launcher before the service it launches through.
 */
export function heldLifecycleLauncher(
  service: () => HeldLaunchService,
  reads: Omit<FerretLaunchPorts, 'launch' | 'stop' | 'refusal'>,
): FerretSessionLifecycleLauncher {
  return new FerretSessionLifecycleLauncher({
    ...reads,
    launch: async ferret => await service().launchHeld(ferret),
    stop: async (ferret, how, reason, cause) => await service().stopHeld(ferret, how, reason, cause),
    refusal: async ferret => await service().heldLaunchRefusal(ferret),
  });
}
