/**
 * A FINISHED HELPER'S TASK GOES BACK TO ITS LEAD (docs/board.md § A finished helper's task goes back to its lead).
 *
 * When the ferret a task is assigned to has ended (`fy signal done`, stopped, completed) and the task is still open
 * work, the daemon assigns it to the nearest LIVE ancestor of that ferret: the lead that started it, else the lead's
 * lead, an ended one skipped. Nobody is asked or messaged; the task's history says
 * `returned to <lead>: <ferret> finished`. These are the pure decisions: the board sweep asks WHEN, and
 * {@link returnTask} makes the write.
 *
 * It sits BEHIND the sub-card closes ({@link sub-card-close}): a helper's task with no PR still closes as
 * "helper finished" and a sub-card whose PR shipped closes with the parent carrying the test. What is left, a task
 * with a PR open or merged-not-closed, or a top-level task a helper held, is returned. With no live ancestor
 * nothing is returned and the task is an orphan, which the Warden reports.
 */
import { type Task, isSubTask, type LaneCategory } from '../../../contract/index.ts';
import { type TaskContext, withEvent } from './task-actions.ts';
import { nearestLiveLead, presenceOf, type FerretRoster } from './activity.ts';
import { effectiveAssignee } from './authority.ts';
import { MAX_LINEAGE_DEPTH } from './lineage.ts';
import { HELPER_ENDED_GRACE_MS, isHandedHelper, isPrFreeHelper } from './sub-task-close.ts';

export { nearestLiveLead };

/** The lanes a task sits in while somebody is doing it; anywhere else it is unclaimed, shipped, or finished. */
const WORKING_CATEGORIES: readonly LaneCategory[] = ['active', 'review'];

/** Whether the task's ferret is gone and has been untouched for the grace (a session that blinks is not ended). */
export const endedForGrace = (
  task: Pick<Task, 'createdAt'> & { readonly lastTouchedAt?: string | null },
  roster: FerretRoster,
  ferret: string,
  nowMs: number,
): boolean => {
  if (presenceOf(roster, ferret) !== 'dead') return false;
  const touched = Date.parse(task.lastTouchedAt ?? task.createdAt);
  return Number.isNaN(touched) || nowMs - touched >= HELPER_ENDED_GRACE_MS;
};

/**
 * The live lead an ended ferret's task goes back to, or `null` when it stays: the task is open work in a working
 * lane (not backlog, not shipped, not closed or dropped), its assignee has ended, and somebody above that ferret is
 * alive. The grace is not judged here ({@link returnTarget} does), so this is the question the card's write asks again
 * with a fresh roster. A sub-card is returned only while it is a helper's with a PR: a lead's own bookkeeping has no
 * helper to send back from, and a PR-free helper closes instead. The helper rule is judged here, not left to the
 * sweep, because a returned task reads as bookkeeping once its lead owns it.
 */
export const returnLead = (
  task: Pick<Task, 'assignee' | 'owner' | 'dropped' | 'parent' | 'links'>,
  category: LaneCategory | undefined,
  roster: FerretRoster,
): string | null => {
  if (task.dropped !== null || category === undefined || !WORKING_CATEGORIES.includes(category)) return null;
  if (isSubTask(task) && (!isHandedHelper(task) || isPrFreeHelper(task))) return null;
  const ferret = effectiveAssignee(task);
  return presenceOf(roster, ferret) === 'dead' ? nearestLiveLead(roster, ferret) : null;
};

/** {@link returnLead} for a ferret that has been gone for the grace (a session that blinks is not ended). */
export const returnTarget = (
  task: Pick<Task, 'assignee' | 'owner' | 'dropped' | 'createdAt' | 'parent' | 'links'> & {
    readonly lastTouchedAt?: string | null;
  },
  category: LaneCategory | undefined,
  roster: FerretRoster,
  nowMs: number,
): string | null =>
  endedForGrace(task, roster, effectiveAssignee(task), nowMs) ? returnLead(task, category, roster) : null;

/** The task handed back: assigned to `lead`, with the ferret that finished recorded in the event. */
export const returnTask = (task: Task, lead: string, finished: string, context: Pick<TaskContext, 'now'>): Task => ({
  ...withEvent(
    task,
    { type: 'assigned', from: task.assignee, to: lead, returnedFrom: finished },
    { now: context.now, actor: { kind: 'daemon' } },
  ),
  assignee: lead,
});

/**
 * The sessions from `ferret` up to `lead`, both included, walked up the roster's `lead`: exactly the ones a return
 * rests on (the ferret is gone, each one between is gone, `lead` is alive), so those are the ones whose standing is
 * held still while the task is handed over. `null` when `lead` is not above `ferret`.
 */
export const lineageThrough = (roster: FerretRoster, ferret: string, lead: string): readonly string[] | null => {
  const line = [ferret];
  while (line.length <= MAX_LINEAGE_DEPTH) {
    const next = roster.sessions.get(line[line.length - 1] as string)?.lead;
    if (next === undefined || next === '' || line.includes(next)) return null;
    line.push(next);
    if (next === lead) return line;
  }
  return null;
};
