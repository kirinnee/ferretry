import {
  type Lane,
  type LaneSet,
  type TaskPhase,
  type TaskStatus,
  type TaskWorkflow,
  variantLanes,
} from '@ferretry/protocol';

/** What the lane choice needs to know about a task beyond its status. */
export interface LaneChoice {
  readonly status: Exclude<TaskStatus, 'blocked'>;
  readonly workflow: TaskWorkflow;
  /** Whether a pull request is linked: `built` work with one is in review. */
  readonly hasPullRequest: boolean;
}

const PHASE_STATUS: Readonly<Record<TaskPhase, Exclude<TaskStatus, 'blocked'>>> = {
  todo: 'todo',
  research: 'researched',
  design: 'designed',
  build: 'in_progress',
  built: 'built',
  live: 'live',
  done: 'done',
  dropped: 'dropped',
};

/** The status a blocked task is really in: `blocked` overlays its phase. */
export const statusOfPhase = (phase: TaskPhase): Exclude<TaskStatus, 'blocked'> => PHASE_STATUS[phase];

const lanesOf = (laneSet: LaneSet, workflow: TaskWorkflow): readonly Lane[] => {
  const walked = variantLanes(laneSet, workflow);
  return walked.ok ? walked.value : laneSet.lanes;
};

const first = (lanes: readonly Lane[], category: Lane['category']): Lane | undefined =>
  lanes.find(lane => lane.category === category);

const last = (lanes: readonly Lane[], category: Lane['category']): Lane | undefined =>
  lanes.findLast(lane => lane.category === category);

/**
 * The lane an old status becomes (`board-design.md` §5), by CATEGORY, so any project's lanes work:
 *
 * - `todo` → the first backlog lane.
 * - `researched`, `designed` → the first active lane (Plan/Design).
 * - `in_progress` → the last active lane (Implement: the one after Plan, or the only one).
 * - `built` → the first review lane when a PR is linked, else where `in_progress` goes.
 * - `live` → the last shipped lane (Released when there is one), else the verify lane, else the closed lane.
 * - `done` and `dropped` → the closed lane and the first backlog lane; a dropped card is hidden by its drop,
 *   not by its lane.
 *
 * Total: a lane set a category is missing from falls to the nearest lane that exists, never to nothing.
 * Every lane set has a backlog lane and exactly one closed lane (`laneLayoutProblems`).
 */
export const laneForStatus = (laneSet: LaneSet, choice: LaneChoice): Lane => {
  const lanes = lanesOf(laneSet, choice.workflow);
  const backlog = first(lanes, 'backlog') ?? first(laneSet.lanes, 'backlog') ?? laneSet.lanes[0];
  const closed = last(lanes, 'closed') ?? last(laneSet.lanes, 'closed') ?? laneSet.lanes.at(-1);
  const working = last(lanes, 'active') ?? backlog;
  const picked = ((): Lane | undefined => {
    switch (choice.status) {
      case 'todo':
      case 'dropped':
        return backlog;
      case 'researched':
      case 'designed':
        return first(lanes, 'active') ?? backlog;
      case 'in_progress':
        return working;
      case 'built':
        return (choice.hasPullRequest ? first(lanes, 'review') : undefined) ?? working;
      case 'live':
        return last(lanes, 'shipped') ?? first(lanes, 'verify') ?? closed;
      case 'done':
        return closed;
    }
  })();
  // A lane set always has a backlog and a closed lane, so the fallbacks above never leave this empty.
  return picked ?? (laneSet.lanes[0] as Lane);
};
