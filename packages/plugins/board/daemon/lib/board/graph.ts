/**
 * The board's relationships, read off the cards: parents, dependencies and what each blocker still
 * blocks (`board-design.md` §2.7). Everything here is derived from the stored cards on every read and
 * never stored, so there is no inverse index to drift.
 */
import { type BoardProjectId, type Card, type CardId, categoryOf, formatCardRef, isBlockerDone, type LaneCategory, type LaneSet, laneOf, type ReleasedIn, type CardRef } from '../../../contract/index.ts';

export type LaneSets = ReadonlyMap<BoardProjectId, LaneSet>;

/** Every card, keyed for the walks the board makes. Refs that name another machine resolve to nothing. */
export class BoardIndex {
  private readonly byId = new Map<CardId, Card>();
  private readonly childrenById = new Map<CardId, Card[]>();
  private readonly dependentsById = new Map<CardId, Card[]>();

  constructor(
    readonly cards: readonly Card[],
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
  isLocal(ref: CardRef): boolean {
    return ref.machineId === undefined || ref.machineId === this.machineId;
  }

  get(ref: CardRef): Card | undefined {
    return this.isLocal(ref) ? this.byId.get(ref.id) : undefined;
  }

  /** The cards whose parent is this one, in store order. */
  children(id: CardId): readonly Card[] {
    return this.childrenById.get(id) ?? [];
  }

  /** The cards that depend on this one, in store order. */
  dependents(id: CardId): readonly Card[] {
    return this.dependentsById.get(id) ?? [];
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

/** The category of the lane a card sits in, or `undefined` when its board has no lanes this build knows. */
export const cardCategory = (card: Card, laneSets: LaneSets): LaneCategory | undefined => {
  const laneSet = laneSets.get(card.projectId);
  if (laneSet === undefined) return undefined;
  const category = categoryOf(laneSet, card.laneId);
  return category.ok ? category.value : undefined;
};

/** The earliest release any of the card's merged PRs shipped in. */
export const shippedIn = (card: Card): ReleasedIn | null => {
  let earliest: ReleasedIn | null = null;
  for (const pr of card.links.prs) {
    if (pr.releasedIn !== null && (earliest === null || pr.releasedIn.at < earliest.at)) earliest = pr.releasedIn;
  }
  return earliest;
};

/** Whether a card is in a release: a PR shipped in one, or its lane is the one a release moves it into. */
const isReleased = (card: Card, laneSets: LaneSets): boolean => {
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
export const blockedBy = (card: Card, index: BoardIndex, laneSets: LaneSets): readonly CardRef[] =>
  card.dependsOn
    .filter(dependency => {
      if (dependency.override !== undefined) return false;
      const blocker = index.get(dependency.task);
      if (blocker === undefined || blocker.dropped !== null) return true;
      const category = cardCategory(blocker, laneSets);
      return category === undefined || !isBlockerDone(category, dependency.until, isReleased(blocker, laneSets));
    })
    .map(dependency => dependency.task);

/** How many of a card's live sub-cards are still being built: in a backlog, active or review lane. */
export const stillBuilding = (card: Card, index: BoardIndex, laneSets: LaneSets): number =>
  index.children(card.id).filter(child => {
    if (child.dropped !== null) return false;
    const category = cardCategory(child, laneSets);
    return category === 'backlog' || category === 'active' || category === 'review';
  }).length;

/**
 * The cycle adding `from → to` would close, as the refs in order (`&F1 → &F2 → &F1`), or `null` when the
 * graph stays acyclic. Walks the WHOLE graph from `to`, so a cycle two hops away is found too.
 */
export const dependencyCycle = (index: BoardIndex, from: CardId, to: CardRef): string | null => {
  const visited = new Set<CardId>();
  const walk = (ref: CardRef, path: readonly CardRef[]): readonly CardRef[] | null => {
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
  return cycle === null ? null : cycle.map(formatCardRef).join(' → ');
};

/**
 * Whether putting `card` under `parent` would close a loop in the parent chain: `parent` is `card` itself,
 * or one of its descendants. The walk is bounded by the chain's own length and stops at a repeat.
 */
export const parentLoop = (index: BoardIndex, card: CardId, parent: CardRef): boolean => {
  const seen = new Set<CardId>();
  let next: CardRef | null = parent;
  while (next !== null && index.isLocal(next) && !seen.has(next.id)) {
    if (next.id === card) return true;
    seen.add(next.id);
    next = index.get(next)?.parent ?? null;
  }
  return false;
};
