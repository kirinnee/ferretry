/**
 * SUB-CARDS CLOSE THEMSELVES (docs/board.md § Sub-cards close themselves): a task with a parent is a lead's
 * bookkeeping for one piece of work, and the owner tests the parent, never the sub-card. So where a top-level task
 * would wait in Released · to test, a sub-card closes instead, and a helper that ends with no PR closes with its
 * ferret. These are the pure decisions: each answers the history reason a close is recorded with, or `null` for
 * "stays open". `closeAsDaemon` (card-actions) makes the move; the PR facts, `fy signal done` and the board sweep
 * decide WHEN to ask. A close raises no gate item and no agenda item: nothing here waits on the owner.
 */
import { type Task, categoryOf, isSubTask, type Lane, type LaneSet } from '../../../contract/index.ts';

/** The history reason of a sub-card whose PRs shipped. */
export const SUB_TASK_SHIPPED_REASON = 'sub-task shipped; the parent carries the test';

/** The history reason of a sub-card whose ferret finished or ended with no PR to ship. */
export const SUB_TASK_HELPER_REASON = 'helper finished';

/** How long a sub-card's ferret must have been gone before the board calls its work ended. */
export const HELPER_ENDED_GRACE_MS = 2 * 60_000;

/** The lane a finished sub-card closes into: the set's Done lane, else its first closed lane. */
export const closedLaneOf = (laneSet: LaneSet): Lane | undefined =>
  laneSet.lanes.find(lane => lane.id === laneSet.doneLane && lane.category === 'closed') ??
  laneSet.lanes.find(lane => lane.category === 'closed');

const hasOpenPr = (task: Pick<Task, 'links'>): boolean => task.links.prs.some(pr => pr.state === 'open');
const hasMergedPr = (task: Pick<Task, 'links'>): boolean => task.links.prs.some(pr => pr.state === 'merged');

/** Whether the task has no PR that is open or merged: a review or research helper, or work that shipped nothing. */
export const isPrFreeHelper = (task: Pick<Task, 'links'>): boolean => !hasOpenPr(task) && !hasMergedPr(task);

/** A sub-card handed to another ferret: a helper's task, never the lead's own bookkeeping. */
export const isHandedHelper = (task: Pick<Task, 'parent' | 'assignee' | 'owner'>): boolean =>
  isSubTask(task) && task.assignee !== null && task.assignee !== task.owner;

/** A sub-card that is still live and has somewhere to close to. */
const closable = (task: Task, laneSet: LaneSet): boolean => {
  const category = categoryOf(laneSet, task.laneId);
  return isSubTask(task) && task.dropped === null && category.ok && category.value !== 'closed';
};

/**
 * A sub-card whose PRs shipped and that now sits where a top-level task would wait for the owner to try it (a
 * `verify` lane). `null` for anything else: a PR still open, nothing merged, any other lane.
 */
export const shippedCloseReason = (task: Task, laneSet: LaneSet): string | null => {
  if (!closable(task, laneSet) || hasOpenPr(task) || !hasMergedPr(task)) return null;
  const category = categoryOf(laneSet, task.laneId);
  return category.ok && category.value === 'verify' ? SUB_TASK_SHIPPED_REASON : null;
};

/**
 * A sub-card whose ferret finished or ended with no PR to ship (a review or research helper). `null` for anything
 * else, and for a task with a PR open or merged, which the PR's own facts close.
 */
export const helperCloseReason = (task: Task, laneSet: LaneSet): string | null =>
  closable(task, laneSet) && isPrFreeHelper(task) ? SUB_TASK_HELPER_REASON : null;
