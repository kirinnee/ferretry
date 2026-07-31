import type { SerialExecutor } from '../../ports.ts';
import type { SessionId } from '../../session-id.ts';
import {
  authorizeResume,
  planResume,
  resolveResumePolicy,
  resumeTurnDocument,
  resumeTurnInstruction,
  type PaneDisposition,
  type ResumeAction,
} from './policy.ts';
import { planRetry } from './retry.ts';
import type { SessionResumeSettings } from './settings.ts';
import {
  ResumeRefused,
  type LaunchGate,
  type PaneObservation,
  type ResumeActor,
  type ResumeLauncher,
  type ResumeMonitorControl,
  type ResumePolicy,
  type ResumeRepository,
  type ResumeTarget,
  type ResumeTurnStore,
} from './types.ts';

export interface SessionResumePorts {
  readonly repository: ResumeRepository;
  readonly launcher: ResumeLauncher;
  readonly turns: ResumeTurnStore;
  readonly monitors: ResumeMonitorControl;
  readonly gate: LaunchGate;
  /** Serializes every mutation of one session, so two revivers cannot both replace its pane. */
  readonly serial: SerialExecutor;
}

export interface ResumeRequest {
  readonly id: SessionId;
  readonly message?: string | undefined;
  readonly actor?: ResumeActor | undefined;
  /** An explicit policy overrides whatever the actor would imply. */
  readonly policy?: ResumePolicy | undefined;
}

/** What a completed resume did, so a caller can report it without re-reading the record. */
export interface ResumeOutcome {
  readonly target: ResumeTarget;
  readonly disposition: 'sent' | 'revived' | 'retry-scheduled' | 'preserved';
  /** Set when a retry was scheduled, so the caller knows when to fire it. */
  readonly retryDelayMs?: number | undefined;
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Revives a stopped or dead session with its conversation intact.
 *
 * The orderings here are the whole of it, and each one is a bug this slice does not reproduce:
 *
 * - Every refusal is evaluated before anything is written, so a resume that loses its guard race has
 *   not already cleared the attention flag an operator was waiting on.
 * - The old monitor is disarmed before the pane is deliberately killed, or that monitor observes
 *   resume's own kill and writes a terminal verdict in the middle of the relaunch.
 * - A relaunch failure is re-probed independently before it is believed. A readiness or injection
 *   error with a surviving prompt-ready harness is a false terminal, and killing that harness
 *   destroys a working agent over a reporting failure.
 * - The new monitor starts only after the session lock is released: a watcher replays transcript
 *   bytes through the same per-session queue, and starting it under the lock deadlocks resume
 *   against its own callback.
 */
export class SessionResumeService {
  constructor(
    private readonly ports: SessionResumePorts,
    private readonly settings: SessionResumeSettings,
  ) {}

  async resume(request: ResumeRequest): Promise<ResumeOutcome> {
    const policy = request.policy ?? resolveResumePolicy(request.actor ?? 'unknown');
    // Pending, not refused: a resume that lands mid-launch and succeeds anyway would fight the
    // bootstrap for the same terminal name.
    if (
      this.ports.gate.launching(request.id) &&
      !(await this.ports.gate.awaitSettled(request.id, this.settings.controlLaunchWaitMs))
    )
      throw new ResumeRefused(
        `session ${request.id} is still launching after ` +
          `${Math.round(this.settings.controlLaunchWaitMs / 1000)}s; it is pending, not failed`,
      );
    // Claimed before any write: the reflex layer uses this registration as launch amnesty, and an
    // unregistered resume gets its half-built replacement terminalized underneath it.
    const registration = this.ports.gate.register(request.id);
    try {
      const outcome = await this.ports.serial.run(request.id, () => this.locked(request, policy));
      if (outcome.disposition === 'revived' || outcome.disposition === 'preserved')
        await this.ports.monitors.start(request.id);
      return outcome;
    } finally {
      registration.release();
    }
  }

  private async locked(request: ResumeRequest, policy: ResumePolicy): Promise<ResumeOutcome> {
    const target = await this.require(request.id);
    const pane = await this.ports.launcher.observe(request.id);
    authorizeResume(target, pane, policy, await this.ports.repository.list());
    const action = planResume(target, pane, request.message, policy, this.settings);
    if (action.kind === 'send') {
      await this.ports.launcher.deliver(request.id, action.message);
      return { target, disposition: 'sent' };
    }
    return await this.relaunch(target, action, policy);
  }

