import { resolve } from 'node:path';
import type { FerretSummary } from '@ferretry/core-ferrets/contract';

/**
 * Today's `authorizeResume` (`session/resume/policy.ts`) under the Warden's automatic policy, restated over what Ferrets
 * and Asks say: everything that refuses an automatic resume or restart, checked BEFORE anything is stopped or started.
 *
 * GAP(ferrets): today the restart was ONE resume told to replace the live pane (`replaceLiveTerminal`) and these checks
 * ran inside it. Ferrets has no such resume yet, so the Warden stops then resumes, and runs the same checks first. The
 * `kill_failed` refusal (a previous shutdown not confirmed) has no fact in `FerretSummary`, so it is not checked here.
 */
export class WardenResumeRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WardenResumeRefused';
  }
}

/** A ferret that will run again on its own: today's `!isTerminalForResume`, in the four states. */
const live = (ferret: FerretSummary): boolean => ferret.state !== 'stopped';

/**
 * The duplicate-work heuristic the automatic reviver inherits (today's `findRecoveryScopeConflict`). A label is a batch
 * slug, so this may only suppress an AUTOMATIC recovery, never an operator's; a ferret with no label or no folder
 * matches nothing.
 */
function recoveryScopeConflict(target: FerretSummary, candidates: readonly FerretSummary[]): FerretSummary | undefined {
  const label = target.label?.trim();
  if (!label || !target.folder.trim()) return undefined;
  const folder = resolve(target.folder);
  return candidates.find(
    candidate =>
      candidate.id !== target.id &&
      candidate.label?.trim() === label &&
      candidate.folder.trim() !== '' &&
      resolve(candidate.folder) === folder &&
      live(candidate),
  );
}

/**
 * Throws when today's `authorizeResume` would refuse this automatic resume. `pendingQuestion` is whether the ferret has
 * a question of its own open (an ask that wants an answer): a live agent holding one is mid-conversation, and
 * relaunching it destroys the question with the pane.
 */
export function authorizeWardenResume(
  target: FerretSummary,
  candidates: readonly FerretSummary[],
  pendingQuestion: boolean,
): void {
  if (pendingQuestion && live(target))
    throw new WardenResumeRefused(
      `answer or abandon the pending question on ${target.id} before resuming this live session`,
    );
  const conflict = recoveryScopeConflict(target, candidates);
  if (conflict !== undefined)
    throw new WardenResumeRefused(
      `automatic revive suppressed for session ${target.id}: live session ${conflict.id} shares ` +
        `label ${target.label ?? ''} and checkout ${target.folder}, the automatic-recovery ` +
        `dedupe scope; resume ${target.id} explicitly to recover the original session`,
    );
}
