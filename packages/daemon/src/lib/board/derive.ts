/**
 * A card's read-time view (`board-design.md` §2.4, "derived at read time, never stored"): the stored card
 * plus what follows from the other cards, session liveness and the agenda.
 *
 * - `blockedBy`, `blocks`, `rollup`, `suggestedLane` and `shippedIn` are computed here, from the cards.
 * - `lastTouchedAt`, `touchedBy` and `activity` come from the {@link ActivityDeriver} port.
 * - `waitingOnOwner` and `openAsks` come from the {@link AgendaLinkSource} port (U7).
 * - `origin` and `humanParent` come from the card and its ancestors (`origin.ts`), with the lineage of the
 *   sessions a card was recorded from read through the {@link SessionParents} port.
 */
import {
  type BoardTask,
  type BoardTaskId,
  type BoardTaskView,
  firstLaneOfCategory,
  LANE_CATEGORIES,
  type LaneCategory,
  type Rollup,
} from '@ferretry/protocol';
import { type BoardIndex, blockedBy, cardCategory, type LaneSets, shippedIn } from './graph.ts';
import { askSessionOf, cardOrigin, humanParentOf, type OriginFacts } from './origin.ts';
import type { ActivityDeriver, AgendaLinkSource, CardActivity, CardAsks, SessionParents } from './ports.ts';

export interface DerivationInputs {
  readonly index: BoardIndex;
  readonly laneSets: LaneSets;
  readonly activity: ReadonlyMap<BoardTaskId, CardActivity>;
  readonly asks: ReadonlyMap<BoardTaskId, CardAsks>;
  /** Which sessions a ferret started; absent, every session reads as the owner's. */
  readonly origins?: OriginFacts;
}

/** A card the deriver said nothing about has had no activity anyone measured. */
export const UNOBSERVED: CardActivity = { lastTouchedAt: null, touchedBy: null, activity: 'idle' };
const NO_ASKS: CardAsks = { open: [], blocking: [] };
const OWNER_STARTED: OriginFacts = { startedByFerret: () => false };

const rank = (category: LaneCategory): number => LANE_CATEGORIES.indexOf(category);

const later = (left: string | null, right: string | null): string | null =>
  left === null ? right : right === null || left >= right ? left : right;

/** The live (not dropped) children of a card. */
const liveChildren = (card: BoardTask, index: BoardIndex): readonly BoardTask[] =>
  index.children(card.id).filter(child => child.dropped === null);

/** The latest touch over every descendant, however deep; a loop in `parent` is walked once. */
const descendantsTouchedAt = (card: BoardTask, inputs: DerivationInputs): string | null => {
  const seen = new Set<BoardTaskId>([card.id]);
  let latest: string | null = null;
  const queue = [...liveChildren(card, inputs.index)];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (seen.has(next.id)) continue;
    seen.add(next.id);
    latest = later(latest, (inputs.activity.get(next.id) ?? UNOBSERVED).lastTouchedAt);
    queue.push(...liveChildren(next, inputs.index));
  }
  return latest;
};

/** A parent's children, summed. A child on a board with no lanes this build knows is not counted. */
export const rollupOf = (card: BoardTask, inputs: DerivationInputs): Rollup => {
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
  for (const child of liveChildren(card, inputs.index)) {
    const category = cardCategory(child, inputs.laneSets);
    if (category === undefined) continue;
    children += 1;
    byCategory[category] += 1;
    if ((inputs.activity.get(child.id) ?? UNOBSERVED).activity === 'active') active += 1;
  }
  return { children, byCategory, active, lastTouchedAt: descendantsTouchedAt(card, inputs) };
};

/**
 * The lane the children suggest (§2.5 "Children are Merged — move?"): once every live child is in a
 * later category than the parent, the first lane of the furthest category they have ALL reached that
 * the parent's variant walks. Never `closed`, which is the owner's; `null` when there is nothing to say.
 */
