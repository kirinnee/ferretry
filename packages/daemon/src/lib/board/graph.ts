/**
 * The board's relationships, read off the cards: parents, dependencies and what each blocker still
 * blocks (`board-design.md` §2.7). Everything here is derived from the stored cards on every read and
 * never stored, so there is no inverse index to drift.
 */
import {
  type BoardProjectId,
  type BoardTask,
  type BoardTaskId,
  categoryOf,
  formatTaskRef,
  isBlockerDone,
  type LaneCategory,
  type LaneSet,
  laneOf,
  type ReleasedIn,
  type TaskRef,
} from '@ferretry/protocol';

export type LaneSets = ReadonlyMap<BoardProjectId, LaneSet>;

/** Every card, keyed for the walks the board makes. Refs that name another machine resolve to nothing. */
export class BoardIndex {
  private readonly byId = new Map<BoardTaskId, BoardTask>();
  private readonly childrenById = new Map<BoardTaskId, BoardTask[]>();
  private readonly dependentsById = new Map<BoardTaskId, BoardTask[]>();

  constructor(
    readonly cards: readonly BoardTask[],
    readonly machineId: string,
  ) {
    for (const card of cards) this.byId.set(card.id, card);
    for (const card of cards) {
      if (card.parent !== null && this.isLocal(card.parent)) push(this.childrenById, card.parent.id, card);
      for (const dependency of card.dependsOn) {
        if (this.isLocal(dependency.task)) push(this.dependentsById, dependency.task.id, card);
      }
    }
  }

  /** Whether a ref names a card on this machine. */
  isLocal(ref: TaskRef): boolean {
    return ref.machineId === undefined || ref.machineId === this.machineId;
  }

  get(ref: TaskRef): BoardTask | undefined {
    return this.isLocal(ref) ? this.byId.get(ref.id) : undefined;
  }

  /** The cards whose parent is this one, in store order. */
  children(id: BoardTaskId): readonly BoardTask[] {
    return this.childrenById.get(id) ?? [];
  }

  /** The cards that depend on this one, in store order. */
  dependents(id: BoardTaskId): readonly BoardTask[] {
    return this.dependentsById.get(id) ?? [];
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

/** The category of the lane a card sits in, or `undefined` when its board has no lanes this build knows. */
export const cardCategory = (card: BoardTask, laneSets: LaneSets): LaneCategory | undefined => {
  const laneSet = laneSets.get(card.projectId);
  if (laneSet === undefined) return undefined;
  const category = categoryOf(laneSet, card.laneId);
  return category.ok ? category.value : undefined;
};

/** The earliest release any of the card's merged PRs shipped in. */
export const shippedIn = (card: BoardTask): ReleasedIn | null => {
  let earliest: ReleasedIn | null = null;
  for (const pr of card.links.prs) {
    if (pr.releasedIn !== null && (earliest === null || pr.releasedIn.at < earliest.at)) earliest = pr.releasedIn;
  }
  return earliest;
};

/** Whether a card is in a release: a PR shipped in one, or its lane is the one a release moves it into. */
const isReleased = (card: BoardTask, laneSets: LaneSets): boolean => {
  if (shippedIn(card) !== null) return true;
  const laneSet = laneSets.get(card.projectId);
  if (laneSet === undefined) return false;
  const lane = laneOf(laneSet, card.laneId);
  return lane.ok && lane.value.enterOn?.includes('release.published') === true;
};

/**
 * The dependencies still holding a card back: not overridden, and the blocker not done per
 * `isBlockerDone`. A blocker this machine cannot read — on another machine, quarantined, or on a board
 * with no lanes — still blocks, and so does a dropped one: its work will never ship, and the dependent's
 * ferret has to remove the dependency on purpose.
 */
export const blockedBy = (card: BoardTask, index: BoardIndex, laneSets: LaneSets): readonly TaskRef[] =>
  card.dependsOn
    .filter(dependency => {
      if (dependency.override !== undefined) return false;
      const blocker = index.get(dependency.task);
      if (blocker === undefined || blocker.dropped !== null) return true;
      const category = cardCategory(blocker, laneSets);
      return category === undefined || !isBlockerDone(category, dependency.until, isReleased(blocker, laneSets));
    })
    .map(dependency => dependency.task);

/**
 * The cycle adding `from → to` would close, as the refs in order (`&F1 → &F2 → &F1`), or `null` when the
 * graph stays acyclic. Walks the WHOLE graph from `to`, so a cycle two hops away is found too.
 */
export const dependencyCycle = (index: BoardIndex, from: BoardTaskId, to: TaskRef): string | null => {
  const visited = new Set<BoardTaskId>();
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
