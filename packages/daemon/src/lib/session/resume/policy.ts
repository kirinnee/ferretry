import { resolve } from 'node:path';
import type { SessionResumeSettings } from './settings.ts';
import {
  ResumeCancelled,
  ResumeRefused,
  ReviveDedupeConflict,
  TERMINAL_RESUME_STATUSES,
  type PaneObservation,
  type ResumeActor,
  type ResumePolicy,
  type ResumeTarget,
} from './types.ts';

/**
 * The policy an actor implies when the caller did not state one.
 *
 * Admin and peer calls are a person acting deliberately; a warden call is automated recovery even
 * though it reaches the same method. The ancestor expressed "explicit" by returning NO policy, so
 * every downstream check became `policy?.automatic` and an absent policy silently meant explicit —
 * which made adding a new automated caller a one-line way to grant it operator privileges by
 * accident. Here every actor resolves to a real policy, and an unrecognised one gets the SAFER
 * automatic path rather than the more powerful explicit one.
 */
export function resolveResumePolicy(actor: ResumeActor): ResumePolicy {
  const explicit = actor === 'admin-cli' || actor === 'admin-ui' || actor === 'peer';
  return { automatic: !explicit, dedupeSharedRecoveryScope: !explicit };
}

/** True for a session that will never run again on its own. */
export function isTerminalForResume(target: ResumeTarget): boolean {
  return TERMINAL_RESUME_STATUSES.has(target.status);
}

/**
 * The duplicate-work heuristic the automatic reviver inherits.
 *
 * A label is a batch slug, so two teammates sharing one can be doing entirely unrelated work — which
 * is exactly why this may only ever suppress an AUTOMATIC revive, never an operator's. A target with
 * no label, or no checkout, matches nothing: an empty label would otherwise collide with every other
 * unlabelled session in the fleet.
 */
export function findRecoveryScopeConflict(
  target: ResumeTarget,
  candidates: readonly ResumeTarget[],
): ResumeTarget | undefined {
  const label = target.label?.trim();
  if (!label || !target.cwd.trim()) return undefined;
  const cwd = resolve(target.cwd);
  return candidates.find(
    candidate =>
      candidate.id !== target.id &&
      candidate.label?.trim() === label &&
      candidate.cwd.trim() !== '' &&
      resolve(candidate.cwd) === cwd &&
      !isTerminalForResume(candidate),
  );
}

/**
 * Everything that can refuse a resume, checked BEFORE anything is mutated.
 *
 * Ordering is the fix here. The ancestor cleared the session's human-attention state and only then
 * evaluated the guard, so an explicit resume that lost its race had already erased the very flag an
 * operator was waiting to see. Nothing below writes; the caller mutates only after this returns.
 */
export function authorizeResume(
  target: ResumeTarget,
  pane: PaneObservation,
  policy: ResumePolicy,
  candidates: readonly ResumeTarget[],
): void {
  if (target.status === 'kill_failed')
    throw new ResumeRefused(
      `the previous terminal shutdown for ${target.id} was not confirmed; stop it successfully before resuming`,
    );
  if (policy.expectedStatus !== undefined && target.status !== policy.expectedStatus)
    throw new ResumeCancelled(policy.expectedStatus, target.status);
  if (policy.retryAttempt !== undefined && (target.retryAttempt ?? 0) !== policy.retryAttempt)
    throw new ResumeCancelled(policy.expectedStatus ?? target.status, target.status);
  // A live agent holding an unanswered question is mid-conversation. Relaunching replaces its pane
  // and destroys the question with it, so the operator answers or abandons first.
  if (target.pendingQuestion && pane.alive && !pane.dead && !isTerminalForResume(target))
    throw new ResumeRefused(`answer or abandon the pending question on ${target.id} before resuming this live session`);
  if (policy.dedupeSharedRecoveryScope) {
    const conflict = findRecoveryScopeConflict(target, candidates);
    if (conflict) throw new ReviveDedupeConflict(target, conflict);
  }
}

/** How a resume must treat the pane it found. */
export type PaneDisposition =
  /** No pane to deal with. */
  | 'none'
  /** A pane exists but its process is gone; clean it up quietly. */
  | 'quiet-cleanup'
  /** A live pane belonging to a session nothing supervises: snapshot it, then kill it on the record. */
  | 'snapshot-and-kill';

export type ResumeAction =
  /** The session is live and supervised: type the message into it rather than replacing it. */
  | { readonly kind: 'send'; readonly message: string }
  | {
      readonly kind: 'relaunch';
      readonly pane: PaneDisposition;
      /** An interactive session resumed with no message just gets its terminal back. */
      readonly bare: boolean;
      readonly turn: number;
      /** The turn document to write. Absent for a bare relaunch, which invents no turn. */
      readonly prompt: string | undefined;
      readonly cancelPendingQuestion: boolean;
      /** Whether a successful relaunch clears the human-attention quarantine. */
      readonly clearNeedsHuman: boolean;
      /** Whether the retry counter resets; an automatic retry must keep counting its own attempts. */
      readonly resetRetryAttempt: boolean;
    };

/**
 * Decides what a resume does, given only the record, the pane, and who asked.
 *
 * The one branch worth stating: a TERMINAL session's leftover live pane is not a session to send
 * into. Nothing monitors it — it survived a daemon restart or a reconciled completion — so a message
 * typed there is simply lost. It is killed and replaced by a tracked relaunch, while a genuinely
 * live, non-terminal session takes the plain-send shortcut instead.
 */
export function planResume(
  target: ResumeTarget,
  pane: PaneObservation,
  message: string | undefined,
  policy: ResumePolicy,
  settings: SessionResumeSettings,
): ResumeAction {
  const trimmed = message?.trim();
  const usable = pane.alive && !pane.dead;
  // A quarantined session may be sitting in an unknown native modal, so its pane cannot be trusted
  // to receive input even while it looks alive.
  const quarantined = target.needsHumanKind !== undefined;
  if (usable && !isTerminalForResume(target) && !quarantined) {
    if (!trimmed) throw new ResumeRefused(`session ${target.id} is already running`);
    return { kind: 'send', message: trimmed };
  }
  const bare = target.mode === 'interactive' && !trimmed;
  return {
    kind: 'relaunch',
    pane: usable ? 'snapshot-and-kill' : pane.alive ? 'quiet-cleanup' : 'none',
    bare,
    turn: bare ? target.turn : target.turn + 1,
    prompt: bare ? undefined : (trimmed ?? settings.defaultResumePrompt),
    cancelPendingQuestion: target.pendingQuestion !== undefined,
    clearNeedsHuman: !policy.automatic,
    resetRetryAttempt: !(policy.automatic && policy.expectedStatus === 'retrying'),
  };
}

/** The document a revived agent reads for its new turn. */
export function resumeTurnDocument(prompt: string, settings: SessionResumeSettings): string {
  return `${prompt}\n\n${settings.turnProtocolReminder}\n`;
}

/** What is typed into the replacement terminal so the agent picks the new turn up. */
export function resumeTurnInstruction(turnFile: string): string {
  return `Read the file ${turnFile} now, then carefully follow every instruction inside it. This is your complete task for this turn.`;
}