export const suggestedLaneOf = (card: BoardTask, inputs: DerivationInputs): string | null => {
  const laneSet = inputs.laneSets.get(card.projectId);
  const own = cardCategory(card, inputs.laneSets);
  const children = liveChildren(card, inputs.index);
  if (laneSet === undefined || own === undefined || card.dropped !== null || children.length === 0) return null;
  let reached = rank('closed');
  for (const child of children) {
    const category = cardCategory(child, inputs.laneSets);
    if (category === undefined) return null;
    reached = Math.min(reached, rank(category));
  }
  for (let target = Math.min(reached, rank('verify')); target > rank(own); target -= 1) {
    const lane = firstLaneOfCategory(laneSet, card.workflow, LANE_CATEGORIES[target] as LaneCategory);
    if (lane.ok) return lane.value.id;
  }
  return null;
};

/** One card's whole view. */
export const deriveView = (card: BoardTask, inputs: DerivationInputs): BoardTaskView => {
  const activity = inputs.activity.get(card.id) ?? UNOBSERVED;
  const asks = inputs.asks.get(card.id) ?? NO_ASKS;
  const origins = inputs.origins ?? OWNER_STARTED;
  return {
    ...card,
    lastTouchedAt: activity.lastTouchedAt,
    touchedBy: activity.touchedBy,
    activity: activity.activity,
    rollup: rollupOf(card, inputs),
    suggestedLane: suggestedLaneOf(card, inputs),
    waitingOnOwner: [...asks.blocking],
    openAsks: [...asks.open],
    blockedBy: [...blockedBy(card, inputs.index, inputs.laneSets)],
    blocks: inputs.index
      .dependents(card.id)
      .filter(dependent => dependent.dropped === null)
      .map(dependent => ({ id: dependent.id })),
    shippedIn: shippedIn(card),
    origin: cardOrigin(card, origins),
    humanParent: humanParentOf(card, inputs.index, ancestor => cardOrigin(ancestor, origins)),
  };
};

/**
 * What one card's view reads ({@link deriveView}): the card, every live descendant (its roll-up and the
 * activity rolled up into it) and every ancestor on this machine (its human parent). A loop in `parent`
 * is walked once. Deriving these alone gives that card exactly the view a whole-board read gives it.
 */
export const neighbourhoodOf = (card: BoardTask, index: BoardIndex): readonly BoardTask[] => {
  const seen = new Map<BoardTaskId, BoardTask>([[card.id, card]]);
  const queue = [...liveChildren(card, index)];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (seen.has(next.id)) continue;
    seen.set(next.id, next);
    queue.push(...liveChildren(next, index));
  }
  let parent = card.parent === null ? undefined : index.get(card.parent);
  while (parent !== undefined && !seen.has(parent.id)) {
    seen.set(parent.id, parent);
    parent = parent.parent === null ? undefined : index.get(parent.parent);
  }
  return [...seen.values()];
};

/**
 * Asks the two ports about a set of cards at once, so a page costs one call to each. The agenda
 * answers first: a blocking ask is part of what makes a card `waiting`.
 *
 * `board` is every card whose ferrets' agendas are read: an item about one card may sit in the agenda of
 * another card's ferret, so a subset still reads the whole board's ferrets and keeps only its own asks.
 */
export const gatherDerivation = async (
  cards: readonly BoardTask[],
  index: BoardIndex,
  laneSets: LaneSets,
  ports: {
    readonly activity: ActivityDeriver;
    readonly agenda: AgendaLinkSource;
    readonly parents?: SessionParents;
  },
  board: readonly BoardTask[] = cards,
): Promise<DerivationInputs> => {
  const asks = await ports.agenda.asksFor(cards, board);
  const activity = await ports.activity.derive({ cards, index, laneSets, asks });
  if (ports.parents === undefined) return { index, laneSets, activity, asks };
  return { index, laneSets, activity, asks, origins: await originFacts(cards, ports.parents) };
};

/**
 * Which of the sessions the cards were recorded from a ferret started, asked once per session. A session
 * whose lineage cannot be read reads as the owner's, so a card is never hidden on a failed read.
 */
const originFacts = async (cards: readonly BoardTask[], parents: SessionParents): Promise<OriginFacts> => {
  const sessions = [...new Set(cards.flatMap(card => askSessionOf(card) ?? []))];
  const parented = await Promise.all(
    sessions.map(async session =>
      (await parents.parentOf(session).catch(() => undefined)) === undefined ? [] : [session],
    ),
  );
  const started = new Set(parented.flat());
  return { startedByFerret: session => started.has(session) };
};
