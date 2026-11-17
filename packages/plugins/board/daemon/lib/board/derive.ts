/**
 * A task's read-time view (`board-design.md` §2.4, "derived at read time, never stored"): the stored task
 * plus what follows from the other tasks, session liveness and the agenda.
 *
 * - `blockedBy`, `blocks`, `rollup`, `suggestedLane` and `shippedIn` are computed here, from the tasks.
 * - `lastTouchedAt`, `touchedBy` and `activity` come from the {@link ActivityDeriver} port.
 * - `openAsks` comes from the {@link TaskAskLinkSource} port (U7).
 * - `askedBy` is the one the task was stored with, else (a task from before it was stored) read from its ask's source (`origin.ts`).
 * - `origin` and `humanParent` come from the task and its ancestors (`origin.ts`), with the lineage of the
 *   sessions a task was recorded from read through the {@link FerretParents} port.
 */
import {
  type Task,
  type TaskId,
  type TaskView,
  firstLaneOfCategory,
  LANE_CATEGORIES,
  type LaneCategory,
  type Rollup,
} from '../../../contract/index.ts';
import { type BoardIndex, blockedBy, taskCategory, type LaneSets, shippedIn } from './graph.ts';
import { askFerretOf, taskAskedBy, taskOrigin, humanParentOf, type OriginFacts } from './origin.ts';
import type { ActivityDeriver, TaskAskLinkSource, TaskActivityFacts, TaskAsks, FerretParents } from './ports.ts';
import { taskVisibility } from './visibility.ts';

export interface DerivationInputs {
  readonly index: BoardIndex;
  readonly laneSets: LaneSets;
  readonly activity: ReadonlyMap<TaskId, TaskActivityFacts>;
  readonly asks: ReadonlyMap<TaskId, TaskAsks>;
  /** Which sessions a ferret started; absent, every session reads as the owner's. */
  readonly origins?: OriginFacts;
}

/** A task the deriver said nothing about has had no activity anyone measured. */
export const UNOBSERVED: TaskActivityFacts = { lastTouchedAt: null, touchedBy: null, activity: 'idle' };
const NO_ASKS: TaskAsks = { open: [], asking: [] };
const OWNER_STARTED: OriginFacts = { startedByFerret: () => false };

const rank = (category: LaneCategory): number => LANE_CATEGORIES.indexOf(category);

const later = (left: string | null, right: string | null): string | null =>
  left === null ? right : right === null || left >= right ? left : right;

/** The live (not dropped) children of a task. */
const liveChildren = (task: Task, index: BoardIndex): readonly Task[] =>
  index.children(task.id).filter(child => child.dropped === null);

/** The latest touch over every descendant, however deep; a loop in `parent` is walked once. */
const descendantsTouchedAt = (task: Task, inputs: DerivationInputs): string | null => {
  const seen = new Set<TaskId>([task.id]);
  let latest: string | null = null;
  const queue = [...liveChildren(task, inputs.index)];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (seen.has(next.id)) continue;
    seen.add(next.id);
    latest = later(latest, (inputs.activity.get(next.id) ?? UNOBSERVED).lastTouchedAt);
    queue.push(...liveChildren(next, inputs.index));
  }
  return latest;
};

/** A parent's children, summed. A child on a board with no lanes this build knows is not counted. */
export const rollupOf = (task: Task, inputs: DerivationInputs): Rollup => {
  const byCategory: Record<LaneCategory, number> = {
    backlog: 0,
    active: 0,
    review: 0,
    shipped: 0,
    verify: 0,
    closed: 0,
  };
  let children = 0;
  let active = 0;
  for (const child of liveChildren(task, inputs.index)) {
    const category = taskCategory(child, inputs.laneSets);
    if (category === undefined) continue;
    children += 1;
    byCategory[category] += 1;
    if ((inputs.activity.get(child.id) ?? UNOBSERVED).activity === 'active') active += 1;
  }
  return { children, byCategory, active, lastTouchedAt: descendantsTouchedAt(task, inputs) };
};

/**
 * The lane the children suggest (§2.5 "Children are Merged — move?"): once every live child is in a
 * later category than the parent, the first lane of the furthest category they have ALL reached that
 * the parent's variant walks. Never `closed`, which is the owner's; `null` when there is nothing to say.
 */
