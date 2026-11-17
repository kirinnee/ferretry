/**
 * The board's relationships, read off the tasks: parents, dependencies and what each blocker still
 * blocks (`board-design.md` §2.7). Everything here is derived from the stored tasks on every read and
 * never stored, so there is no inverse index to drift.
 */
import {
  type BoardProjectId,
  type Task,
  type TaskId,
  categoryOf,
  formatTaskRef,
  isBlockerDone,
  type LaneCategory,
  type LaneSet,
  laneOf,
  type ReleasedIn,
  type TaskRef,
} from '../../../contract/index.ts';

export type LaneSets = ReadonlyMap<BoardProjectId, LaneSet>;

/** Every task, keyed for the walks the board makes. Refs that name another machine resolve to nothing. */
export class BoardIndex {
  private readonly byId = new Map<TaskId, Task>();
  private readonly childrenById = new Map<TaskId, Task[]>();
  private readonly dependentsById = new Map<TaskId, Task[]>();

  constructor(
    readonly cards: readonly Task[],
    readonly machineId: string,
  ) {
    for (const task of cards) this.byId.set(task.id, task);
    for (const task of cards) {
      if (task.parent !== null && this.isLocal(task.parent)) push(this.childrenById, task.parent.id, task);
      for (const dependency of task.dependsOn) {
        if (this.isLocal(dependency.task)) push(this.dependentsById, dependency.task.id, task);
      }
    }
  }

  /** Whether a ref names a task on this machine. */
  isLocal(ref: TaskRef): boolean {
    return ref.machineId === undefined || ref.machineId === this.machineId;
  }

  get(ref: TaskRef): Task | undefined {
    return this.isLocal(ref) ? this.byId.get(ref.id) : undefined;
  }

  /** The tasks whose parent is this one, in store order. */
  children(id: TaskId): readonly Task[] {
    return this.childrenById.get(id) ?? [];
  }

  /** The tasks that depend on this one, in store order. */
  dependents(id: TaskId): readonly Task[] {
    return this.dependentsById.get(id) ?? [];
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

/** The category of the lane a task sits in, or `undefined` when its board has no lanes this build knows. */
export const taskCategory = (task: Task, laneSets: LaneSets): LaneCategory | undefined => {
  const laneSet = laneSets.get(task.projectId);
  if (laneSet === undefined) return undefined;
  const category = categoryOf(laneSet, task.laneId);
  return category.ok ? category.value : undefined;
};

/** The earliest release any of the task's merged PRs shipped in. */
export const shippedIn = (task: Task): ReleasedIn | null => {
  let earliest: ReleasedIn | null = null;
  for (const pr of task.links.prs) {
    if (pr.releasedIn !== null && (earliest === null || pr.releasedIn.at < earliest.at)) earliest = pr.releasedIn;
  }
  return earliest;
};

/** Whether a task is in a release: a PR shipped in one, or its lane is the one a release moves it into. */
const isReleased = (task: Task, laneSets: LaneSets): boolean => {
  if (shippedIn(task) !== null) return true;
  const laneSet = laneSets.get(task.projectId);
  if (laneSet === undefined) return false;
  const lane = laneOf(laneSet, task.laneId);
  return lane.ok && lane.value.enterOn?.includes('release.published') === true;
};

/**
 * The dependencies still holding a task back: not overridden, and the blocker not done per
 * `isBlockerDone`. A blocker this machine cannot read — on another machine, quarantined, or on a board
 * with no lanes — still blocks, and so does a dropped one: its work will never ship, and the dependent's
 * ferret has to remove the dependency on purpose.
 */
export const blockedBy = (task: Task, index: BoardIndex, laneSets: LaneSets): readonly TaskRef[] =>
  task.dependsOn
    .filter(dependency => {
      if (dependency.override !== undefined) return false;
      const blocker = index.get(dependency.task);
      if (blocker === undefined || blocker.dropped !== null) return true;
      const category = taskCategory(blocker, laneSets);
      return category === undefined || !isBlockerDone(category, dependency.until, isReleased(blocker, laneSets));
    })
    .map(dependency => dependency.task);

/** How many of a task's live sub-cards are still being built: in a backlog, active or review lane. */
export const stillBuilding = (task: Task, index: BoardIndex, laneSets: LaneSets): number =>
  index.children(task.id).filter(child => {
    if (child.dropped !== null) return false;
    const category = taskCategory(child, laneSets);
    return category === 'backlog' || category === 'active' || category === 'review';
  }).length;

/**
 * The cycle adding `from → to` would close, as the refs in order (`&F1 → &F2 → &F1`), or `null` when the
 * graph stays acyclic. Walks the WHOLE graph from `to`, so a cycle two hops away is found too.
 */
export const dependencyCycle = (index: BoardIndex, from: TaskId, to: TaskRef): string | null => {
  const visited = new Set<TaskId>();
  const walk = (ref: TaskRef, path: readonly TaskRef[]): readonly TaskRef[] | null => {
    if (!index.isLocal(ref)) return null;
    if (ref.id === from) return path;
    if (visited.has(ref.id)) return null;
    visited.add(ref.id);
    for (const dependency of index.get(ref)?.dependsOn ?? []) {
      const found = walk(dependency.task, [...path, dependency.task]);
      if (found !== null) return found;
    }
    return null;
  };
  const cycle = walk(to, [{ id: from }, to]);
  return cycle === null ? null : cycle.map(formatTaskRef).join(' → ');
};

/**
 * Whether putting `task` under `parent` would close a loop in the parent chain: `parent` is `task` itself,
 * or one of its descendants. The walk is bounded by the chain's own length and stops at a repeat.
 */
export const parentLoop = (index: BoardIndex, task: TaskId, parent: TaskRef): boolean => {
  const seen = new Set<TaskId>();
  let next: TaskRef | null = parent;
  while (next !== null && index.isLocal(next) && !seen.has(next.id)) {
    if (next.id === task) return true;
    seen.add(next.id);
    next = index.get(next)?.parent ?? null;
  }
  return false;
};