  private async relaunch(
    target: ResumeTarget,
    action: Extract<ResumeAction, { kind: 'relaunch' }>,
    policy: ResumePolicy,
  ): Promise<ResumeOutcome> {
    await this.ports.monitors.stop(target.id);
    await this.clearPane(target, action.pane);
    if (action.cancelPendingQuestion)
      // Journalled BEFORE the state clears it: a relaunch destroys the question with the pane, and
      // a failure to record that must not silently erase the evidence it was ever asked.
      await this.ports.repository.transition(target.id, {
        event: 'session.question_cancelled',
        clearPendingQuestion: true,
        reason: 'session relaunched before the question was answered',
      });
    const instruction = action.prompt === undefined ? undefined : await this.writeTurn(target.id, action);
    await this.ports.turns.clearMarkers(target.id);
    const starting = await this.ports.repository.transition(target.id, {
      event: 'session.resuming',
      status: 'starting',
      turn: action.turn,
      ...(action.resetRetryAttempt ? { retryAttempt: 0 } : {}),
    });
    try {
      await this.ports.launcher.relaunch(target.id);
      if (instruction !== undefined) await this.ports.launcher.deliver(target.id, instruction);
    } catch (error) {
      return await this.recover(starting, action, policy, error);
    }
    const revived = await this.ports.repository.transition(target.id, {
      event: 'session.resumed',
      status: 'running',
      ...(action.clearNeedsHuman ? { clearNeedsHuman: true } : {}),
    });
    return { target: revived, disposition: 'revived' };
  }

  private async clearPane(target: ResumeTarget, disposition: PaneDisposition): Promise<void> {
    if (disposition === 'none') return;
    if (disposition === 'snapshot-and-kill') {
      // Killing the leftover pane discards any unsent text in its composer. That is a deliberate
      // tradeoff, so it is surfaced rather than silent: the final frame is captured first and the
      // discard is journalled.
      await this.ports.launcher.snapshot(target.id);
      await this.ports.repository.transition(target.id, {
        event: 'session.composer_discarded',
        reason: 'pane replaced by a revive; any unsent composer text is in the final snapshot',
      });
      await this.ports.launcher.kill(target.id, 'pane cleanup before revive');
      return;
    }
    await this.ports.launcher.kill(target.id, 'cleanup before resume');
  }

  private async writeTurn(
    id: SessionId,
    action: Extract<ResumeAction, { kind: 'relaunch' }>,
  ): Promise<string | undefined> {
    if (action.prompt === undefined) return undefined;
    const file = await this.ports.turns.writeTurn(id, action.turn, resumeTurnDocument(action.prompt, this.settings));
    return resumeTurnInstruction(file);
  }

  /**
   * Turns a relaunch failure into a verdict, but only one the pane agrees with.
   *
   * A readiness or injection error is one observation. If the independent probe finds the harness
   * alive, the session is preserved and handed to a fresh monitor: killing a prompt-ready successor
   * because the report of its birth failed destroys work for no reason at all.
   */
  private async recover(
    target: ResumeTarget,
    action: Extract<ResumeAction, { kind: 'relaunch' }>,
    policy: ResumePolicy,
    error: unknown,
  ): Promise<ResumeOutcome> {
    const exit = await this.ports.launcher.confirmExit(target.id).catch(() => ({ confirmed: true, pane: deadPane() }));
    if (!exit.confirmed) {
      const preserved = await this.ports.repository.transition(target.id, {
        event: 'session.resume_false_terminal_averted',
        status: 'running',
        ...(action.clearNeedsHuman ? { clearNeedsHuman: true } : {}),
        data: { promptReady: exit.pane.promptReady },
      });
      return { target: preserved, disposition: 'preserved' };
    }
    await this.ports.launcher.snapshot(target.id).catch(() => undefined);
    await this.ports.launcher.kill(target.id, 'failed resume cleanup').catch(() => undefined);
    const reason = failureMessage(error);
    const retry = planRetry(target, policy, this.settings);
    if (retry.kind === 'retry') {
      const scheduled = await this.ports.repository.transition(target.id, {
        event: 'session.retry_scheduled',
        status: 'retrying',
        retryAttempt: retry.attempt,
        reason,
        data: { attempt: retry.attempt, delayMs: retry.delayMs },
      });
      return { target: scheduled, disposition: 'retry-scheduled', retryDelayMs: retry.delayMs };
    }
    await this.ports.repository.transition(target.id, { event: 'session.failed', status: 'failed', reason });
    throw error;
  }

  private async require(id: SessionId): Promise<ResumeTarget> {
    const target = await this.ports.repository.read(id);
    if (!target) throw new ResumeRefused(`session not found: ${id}`);
    return target;
  }
}

/** The observation to assume when even the failure probe failed: nothing survived. */
function deadPane(): PaneObservation {
  return { alive: false, dead: true, promptReady: false };
}