export const suggestedLaneOf = (task: Task, inputs: DerivationInputs): string | null => {
  const laneSet = inputs.laneSets.get(task.projectId);
  const own = taskCategory(task, inputs.laneSets);
  const children = liveChildren(task, inputs.index);
  if (laneSet === undefined || own === undefined || task.dropped !== null || children.length === 0) return null;
  let reached = rank('closed');
  for (const child of children) {
    const category = taskCategory(child, inputs.laneSets);
    if (category === undefined) return null;
    reached = Math.min(reached, rank(category));
  }
  for (let target = Math.min(reached, rank('verify')); target > rank(own); target -= 1) {
    const lane = firstLaneOfCategory(laneSet, task.workflow, LANE_CATEGORIES[target] as LaneCategory);
    if (lane.ok) return lane.value.id;
  }
  return null;
};

/** One task's whole view. */
export const deriveView = (task: Task, inputs: DerivationInputs): TaskView => {
  const activity = inputs.activity.get(task.id) ?? UNOBSERVED;
  const asks = inputs.asks.get(task.id) ?? NO_ASKS;
  const origins = inputs.origins ?? OWNER_STARTED;
  return {
    ...task,
    lastTouchedAt: activity.lastTouchedAt,
    touchedBy: activity.touchedBy,
    activity: activity.activity,
    rollup: rollupOf(task, inputs),
    suggestedLane: suggestedLaneOf(task, inputs),
    openAsks: [...asks.open],
    blockedBy: [...blockedBy(task, inputs.index, inputs.laneSets)],
    blocks: inputs.index
      .dependents(task.id)
      .filter(dependent => dependent.dropped === null)
      .map(dependent => ({ id: dependent.id })),
    shippedIn: shippedIn(task),
    origin: taskOrigin(task, origins),
    askedBy: task.askedBy ?? taskAskedBy(task),
    visibility: taskVisibility(task),
    humanParent: humanParentOf(task, inputs.index, ancestor => taskOrigin(ancestor, origins)),
  };
};

/**
 * What one task's view reads ({@link deriveView}): the task, every live descendant (its roll-up and the
 * activity rolled up into it) and every ancestor on this machine (its human parent). A loop in `parent`
 * is walked once. Deriving these alone gives that task exactly the view a whole-board read gives it.
 */
export const neighbourhoodOf = (task: Task, index: BoardIndex): readonly Task[] => {
  const seen = new Map<TaskId, Task>([[task.id, task]]);
  const queue = [...liveChildren(task, index)];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (seen.has(next.id)) continue;
    seen.set(next.id, next);
    queue.push(...liveChildren(next, index));
  }
  let parent = task.parent === null ? undefined : index.get(task.parent);
  while (parent !== undefined && !seen.has(parent.id)) {
    seen.set(parent.id, parent);
    parent = parent.parent === null ? undefined : index.get(parent.parent);
  }
  return [...seen.values()];
};

/**
 * Asks the two ports about a set of tasks at once, so a page costs one call to each. The agenda
 * answers first: an open task ask on its agenda keeps a task from going stale. Asks is read once for the set,
 * so a neighbourhood costs the same one read as the whole board.
 */
export const gatherDerivation = async (
  tasks: readonly Task[],
  index: BoardIndex,
  laneSets: LaneSets,
  ports: {
    readonly activity: ActivityDeriver;
    readonly asks: TaskAskLinkSource;
    readonly parents?: FerretParents;
  },
  signal?: AbortSignal,
): Promise<DerivationInputs> => {
  const asks = await ports.asks.asksFor(tasks, signal);
  const activity = await ports.activity.derive({ cards: tasks, index, laneSets, asks });
  if (ports.parents === undefined) return { index, laneSets, activity, asks };
  return { index, laneSets, activity, asks, origins: await originFacts(tasks, ports.parents) };
};

/**
 * Which of the sessions the tasks were recorded from a ferret started, asked once per session. A session
 * whose lineage cannot be read reads as the owner's, so a task is never hidden on a failed read.
 */
const originFacts = async (tasks: readonly Task[], parents: FerretParents): Promise<OriginFacts> => {
  const sessions = [...new Set(tasks.flatMap(task => askFerretOf(task) ?? []))];
  const parented = await Promise.all(
    sessions.map(async session =>
      (await parents.parentOf(session).catch(() => undefined)) === undefined ? [] : [session],
    ),
  );
  const started = new Set(parented.flat());
  return { startedByFerret: session => started.has(session) };
};
