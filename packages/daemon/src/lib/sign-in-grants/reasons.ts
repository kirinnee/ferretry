import {
  GRANT_MISS_REASONS,
  GRANT_STOPPING_REASONS,
  type GrantMissReason,
  grantMissLine,
  grantMissWords,
  TASK_PLAN_MISS_AGENT_NOTE,
} from '@ferretry/protocol';

/**
 * WHY A PRE-APPROVAL DID NOT FILL (docs/input-requests.md, "Task plan fills"). The closed list and its sentences are the
 * protocol's (`GRANT_MISS_REASONS`, `grantMissWords`), so the app, the daemon and the tests read one owner; this module
 * only says what a reason DOES here.
 *
 * - A reason reaches the OWNER only: `InputRequest.preapproval` on the owner's list. The ferret is told
 *   {@link TASK_PLAN_MISS_AGENT_NOTE}, one sentence for every reason, because `account-lacks-field` or `code-not-ticked`
 *   would say which secret fields an account holds.
 * - A {@link stopsTheLine} reason ends the line: every later fill under it asks, and there is no resume.
 */

export { GRANT_MISS_REASONS, type GrantMissReason, grantMissLine, grantMissWords, TASK_PLAN_MISS_AGENT_NOTE };

const STOPPING: ReadonlySet<GrantMissReason> = new Set(GRANT_STOPPING_REASONS);

/** Whether a miss stops the line it was tried under: the form, the recipe or the place changed, or a value was left behind. */
export const stopsTheLine = (reason: GrantMissReason): boolean => STOPPING.has(reason);

/**
 * The line an input card's agenda context carries when a plan line did not apply. The REASON is not in it: a ferret can
 * read its own session's agenda, so the card's words are the same whatever the reason; the owner reads the reason on
 * the input card itself, from the owner-only request.
 */
export const GRANT_MISS_CONTEXT_LINE = "A task plan line didn't apply here, so you're asked as usual.";
