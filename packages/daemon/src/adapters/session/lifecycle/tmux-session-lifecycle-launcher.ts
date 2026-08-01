import type {
  SessionEnvironmentStore,
  SessionLifecycleLauncher,
  SessionLifecycleRecord,
} from '../../../lib/session/lifecycle/index.ts';
import type { TmuxController } from '../../../lib/tmux/index.ts';
import type { TmuxPaneDelivery } from '../../tmux/pane-delivery.ts';

export interface SessionPaneRegistrar {
  register(record: SessionLifecycleRecord): Promise<void>;
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
  ) {}

  async alive(record: SessionLifecycleRecord): Promise<boolean> {
    return await this.tmux.alive(record.config.tmuxSession);
  }

  async launch(record: SessionLifecycleRecord): Promise<void> {
    const [program, ...arguments_] = record.config.command;
    if (program === undefined) throw new Error('session command is empty');
    // Read per launch rather than cached at construction: a relaunch after a rotated credential must
    // hand the pane the CURRENT secret, and one launcher instance serves every session.
    const env = await this.environment.read(record.config.id);
    await this.tmux.launch({
      session: record.config.tmuxSession,
      cwd: record.config.cwd,
      command: [program, ...arguments_],
      ...(Object.keys(env).length === 0 ? {} : { env }),
    });
    await this.registrar?.register(record);
  }

  /**
   * Hands the pane its first turn, once the harness is provably able to take it.
   *
   * The whole act — waiting out the boot, answering the trust prompt a first launch in a new
   * directory always shows, choosing the transport, and proving the payload reached the composer
   * before submitting — belongs to the delivery adapter, so the launch path and the revive path
   * cannot drift apart on any of it.
   */
  async deliver(record: SessionLifecycleRecord, instruction: string): Promise<void> {
    await this.delivery.deliver(record.config.tmuxSession, instruction);
  }

  async stop(record: SessionLifecycleRecord): Promise<void> {
    await this.tmux.stop(record.config.tmuxSession);
  }
}
