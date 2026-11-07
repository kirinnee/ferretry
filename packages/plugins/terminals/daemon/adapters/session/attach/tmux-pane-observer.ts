import type {
  ObservedTerminalPane,
  RegisteredPaneObserver,
  RegisteredTerminalPane,
} from '../../../lib/session/attach/identity.ts';
import type { ProcessIncarnation } from '../../../lib/protocol/process-incarnation.ts';
import type { TmuxController } from '../../../lib/tmux/controller.ts';

/**
 * A fresh look at a pane the runner recorded (today's `ExactTmuxPaneReaper.observe`): the pane `-t <session>` names
 * on this daemon's private server, and its pid's start read again from the kernel. Never a candidate by name: the
 * session is the runner's own record, and the caller compares the whole incarnation.
 */
export class TmuxPaneObserver implements RegisteredPaneObserver {
  constructor(
    private readonly tmux: Pick<TmuxController, 'paneIdentity'>,
    private readonly incarnation: ProcessIncarnation,
  ) {}

  async observe(registration: RegisteredTerminalPane): Promise<ObservedTerminalPane | undefined> {
    const identity = await this.tmux.paneIdentity(registration.tmuxSession);
    if (identity === undefined) return undefined;
    const ticks = await this.incarnation.startOf(identity.pid);
    return ticks === undefined
      ? undefined
      : { tmuxSession: registration.tmuxSession, paneId: identity.paneId, pid: identity.pid, processStartTicks: ticks };
  }
}
