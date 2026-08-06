import type {
  Task,
  TaskAuthorizationProvenance,
  TaskId,
  TaskPhase,
  TaskStatus,
  TaskWorkflow,
} from '@ferretry/protocol';
import { TaskError } from './task-error.ts';

export interface TaskActor {
  readonly kind: 'agent' | 'human' | 'daemon';
  readonly id: string;
  readonly name: string | null;
  readonly sessionId: string | null;
  /** Set only after daemon-side task-board authorization for this target. */
  readonly boardAuthorizedForSession?: string;
  /**
   * The grant that authorized this actor's `live → done`, as the board resolved it.
   *
   * The whole record, never a boolean. A flag can say a permission existed and can never say WHICH,
   * so a completion journalled from a flag is an attestation nobody can audit against the board it
   * came from. This carries the board, the role, the epoch triple and the caller's own request id,
   * which is exactly the provenance the activity record persists — so the fact written down and the
   * fact the authorizer established are the same object rather than two things that agree until
   * they do not.
   */
  readonly markDoneAuthorization?: TaskAuthorizationProvenance;
}

const freezePath = (phases: readonly TaskPhase[]): readonly TaskPhase[] => Object.freeze([...phases]);

export const TASK_WORKFLOW_PATHS: Readonly<Record<TaskWorkflow, readonly TaskPhase[]>> = Object.freeze({
  quick: freezePath(['todo', 'build', 'built', 'live', 'done']),
  'design-first': freezePath(['todo', 'design', 'build', 'built', 'live', 'done']),
  'research-first': freezePath(['todo', 'research', 'design', 'build', 'built', 'live', 'done']),
  investigate: freezePath(['todo', 'research', 'done']),
});

export const TASK_STATUS_TO_PHASE: Readonly<Record<TaskStatus, TaskPhase>> = Object.freeze({
  todo: 'todo',
  researched: 'research',
  designed: 'design',
  in_progress: 'build',
  built: 'built',
  live: 'live',
  done: 'done',
  blocked: 'todo',
  dropped: 'dropped',
});

export const TASK_PHASE_TO_STATUS: Readonly<Record<TaskPhase, TaskStatus>> = Object.freeze({
  todo: 'todo',
  research: 'researched',
  design: 'designed',
  build: 'in_progress',
  built: 'built',
  live: 'live',
  done: 'done',
  dropped: 'dropped',
});

export const taskWorkflowPath = (workflow: TaskWorkflow): readonly TaskPhase[] => TASK_WORKFLOW_PATHS[workflow];

export const taskPhaseFromStatus = (status: TaskStatus): TaskPhase => TASK_STATUS_TO_PHASE[status];

export const taskStatusFromPhase = (phase: TaskPhase): TaskStatus => TASK_PHASE_TO_STATUS[phase];

export const hasTransitionReason = (reason: string | undefined): reason is string =>
  reason !== undefined && reason.trim().length > 0;

export const creationRequiresReason = (status: TaskStatus): boolean => status === 'blocked' || status === 'dropped';

export const hasRequiredCreationReason = (status: TaskStatus, reason: string | undefined): boolean =>
  !creationRequiresReason(status) || hasTransitionReason(reason);

export const hasReopenContext = (ask: string, source: string): boolean =>
  ask.trim().length > 0 && source.trim().length > 0;

export const canActorWriteSession = (actor: TaskActor, sessionId: string): boolean =>
  actor.kind !== 'agent' || actor.sessionId === sessionId || actor.boardAuthorizedForSession === sessionId;

/**
 * WHO the actor is. A board grant is authorization, never identity, so it is deliberately not read
 * here: an agent holding `mark_done` is still an agent, and a record that called it human would be
 * answering "did a human verify this?" with a fact nobody established.
 */
export const isHumanActor = (actor: TaskActor): boolean => actor.kind === 'human';

/**
 * WHAT the actor may do to a live task, which is a different question from who it is.
 *
 * A `mark_done` grant authorizes exactly one move — `live → done` — and this is the only gate that
 * consults it. Every other human-only gate keeps asking `isHumanActor`, so a grant can never reopen
 * shipped work and never approve its way past research or design, whatever else has changed about
 * the phase a request finds by the time the board applies it.
 */
