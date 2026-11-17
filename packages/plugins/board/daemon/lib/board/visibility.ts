/**
 * PUBLIC AND PRIVATE TASKS (`docs/board.md` § Public and private tasks): public tasks are the ones the owner asked
 * for; private tasks are the ferrets' bookkeeping, sub-cards and helper tasks included. The board shows public tasks
 * unless asked for the rest.
 *
 * A task stores its `visibility`; one without it reads by {@link taskVisibility}. Who may change it is
 * {@link visibilityVerdict}, a pure function of the task and the caller's standing.
 */
import type { Task, TaskVisibility } from '../../../contract/index.ts';
import type { BoardStanding } from './authority.ts';
import { taskAskedBy } from './origin.ts';

/** The facts a task's visibility rests on. */
export type VisibilityFacts = Pick<Task, 'ask' | 'askedBy' | 'parent' | 'visibility' | 'visibilitySource'>;

/**
 * What a task without a stored visibility reads as: public when a person asked for it and it sits at the top
 * level, private otherwise (an agent's task, a sub-card). A stored value wins. Pure and total.
 */
export const defaultVisibility = (task: Pick<Task, 'ask' | 'askedBy' | 'parent'>): TaskVisibility =>
  (task.askedBy ?? taskAskedBy(task)) === 'person' && task.parent === null ? 'public' : 'private';

/** A task's visibility: the stored one, else {@link defaultVisibility}. Pure and total. */
export const taskVisibility = (task: VisibilityFacts): TaskVisibility => task.visibility ?? defaultVisibility(task);

/** Whether a stored visibility is a choice (set by a person or a ferret) rather than the derived default. */
export const visibilityChosen = (task: Pick<Task, 'visibility' | 'visibilitySource'>): boolean =>
  task.visibility !== undefined && task.visibilitySource !== 'default';

/**
 * The task with its AUTOMATIC visibility settled from the facts as they stand now (who asked, where it sits). A
 * chosen visibility is never touched, so no repair can undo a choice. Answers the same object when nothing would
 * change, so a caller can tell whether there is anything to write. Pure and total.
 */
export const withDefaultVisibility = <T extends VisibilityFacts>(task: T): T => {
  if (visibilityChosen(task)) return task;
  const visibility = defaultVisibility(task);
  return task.visibility === visibility && task.visibilitySource === 'default'
    ? task
    : { ...task, visibility, visibilitySource: 'default' };
};

/** The standings that may change a ferret's own task: its owner ferret, the leads above it, and the owner. */
const KEEPERS: readonly BoardStanding[] = ['owner-human', 'owner', 'ancestor'];

/** Why a visibility change is refused, or `null` when it is allowed. */
export interface VisibilityRefusal {
  readonly message: string;
  /** The standings that could do it, for the refusal's `allowed`. */
  readonly allowed: readonly BoardStanding[];
}

/**
 * Whether a caller of this standing may set a task (existing or about to be created) to `to`:
 *
 * - the owner may set any task either way;
 * - a ferret that owns the task, or leads the ferret that does, may set an agent-asked task either way;
 * - only the owner may make a person-asked task private (a ferret must never hide the owner's ask);
 * - a sub-card is private unless the owner makes it public, so a ferret may not publish one.
 */
export const visibilityVerdict = (
  task: Pick<Task, 'ask' | 'askedBy' | 'parent'>,
  to: TaskVisibility,
  standing: BoardStanding,
): VisibilityRefusal | null => {
  if (standing === 'owner-human') return null;
  const owner: readonly BoardStanding[] = ['owner-human'];
  if (!KEEPERS.includes(standing)) {
    return {
      message: 'only the task’s owner ferret, a lead above it or the owner may change its visibility',
      allowed: KEEPERS,
    };
  }
  if ((task.askedBy ?? taskAskedBy(task)) === 'person' && to === 'private') {
    return { message: 'only the owner may make a task they asked for private', allowed: owner };
  }
  if (task.parent !== null && to === 'public') {
    return { message: 'a sub-task is private unless the owner makes it public', allowed: owner };
  }
  return null;
};
