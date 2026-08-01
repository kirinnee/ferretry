import type { PaneObservation, ResumeLauncher } from '../../../lib/session/resume/types.ts';
import type { LastSnapshotWriter } from '../../../lib/session/snapshot/index.ts';
import type { SessionId } from '../../../lib/session-id.ts';
import type { TmuxController } from '../../../lib/tmux/index.ts';
import type { TmuxPaneDelivery } from '../../tmux/pane-delivery.ts';

/** What a resume needs to know about a session before it can address its terminal. */
export interface ResumeLaunchSpec {
  readonly tmuxSession: string;
  readonly cwd: string;
  readonly command: readonly string[];
}

/**
 * The terminal side of a revive, over the daemon's own isolated tmux socket.
 *
 * Every address goes through the injected controller, which refuses a bare executable name — so no
 * lookup can ever land on a tmux server the host already runs, and nothing here can touch a pane
 * this daemon did not create.
 */
export class TmuxResumeLauncher implements ResumeLauncher {
  constructor(
    private readonly tmux: TmuxController,
    private readonly spec: (id: SessionId) => Promise<ResumeLaunchSpec>,
    private readonly delivery: TmuxPaneDelivery,
    private readonly snapshots?: LastSnapshotWriter,
  ) {}

  async observe(id: SessionId): Promise<PaneObservation> {
    const state = await this.tmux.state((await this.spec(id)).tmuxSession);
    return { alive: state.alive, dead: state.dead, promptReady: state.promptReady };
  }

  async snapshot(id: SessionId): Promise<void> {
    const state = await this.tmux.state((await this.spec(id)).tmuxSession);
    if (state.alive && !state.dead) await this.snapshots?.write(id, state.visible);
  }

  async kill(id: SessionId, _reason: string): Promise<void> {
    await this.tmux.stop((await this.spec(id)).tmuxSession);
  }

  async relaunch(id: SessionId): Promise<void> {
    const spec = await this.spec(id);
    const [program, ...arguments_] = spec.command;
    if (program === undefined) throw new Error(`session ${id} has an empty command and cannot be relaunched`);
    await this.tmux.launch({ session: spec.tmuxSession, cwd: spec.cwd, command: [program, ...arguments_] });
  }

  /**
   * Hands the replacement pane its turn, through the same delivery adapter the launch path uses.
   *
   * A revive has one dialog a first launch does not: Claude Code gates the resume of a large session
   * behind a menu that never becomes a prompt, so a revive that could not answer it could not revive
   * a long-running agent at all — which is precisely the agent worth reviving.
   */
  async deliver(id: SessionId, instruction: string): Promise<void> {
    await this.delivery.deliver((await this.spec(id)).tmuxSession, instruction);
  }

  /**
   * Re-probes after a relaunch error, independently of whatever reported it.
   *
   * A readiness or injection failure is one observation. An exit is only CONFIRMED when the pane
   * itself agrees — a live pane whose harness is still there means the harness survived the error,
   * and killing it would destroy a working agent over a reporting failure.
   */
  async confirmExit(id: SessionId): Promise<{ confirmed: boolean; pane: PaneObservation }> {
    const pane = await this.observe(id).catch(() => ({ alive: false, dead: true, promptReady: false }));
    return { confirmed: !pane.alive || pane.dead, pane };
  }
}
