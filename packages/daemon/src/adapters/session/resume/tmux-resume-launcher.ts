import { sessionPaneEnvironment } from '../../../lib/session/lifecycle/policy.ts';
import {
  type PaneObservation,
  type ResumeLauncher,
  UnregisteredResumeReplacement,
} from '../../../lib/session/resume/types.ts';
import type { LastSnapshotWriter } from '../../../lib/session/snapshot/index.ts';
import type { SessionId } from '../../../lib/session-id.ts';
import type { TmuxController } from '../../../lib/tmux/index.ts';
import type { TmuxPaneDelivery } from '../../tmux/pane-delivery.ts';
import type { AgentLaunchWrapper } from '../lifecycle/tmux-session-lifecycle-launcher.ts';

/** What a resume needs to know about a session before it can address its terminal. */
export interface ResumeLaunchSpec {
  readonly tmuxSession: string;
  readonly cwd: string;
  readonly command: readonly string[];
  /**
   * The session's stored environment — its board capability, and any variable a grant delivered.
   *
   * Absent is the honest answer for a session that has none, and it is NOT the same as absent
   * identity: `relaunch` derives the session id itself, so a replacement pane can always name
   * itself even when the spec carries no environment at all.
   */
  readonly env?: Readonly<Record<string, string>>;
}

/** Rewrites the durable pane identity after a revive replaces the process incarnation. */
export interface ResumePaneRegistrar {
  registerSession(sessionId: SessionId, tmuxSession: string): Promise<void>;
}

/**
 * How hard a revive tries to record its replacement pane before it gives the replacement up.
 *
 * A TIGHT BOUND, because both ways the write fails are races with the launch that just happened:
 * the multiplexer has not published the pane yet, or its process is not yet readable. Both resolve
 * in milliseconds or not at all, so a couple of retries costs nothing and a long backoff would hold
 * the lifecycle barrier for a case that is already lost.
 */
export interface ResumeRegistrationRetry {
  /** Total attempts, including the first. */
  readonly attempts: number;
  readonly delayMs: number;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

const DEFAULT_REGISTRATION_RETRY: ResumeRegistrationRetry = {
  attempts: 3,
  delayMs: 50,
  sleep: async milliseconds => {
    await Bun.sleep(milliseconds);
  },
};

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    private readonly limits?: AgentLaunchWrapper,
    private readonly registrar?: ResumePaneRegistrar,
    private readonly retry: ResumeRegistrationRetry = DEFAULT_REGISTRATION_RETRY,
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

  /**
   * Replaces the pane, with the environment the session is entitled to.
   *
   * A pane reads its environment AT LAUNCH, so a revive that dropped it would hand a working agent a
   * replacement that has lost its own name and its board capability — a teammate that stops being
   * able to attribute a message, or accept an invitation, at the exact moment it is recovered.
   */
  async relaunch(id: SessionId): Promise<void> {
    const spec = await this.spec(id);
    // Resolve from the CURRENT saved resource-limit document, but never bake the transient wrapper
    // into the durable spec. A later relaunch after disabling must recover the same direct command.
    const wrapped = (await this.limits?.command(id, spec.command)) ?? spec.command;
    const [program, ...arguments_] = wrapped;
    if (program === undefined) throw new Error(`session ${id} has an empty command and cannot be relaunched`);
    await this.tmux.launch({
      session: spec.tmuxSession,
      cwd: spec.cwd,
      command: [program, ...arguments_],
      env: sessionPaneEnvironment(id, spec.env ?? {}),
    });
    // The process incarnation changed. Hot apply and terminal reap must address this replacement,
    // never the pid the revive just killed.
    await this.register(id, spec.tmuxSession);
  }

  /**
   * Record the replacement's durable identity, or do not leave the replacement running.
   *
   * A REPLACEMENT NOBODY CAN NAME IS WORSE THAN NO REPLACEMENT. The recovery this sits inside
   * re-probes after a failure and preserves a session whose pane is alive — so a revive that
   * launched a pane and could not register it would report the session preserved while every
   * durable reader still names the pid the revive itself killed. The reap would then decline to
   * sweep it forever, the resource-limit surface would read the placement of whatever inherits that
   * pid, and nothing anywhere would say so.
   *
   * So the write is retried against the two races that produce it, and if it still cannot be made
   * the pane is killed and the failure raised: the recovery then finds no live pane, agrees the
   * revive failed, and says it. A visible failed resume is a state a person can act on; a silently
   * misidentified live agent is not.
   */
  private async register(id: SessionId, tmuxSession: string): Promise<void> {
    const registrar = this.registrar;
    if (registrar === undefined) return;
    let last: unknown;
    for (let attempt = 0; attempt < this.retry.attempts; attempt += 1) {
      if (attempt > 0) await this.retry.sleep(this.retry.delayMs);
      try {
        await registrar.registerSession(id, tmuxSession);
        return;
      } catch (error) {
        last = error;
      }
    }
    let teardown = 'the unregistered replacement pane was killed';
    try {
      await this.tmux.stop(tmuxSession);
    } catch (error) {
      teardown = `the unregistered replacement pane could not be killed either (${reason(error)})`;
    }
    throw new UnregisteredResumeReplacement(
      `session ${id} was relaunched but its replacement pane could not be registered (${reason(last)}); ${teardown}`,
      { cause: last },
    );
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
