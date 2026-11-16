import type { ResumeLauncher } from '../../../lib/session/resume/types.ts';
import type { SignalTerminal } from '../../../lib/session/signal/types.ts';
import type { SessionId } from '../../../lib/session-id.ts';

/** The two things a signal does to a terminal. Named as a subset so nothing else can be reached. */
export type SignalPaneControl = Pick<ResumeLauncher, 'snapshot' | 'kill'>;

/**
 * The terminal side of a signal, over the SAME launcher the revive uses.
 *
 * A second tmux adapter would be a second final-frame ledger, and that is the reason this is a seam
 * rather than a copy: `TmuxResumeLauncher.finalFrame` is where the last screen before a pane died is
 * kept, so a completion that snapshotted through its own object would capture a frame no revive could
 * ever find. One launcher per storage, two domains addressing it.
 *
 * The signal domain still does not import the resume domain's port — this adapter is the only place
 * the two vocabularies meet, which is what keeps `kill` from leaking into a domain whose verb is
 * `stop`.
 */
export class LauncherSignalTerminal implements SignalTerminal {
  constructor(private readonly launcher: SignalPaneControl) {}

  async snapshot(id: SessionId): Promise<void> {
    await this.launcher.snapshot(id);
  }

  async stop(id: SessionId, reason: string): Promise<void> {
    await this.launcher.kill(id, reason);
  }
}
