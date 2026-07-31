import { TmuxController } from '../../../lib/tmux/index.ts';
import type { SessionLifecycleLauncher, SessionLifecycleRecord } from '../../../lib/session/lifecycle/index.ts';

/** Maps validated lifecycle records to the daemon's isolated tmux controller. */
export class TmuxSessionLifecycleLauncher implements SessionLifecycleLauncher {
  constructor(private readonly tmux: TmuxController) {}

  async launch(record: SessionLifecycleRecord): Promise<void> {
    const [program, ...arguments_] = record.config.command;
    if (program === undefined) throw new Error('session command is empty');
    await this.tmux.launch({
      session: record.config.tmuxSession,
      cwd: record.config.cwd,
      command: [program, ...arguments_],
    });
  }

  async stop(record: SessionLifecycleRecord): Promise<void> {
    await this.tmux.stop(record.config.tmuxSession);
  }
}
