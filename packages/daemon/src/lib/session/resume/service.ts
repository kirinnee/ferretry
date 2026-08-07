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
  ResumeAcknowledgementFailed,
  ResumeRefused,
  UnregisteredResumeReplacement,
  type LaunchGate,
  type PaneObservation,
  type ResumeActor,
  type ResumeAnswerAttention,
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
  /**
   * Serializes every mutation of one session, so two revivers cannot both replace its pane.
   *
   * IT MUST BE THE SAME EXECUTOR THE ANSWER SUBSYSTEM AND THE MONITOR'S REPROJECTION USE, and that
   * is a correctness requirement rather than tidiness. A dismissal releases the old pane, relaunches,
   * appends the durable acknowledgement and clears the warning; if the answer queue were a different
   * executor, a projection could publish a NEWER advisory anywhere in that window and the clear would
   * erase a warning nobody had read. Comparing the standing message instead does not save it — the
   * composition root's first-write sentence is byte-identical for every request that names the same
   * tool, so the replacement can be indistinguishable from what was acknowledged. Holding one queue
   * across the whole critical section is what actually closes it.
   *
   * ORDERING, so this cannot deadlock: answer, monitor and resume all take THIS queue first and the
   * storage queue second, never the reverse, and the acknowledgement port must not re-enter it.
   */
  readonly serial: SerialExecutor;
  /** Durable dismissal of the released structured-answer advisory. Required, so the clear can
   *  never happen without a record: a composition with nothing to append has nothing to clear. */
  readonly answerAttention: ResumeAnswerAttention;
}

