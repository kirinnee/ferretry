import type {
  SessionEnvironmentStore,
  SessionLifecycleLauncher,
  SessionLifecycleRecord,
} from '../../../lib/session/lifecycle/index.ts';
import { retryDelays, type TmuxController } from '../../../lib/tmux/index.ts';

/** Waiting is a capability, not a decision: the composition root owns how this process sleeps. */
export type LauncherSleep = (milliseconds: number) => Promise<void>;

/** A session with no stored environment launches with none, which is the pre-credential behaviour. */
const NO_ENVIRONMENT: SessionEnvironmentStore = {
  write: async () => undefined,
  read: async () => ({}),
};

/** Maps validated lifecycle records to the daemon's isolated tmux controller. */
export class TmuxSessionLifecycleLauncher implements SessionLifecycleLauncher {
  constructor(
    private readonly tmux: TmuxController,
    private readonly sleep: LauncherSleep,
    private readonly readinessAttempts = 30,
    private readonly environment: SessionEnvironmentStore = NO_ENVIRONMENT,
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
  }

  /**
   * Types an instruction into the pane, but only once the agent is at a prompt that can accept it.
   * A payload sent into a still-booting terminal is swallowed by the startup repaint, which reads
   * exactly like an agent that was never given any work.
   */
  async deliver(record: SessionLifecycleRecord, instruction: string): Promise<void> {
    const session = record.config.tmuxSession;
    for (const delay of [0, ...retryDelays(this.readinessAttempts)]) {
      if (delay > 0) await this.sleep(delay);
      const state = await this.tmux.state(session);
      if (!state.alive || state.dead)
        throw new Error(`tmux session ${session} is not running; its first turn cannot be delivered`);
      if (!state.promptReady) continue;
      await this.tmux.sendLiteral(session, instruction);
      await this.tmux.sendKey(session, 'Enter');
      return;
    }
    throw new Error(`tmux session ${session} did not become ready to accept its first turn`);
  }

  async stop(record: SessionLifecycleRecord): Promise<void> {
    await this.tmux.stop(record.config.tmuxSession);
  }
}