export const canActorVerifyTaskDone = (actor: TaskActor): boolean =>
  isHumanActor(actor) || actor.markDoneAuthorization !== undefined;

/** Claims document coordination intent; another task claiming the same path never locks a write. */
export const canAddAdvisoryFileClaim = (_graph: readonly Task[], _taskId: TaskId, _path: string): boolean => true;

const workflowIndex = (task: Task, phase: TaskPhase): number => TASK_WORKFLOW_PATHS[task.workflow].indexOf(phase);

export const isForwardPhaseSkip = (task: Task, to: TaskPhase): boolean => {
  if (to === 'dropped') return false;
  const fromIndex = workflowIndex(task, task.phase);
  const toIndex = workflowIndex(task, to);
  return fromIndex >= 0 && toIndex > fromIndex + 1;
};

export const requiresHumanWorkflowApproval = (task: Task, to: TaskPhase): boolean => {
  if (task.phase !== 'research' && task.phase !== 'design') return false;
  return workflowIndex(task, to) > workflowIndex(task, task.phase);
};

export const requiresHumanLiveVerification = (task: Task, to: TaskPhase): boolean =>
  task.phase === 'live' && to === 'done';

/** Shipped work re-entering active construction needs the atomic ask/source supplied by reopen. */
export const requiresReopenAction = (task: Task, to: TaskPhase): boolean =>
  (task.phase === 'built' || task.phase === 'live' || task.phase === 'done') && to === 'build';

export const taskPhaseMovesBackward = (task: Task, to: TaskPhase): boolean => {
  if (to === 'dropped') return false;
  const fromIndex = workflowIndex(task, task.phase);
  const toIndex = workflowIndex(task, to);
  return fromIndex >= 0 && toIndex >= 0 && toIndex < fromIndex;
};

export const assertActorCanWriteSession = (actor: TaskActor, sessionId: string): void => {
  if (!canActorWriteSession(actor, sessionId)) {
    throw new TaskError('forbidden', `agent ${actor.id} may only write tasks in its own session`);
  }
};

export const assertTransitionReason = (reason: string | undefined): asserts reason is string => {
  if (!hasTransitionReason(reason)) throw new TaskError('reason-required', 'a nonblank reason is required');
};

export interface PhaseTransitionOptions {
  readonly human: boolean;
  /** Whether this actor may sign off `live → done`: a human, or an agent holding a board grant. */
  readonly verifiesDone: boolean;
  readonly reopen: boolean;
}

/** Applies the fixed workflow table: adjacent forward moves, unrestricted rewinds, and human gates. */
export const assertTaskPhaseTransition = (task: Task, to: TaskPhase, options: PhaseTransitionOptions): void => {
  const from = task.phase;
  if (from === to) throw new TaskError('transition', `${task.id} is already in ${to}`);
  if (from === 'dropped') throw new TaskError('transition', `${task.id} was dropped and cannot move`);
  if (to === 'dropped') return;

  const path = TASK_WORKFLOW_PATHS[task.workflow];
  const fromIndex = path.indexOf(from);
  const toIndex = path.indexOf(to);
  if (fromIndex < 0 || toIndex < 0) {
    throw new TaskError('transition', `${from} → ${to} is not part of the ${task.workflow} workflow`);
  }
  if (isForwardPhaseSkip(task, to)) {
    throw new TaskError('transition', `${task.id} cannot skip forward ${from} → ${to}`);
  }
  if (requiresReopenAction(task, to) && !options.reopen) {
    throw new TaskError('transition', `${task.id} must use reopen to move ${from} → build`);
  }
  if (taskPhaseMovesBackward(task, to)) {
    if (from === 'done' && !options.human) {
      throw new TaskError('approval-required', `${task.id} is human-verified done; only a human may reopen it`);
    }
    return;
  }
  if (requiresHumanLiveVerification(task, to) && !options.verifiesDone) {
    throw new TaskError('approval-required', `${task.id} cannot move live → done without human verification`);
  }
  if (requiresHumanWorkflowApproval(task, to) && !options.human) {
    throw new TaskError('approval-required', `${task.id} cannot advance past ${from} without human approval`);
  }
};