export interface ResumeRequest {
  readonly id: SessionId;
  readonly message?: string | undefined;
  readonly actor?: ResumeActor | undefined;
  /**
   * An explicit policy overrides the OPERATIONAL fields the actor would imply — `automatic`,
   * `dedupeSharedRecoveryScope`, `expectedStatus`, `retryAttempt`, `replaceLiveTerminal` — which is
   * how a scheduled retry pins its guard and a migration gives up the live-send shortcut.
   *
   * `humanOperator` is NOT overridable that way. It is derived from the actor, and a supplied policy
   * can only ever NARROW it: see `authorizedPolicy`.
   */
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
 * One resume's own scratch state, created per call rather than held on the service.
 *
 * `monitorNeedsRestart` answers a question no error class can: this resume DISARMED the session's
 * monitor and then failed without reaching a terminal verdict, so a pane may still be alive with
 * nothing watching it — the old one when the release failed, the new one when the acknowledgement or
 * the final state write did. Recovery clears it on exactly the paths that kill the pane and record a
 * verdict, because a monitor armed over a session that was deliberately terminalized would be
 * watching nothing. Erring the other way is the safe direction: a monitor that finds no pane is
 * harmless, a live pane nobody watches is how a stalled agent goes unnoticed forever.
 *
 * It lives on a per-call object because two resumes of two sessions share this service instance, and
 * a field would let one decide the other's monitor.
 */
interface ResumeAttempt {
  monitorNeedsRestart: boolean;
}

/**
 * The policy this resume actually runs under: the caller's, except for the one axis it may not name.
 *
 * `ResumeRequest.policy` is a real and needed override — the scheduled retry pins `expectedStatus`
 * and keeps its retry counter, the migration gives up the live-send shortcut — and every one of
 * those fields is a caller stating HOW to resume. `humanOperator` is not that kind of field. It is
 * the capability to dismiss a warning a person is supposed to read, and a whole-policy override made
 * it forgeable: `{ actor: 'peer', policy: { …, humanOperator: true } }` took the bare relaunch path,
 * acknowledged the advisory and cleared it, filing the audit line under `peer`. Nothing in
 * production does that today, but the exported service promises the override, so the invariant only
 * holds by luck of who calls it.
 *
 * So this axis is NARROWING ONLY: the supplied bit can take the privilege away and never grant it.
 * Effective is `supplied === true AND the actor genuinely has it`, which makes peer, warden, daemon
 * and unknown unable to acquire it however they spell the policy, and leaves an admin who did not
 * ask for it failing closed. Every other field is passed through exactly as given.
 */
function authorizedPolicy(request: ResumeRequest): ResumePolicy {
  const derived = resolveResumePolicy(request.actor ?? 'unknown');
  if (request.policy === undefined) return derived;
  return {
    ...request.policy,
    humanOperator: request.policy.humanOperator === true && derived.humanOperator === true,
  };
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
 * - The released structured-answer advisory is acknowledged durably only after the old pane is
 *   gone, the relaunch succeeded and the turn was delivered — and only then is it cleared from the
 *   state. A failure at ANY of those points leaves the warning standing, and a failure of the
 *   acknowledgement itself still leaves a live, supervised replacement rather than a second pane or
 *   a terminal verdict about one that is plainly running.
 */
export class SessionResumeService {
  constructor(
    private readonly ports: SessionResumePorts,
    private readonly settings: SessionResumeSettings,
  ) {}

  async resume(request: ResumeRequest): Promise<ResumeOutcome> {
    const policy = authorizedPolicy(request);
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
    const attempt: ResumeAttempt = { monitorNeedsRestart: false };
    try {
      const outcome = await this.ports.serial.run(request.id, () => this.locked(request, policy, attempt));
      if (outcome.disposition === 'revived' || outcome.disposition === 'preserved')
        await this.ports.monitors.start(request.id);
      return outcome;
    } catch (error) {
      // A pane this resume disarmed the monitor for may still be alive: the old one if its release
      // failed, the new one if the acknowledgement or the final state write did. It gets its
      // supervisor back out here, after the serial lock is released — the same reason the happy path
      // starts the monitor here rather than inside. Exactly one start, and the ORIGINAL failure is
      // still what the caller is told, so a monitor that also refuses cannot replace it.
      if (attempt.monitorNeedsRestart) await this.ports.monitors.start(request.id).catch(() => undefined);
      throw error;
    } finally {
      registration.release();
    }
  }

  private async locked(request: ResumeRequest, policy: ResumePolicy, attempt: ResumeAttempt): Promise<ResumeOutcome> {
    const target = await this.require(request.id);
    const pane = await this.ports.launcher.observe(request.id);
    authorizeResume(target, pane, policy, await this.ports.repository.list());
    const action = planResume(target, pane, request.message, policy, this.settings);
    if (action.kind === 'send') {
      await this.ports.launcher.deliver(request.id, action.message);
      return { target, disposition: 'sent' };
    }
    return await this.relaunch(target, action, policy, request.actor ?? 'unknown', attempt);
  }

  private async relaunch(
    target: ResumeTarget,
    action: Extract<ResumeAction, { kind: 'relaunch' }>,
    policy: ResumePolicy,
    actor: ResumeActor,
    attempt: ResumeAttempt,
  ): Promise<ResumeOutcome> {
    await this.ports.monitors.stop(target.id);
    // From here until a verdict is recorded, a failure can leave a pane alive with no supervisor.
    attempt.monitorNeedsRestart = true;
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
      return await this.recover(starting, action, policy, error, attempt);
    }
    // The dismissal is durable BEFORE the state clears, and only once the old pane is gone, the
    // relaunch succeeded and the turn was delivered. A crash between the two leaves an
    // acknowledged record beside a standing advisory, which a retry finishes; the other order
    // would leave a cleared warning with nothing recording that a person dismissed it.
    //
    // What makes the generic clear below safe is the QUEUE, not anything the acknowledgement hands
    // back. This whole critical section runs under the session's own answer/monitor executor — the
    // key every answer drive and every projection must also take — so nothing can install a newer
    // advisory between the acknowledgement and the clear, and the warning cleared is necessarily the
    // one that was just dismissed. Comparing the standing message instead would NOT be enough: the
    // first-write sentence is byte-identical for every request id naming the same tool, so a
    // replacement can be indistinguishable from what was acknowledged.
    if (action.acknowledgeAnswerAttention) {
      try {
        await this.ports.answerAttention.acknowledge(target.id, actor);
      } catch (cause) {
        // Never relaunch again here: the replacement is already up. Record it as running WITHOUT
        // clearing, so the advisory survives exactly as it was, and hand the failure out. Its
        // monitor is started by `resume` once this lock is released.
        //
        // The write is best-effort ON PURPOSE. If the repository is also refusing, letting its error
        // escape would replace the acknowledgement failure with a less specific one, and the caller
        // would be told about a journal rather than about a warning that is still standing. The
        // session's status being stale is the smaller, self-correcting problem.
        await this.ports.repository
          .transition(target.id, { event: 'session.resumed', status: 'running' })
          .catch(() => undefined);
        throw new ResumeAcknowledgementFailed(target.id, { cause });
      }
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
    attempt: ResumeAttempt,
  ): Promise<ResumeOutcome> {
    const exit = await this.ports.launcher.confirmExit(target.id).catch(() => ({ confirmed: true, pane: deadPane() }));
    if (!exit.confirmed && !(error instanceof UnregisteredResumeReplacement)) {
      const preserved = await this.ports.repository.transition(target.id, {
        event: 'session.resume_false_terminal_averted',
        status: 'running',
        // A preserved harness is a relaunch that FAILED and was survived, so it never acknowledges
        // and therefore never clears the answer advisory: dropping the warning on the strength of a
        // probe, with nothing durable recording that anyone dismissed it, is exactly the ordering
        // this slice exists to not reproduce. Every other attention kind keeps its clear.
        ...(action.clearNeedsHuman && !action.acknowledgeAnswerAttention ? { clearNeedsHuman: true } : {}),
        data: { promptReady: exit.pane.promptReady },
      });
      return { target: preserved, disposition: 'preserved' };
    }
    // Past here the pane is deliberately destroyed and a verdict is recorded, so there is nothing
    // left for a monitor to supervise: arming one over a terminalized session would be watching an
    // absence. Every path below either journals `session.failed` or schedules a retry that will
    // launch — and monitor — its own attempt.
    attempt.monitorNeedsRestart = false;
    await this.ports.launcher.snapshot(target.id).catch(() => undefined);
    await this.ports.launcher.kill(target.id, 'failed resume cleanup').catch(() => undefined);
    const reason = failureMessage(error);
    // A live replacement without a durable identity cannot be preserved or retried. Retrying may
    // create a second replacement while the first still exists, and a fresh monitor would be
    // unable to address the live pane safely. Record the failed state and make the integrity error
    // visible even when the independent probe found the unregistered pane alive.
    if (error instanceof UnregisteredResumeReplacement) {
      await this.ports.repository.transition(target.id, { event: 'session.failed', status: 'failed', reason });
      throw error;
    }
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
