/**
 * What a session's launch argv has to become the SECOND time it is run.
 *
 * A start hands Claude `--session-id <uuid>`, which is what makes the transcript path knowable
 * before the harness exists. That flag CREATES a harness session, so re-running the recorded argv
 * on a revive would ask the harness to create a session id it already has — and a revive is exactly
 * the path that re-runs the recorded argv, because the launch spec is read straight out of the
 * configuration document.
 *
 * The fix is the flag the harness provides for it: `--resume <uuid>` continues that session, which
 * is also what keeps the provenance record TRUE — the resumed session appends to the same file the
 * start named, so nothing has to be rediscovered.
 *
 * WHY EXISTENCE OF THE TRANSCRIPT IS THE CONDITION, rather than a turn counter. The question this
 * has to answer is "has the harness already created this session?", and the transcript file IS the
 * harness's own record of having done so. A counter is a second source of truth that can disagree:
 * a migration relaunch is the FIRST launch of a freshly minted harness session on turn five, and a
 * start whose harness died before writing anything is the first launch of one on turn one. Both are
 * answered correctly by looking at whether the file exists.
 */

/** The Claude flag a start uses to name the session it is creating. */
export const HARNESS_SESSION_FLAG = '--session-id';
/** The Claude flag that continues a session the harness already has. */
export const HARNESS_RESUME_FLAG = '--resume';

/**
 * The argv to relaunch with.
 *
 * Unchanged when the session was never created — including for a harness that names its own
 * session, whose argv carries neither flag.
 */
export function relaunchCommand(command: readonly string[], harnessSessionStarted: boolean): readonly string[] {
  const flag = command.indexOf(HARNESS_SESSION_FLAG);
  // Never index 0: that position is the wrapper the launch authorization pins.
  if (flag < 1 || !harnessSessionStarted) return command;
  const next = [...command];
  next[flag] = HARNESS_RESUME_FLAG;
  return next;
}
