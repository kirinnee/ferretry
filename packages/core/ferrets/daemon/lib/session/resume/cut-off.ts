import type { ResumeActor } from './types.ts';

/** What a resume does about a session a person cut off (`fy session revoke-credential`). */
export type CutOffResume = 'proceed' | 'restore' | 'refuse';

/**
 * A cut-off session comes back only when a PERSON resumes it (at the CLI, in the app on this host, or in the app on a
 * paired device): that resume clears the mark (`restore`), so its
 * relaunch rotates a credential. A peer, the Warden or the daemon's own revive is refused (`refuse`) before anything
 * is touched. A session nobody cut off resumes as it always did (`proceed`).
 */
export function cutOffResume(cutOff: boolean, actor: ResumeActor): CutOffResume {
  if (!cutOff) return 'proceed';
  return actor === 'admin-cli' || actor === 'admin-ui' || actor === 'device' ? 'restore' : 'refuse';
}

/** What bringing back a cut-off session takes, each step the caller's own. */
export interface CutOffRestoreSteps {
  /**
   * The route's question, asked for EVERY restore whatever the actor (secrev-1329-delta 2): a governed caller needs
   * `fleet.configure` and a `resume-cut-off` passkey; the host is asked nothing more. Throws the refusal.
   */
  readonly confirm?: (() => void) | undefined;
  /** The refusal when no route could ask (an in-process caller): a restore is never made unasked. */
  readonly unconfirmed: () => Error;
  /** Clears the mark, so the relaunch the resume makes rotates in a new credential. */
  readonly restore: () => Promise<void>;
  /** Puts the mark back. */
  readonly markAgain: () => Promise<void>;
}

/**
 * Runs `resume` under the cut-off decision. A session nobody cut off just resumes. A restore is confirmed first, its
 * mark cleared for the relaunch, and PUT BACK when the resume is refused or fails (secrev-1329-delta 1), so a refused
 * restore never leaves the ferret un-cut for the next automatic revive to bring back with no passkey.
 */
export async function resumeUnderCutOff<T>(
  cutOff: Exclude<CutOffResume, 'refuse'>,
  steps: CutOffRestoreSteps,
  resume: () => Promise<T>,
): Promise<T> {
  if (cutOff === 'proceed') return await resume();
  if (steps.confirm === undefined) throw steps.unconfirmed();
  steps.confirm();
  await steps.restore();
  try {
    return await resume();
  } catch (error) {
    await steps.markAgain();
    throw error;
  }
}
