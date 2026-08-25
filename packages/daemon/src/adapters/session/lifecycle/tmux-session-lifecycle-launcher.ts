import { type AccountLaunchEnvironment, launchEnvironment } from '../../../lib/fleet/launch-environment.ts';
import {
  sessionPaneEnvironment,
  type SessionEnvironmentStore,
  type SessionLifecycleLauncher,
  type SessionLifecycleRecord,
} from '../../../lib/session/lifecycle/index.ts';
import type { LastSnapshotWriter } from '../../../lib/session/snapshot/index.ts';
import type { TmuxController } from '../../../lib/tmux/index.ts';
import type { TmuxPaneDelivery } from '../../tmux/pane-delivery.ts';

export interface SessionPaneRegistrar {
  register(record: SessionLifecycleRecord): Promise<void>;
}

/**
 * The one seam through which a managed pane can be launched inside a resource-limited scope.
 *
 * It takes the argv rather than the record, and answers with the argv the pane must actually exec.
 * The record's own `command` is DURABLE and stays the harness command: a relaunch after enforcement
 * is turned off must run the same session directly, so the wrapper can never be baked into what was
 * written down.
 *
 * A launcher constructed without one launches exactly as it did before this port existed.
 */
export interface AgentLaunchWrapper {
  command(sessionId: string, command: readonly string[]): Promise<readonly string[]>;
}

/** A session with no stored environment launches with none, which is the pre-credential behaviour. */
const NO_ENVIRONMENT: SessionEnvironmentStore = {
  write: async () => undefined,
  read: async () => ({}),
};

/** Maps validated lifecycle records to the daemon's isolated tmux controller. */
export class TmuxSessionLifecycleLauncher implements SessionLifecycleLauncher {
  constructor(
    private readonly tmux: TmuxController,
    private readonly delivery: TmuxPaneDelivery,
    private readonly environment: SessionEnvironmentStore = NO_ENVIRONMENT,
    private readonly registrar?: SessionPaneRegistrar,
    private readonly snapshots?: LastSnapshotWriter,
    private readonly limits?: AgentLaunchWrapper,
    /**
     * What this account's own profile supplies. A launcher built without one launches exactly as it
     * did before profiles existed, which is also what every account that binds no secret gets.
     */
    private readonly accountEnvironment?: AccountLaunchEnvironment,
  ) {}

  async alive(record: SessionLifecycleRecord): Promise<boolean> {
    return await this.tmux.alive(record.config.tmuxSession);
  }

  async launch(record: SessionLifecycleRecord): Promise<void> {
    // Resolved per launch, from the saved limits and this session's own spawn record, and applied to
    // the argv rather than to the durable command — see `AgentLaunchWrapper`. A daemon with no
    // wrapper, or one whose limits are off, gets back exactly what it passed in.
    const wrapped = (await this.limits?.command(record.config.id, record.config.command)) ?? record.config.command;
    const [program, ...arguments_] = wrapped;
    if (program === undefined) throw new Error('session command is empty');
    // Read per launch rather than cached at construction: a relaunch after a rotated credential must
    // hand the pane the CURRENT secret, and one launcher instance serves every session.
    //
    // The env is never empty now — `sessionPaneEnvironment` always contributes the session's own id —
    // so the branch that omitted it entirely is gone. A pane launched without it is a teammate that
    // cannot name itself in a single request.
    //
    // The account's own profile is resolved per launch for the same reason, and against the account
    // this session actually runs — a credential rotated in the store reaches the next pane without an
    // apply, and a missing one refuses HERE, naming the secret, rather than letting the harness fail
    // to authenticate against a remote service minutes later.
    const env = sessionPaneEnvironment(
      record.config.id,
      launchEnvironment(
        (await this.accountEnvironment?.forWrapper(record.config.agent)) ?? {},
        await this.environment.read(record.config.id),
      ),
    );
    await this.tmux.launch({
      session: record.config.tmuxSession,
      cwd: record.config.cwd,
      command: [program, ...arguments_],
      env,
    });
    await this.registrar?.register(record);
  }

  /** The startup-only wait; interactive runtime controls keep refusing a pane that is not idle. */
  async ready(record: SessionLifecycleRecord): Promise<void> {
    await this.delivery.waitReady(record.config.tmuxSession);
  }

  /**
   * Hands the pane its first turn, once the harness is provably able to take it.
   *
   * The whole act — waiting out the boot, answering the trust prompt a first launch in a new
   * directory always shows, choosing the transport, and proving the payload reached the composer
   * before submitting — belongs to the delivery adapter, so the launch path and the revive path
   * cannot drift apart on any of it.
   */
  async deliver(record: SessionLifecycleRecord, instruction: string, beforeWrite?: () => Promise<void>): Promise<void> {
    await this.delivery.deliver(record.config.tmuxSession, instruction, {}, beforeWrite);
  }

  async snapshot(record: SessionLifecycleRecord): Promise<void> {
    const state = await this.tmux.state(record.config.tmuxSession);
    if (state.alive && !state.dead) await this.snapshots?.write(record.config.id, state.visible);
  }

  async stop(record: SessionLifecycleRecord): Promise<void> {
    await this.tmux.stop(record.config.tmuxSession);
  }
}
