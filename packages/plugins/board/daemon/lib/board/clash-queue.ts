/**
 * CLASHING WORK WAITS ITS TURN (docs/design/clash-queue.md, &I38). The owner: _"make sure that features that will
 * conflcit gets "queued up", and add depends on on the board, and wait for that feature to be built before merging."_
 *
 * A card says what it will touch with its advisory file claims (`files`). When a claim lands, the card that claimed
 * LATER is queued behind every open card on the same board that already claims a clashing path: the daemon adds a
 * `dependsOn` (`until: shipped`) and a note naming the paths, in the same write as the claim. First come, first
 * merged. The work itself still runs in parallel; only the merge waits (the merger asks `fy card merge-gate`).
 *
 * Pure: the caller hands in the card, the claims it just made, and the board as read inside the board-wide
 * dependency section, so two clashing claims are decided one after the other and cannot miss each other.
 */
import { type CardActor, type Card, type CardEvent, formatCardRef, isBlockerDone, MAX_BOARD_DEPENDENCIES, type CardRef } from '../../../contract/index.ts';
import { type BoardIndex, cardCategory, dependencyCycle, type LaneSets } from './graph.ts';
import { ShippingUnits } from './shipping-unit.ts';

/** How much of each path a note quotes, so two long paths still fit in one note. */
const QUOTED_PATH_LENGTH = 400;

/** The prefix of the note a queued card carries; `fy card file` and `fy card new` print these notes back. */
export const CLASH_QUEUED_PREFIX = 'queued behind';

/**
 * A claim as compared, segment by segment: empty and `.` segments dropped, a `..` folding the segment before it (one
 * that would climb out of the repository is kept, so it matches only itself). The empty string is the repository
 * root (`.`, `./`), which holds every path.
 */
export const normaliseClaim = (path: string): string => {
  const segments: string[] = [];
  for (const segment of path.trim().split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..' && segments.length > 0 && segments.at(-1) !== '..') segments.pop();
    else segments.push(segment);
  }
  return segments.join('/');
};

/** Whether two claims touch the same files: the same path, or one is a folder the other sits inside. */
export const claimsClash = (a: string, b: string): boolean => {
  const left = normaliseClaim(a);
  const right = normaliseClaim(b);
  if (left === right || left === '' || right === '') return true;
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
};

/** One card a claim queues behind, and the first pair of paths that clash. */
interface Clash {
  /** The card to wait on: the one whose PR ships the clashing work (`ShippingUnits.shippingCard`). */
  readonly card: CardRef;
  /** The card that claims the clashing path, when it is not {@link task} itself (a helper of it). */
  readonly via?: CardRef;
  /** The path this card claims. */
  readonly ours: string;
  /** The path the other card already claims. */
  readonly theirs: string;
}

/** What a claim means for the queue: the cards to wait on, and the clashes that cannot be queued (and why). */
export interface ClashPlan {
  readonly waits: readonly Clash[];
  readonly unqueued: readonly (Clash & { readonly why: string })[];
}

/**
 * Whether a card can hold another back: not dropped, and its work not shipped yet. A card on a board whose lanes this
 * read does not hold (a lead on another board) counts: dismissing it would hide a real clash, while a wait on a card
 * that did ship is read as done wherever its lanes are known (`blockedBy`, the merge gate).
 */
const inQueue = (card: Card, laneSets: LaneSets): boolean => {
  if (card.dropped !== null) return false;
  const category = cardCategory(card, laneSets);
  return category === undefined || !isBlockerDone(category, 'shipped');
};

/** Whether the card's ferret already took this card out of its queue on purpose (`fy card undepend`). */
const releasedOnPurpose = (card: Card, other: CardRef, index: BoardIndex): boolean =>
  card.history.some(event => event.type === 'undepended' && event.task.id === other.id && index.isLocal(event.task));

const firstClash = (claimed: readonly string[], theirs: readonly string[]): Omit<Clash, 'card'> | undefined => {
  for (const ours of claimed) {
    const match = theirs.find(path => claimsClash(ours, path));
    if (match !== undefined) return { ours, theirs: match };
  }
  return undefined;
};

const addEdge = (edges: Map<string, Set<string>>, from: string, to: string): void => {
  const out = edges.get(from) ?? new Set<string>();
  out.add(to);
  edges.set(from, out);
};

/**
 * The waits between shipping units, as the board stands: an edge from every unit a card rides to the unit of each
 * card it still waits on. A blocker whose lanes are unknown still counts, so a cycle is over-reported, never missed.
 */
const unitWaits = (index: BoardIndex, laneSets: LaneSets, units: ShippingUnits): Map<string, Set<string>> => {
  const edges = new Map<string, Set<string>>();
  for (const card of index.cards) {
    if (card.dropped !== null) continue;
    for (const dependency of card.dependsOn) {
      const blocker = index.get(dependency.task);
      if (dependency.override !== undefined || blocker === undefined) continue;
      const category = cardCategory(blocker, laneSets);
      if (category !== undefined && isBlockerDone(category, dependency.until)) continue;
      for (const from of units.rides(card)) addEdge(edges, from, units.key(blocker));
    }
  }
  return edges;
};

/** Whether the unit `to` already waits, however indirectly, on one of the units in `from`. */
const reaches = (edges: ReadonlyMap<string, ReadonlySet<string>>, to: string, from: ReadonlySet<string>): boolean => {
  const seen = new Set<string>();
  const pending = [to];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (from.has(next)) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    pending.push(...(edges.get(next) ?? []));
  }
  return false;
};

/**
 * The cards a claim queues this card behind (docs/design/clash-queue.md § Detecting a clash): for each card on the same
 * board whose claims clash, not dropped and whose shipping card has not shipped (a helper that already closed still
 * counts while its lead's PR is open), that card's SHIPPING CARD (`ShippingUnits`). Skipped: a card in the same
 * shipping unit (they merge together), and a shipping card it already depends on or took out of its queue on purpose.
 * A clash whose wait would close a cycle between units — or between cards — or would pass the most dependencies a card
 * may hold, is reported, not added.
 */
export const planClashes = (
  card: Card,
  claimed: readonly string[],
  index: BoardIndex,
  laneSets: LaneSets,
): ClashPlan => {
  if (claimed.length === 0) return { waits: [], unqueued: [] };
  const units = new ShippingUnits(index);
  const decided = new Set<string>();
  const waits: Clash[] = [];
  const unqueued: (Clash & { why: string })[] = [];
  let edges: Map<string, Set<string>> | undefined;
  let room = MAX_BOARD_DEPENDENCIES - card.dependsOn.length;
  for (const other of index.cards) {
    if (other.id === card.id || other.dropped !== null) continue;
    if (other.projectId !== card.projectId || other.files.length === 0) continue;
    const pair = firstClash(claimed, other.files);
    if (pair === undefined) continue;
    // Same unit first: a clashing card that merges with this one says nothing about the other cards its target ships.
    if (units.sameUnit(card, other)) continue;
    const target = units.shippingCard(other);
    if (decided.has(target.id) || target.id === card.id || !inQueue(target, laneSets)) continue;
    decided.add(target.id);
    if (card.dependsOn.some(dependency => dependency.task.id === target.id && index.isLocal(dependency.task))) continue;
    if (releasedOnPurpose(card, target, index)) continue;
    const clash: Clash = {
      card: { id: target.id },
      ...(target.id === other.id ? {} : { via: { id: other.id } }),
      ...pair,
    };
    edges ??= unitWaits(index, laneSets, units);
    const cycle = dependencyCycle(index, card.id, clash.card);
    if (cycle !== null) {
      unqueued.push({ ...clash, why: `${formatCardRef(target)} already waits on this card (${cycle})` });
    } else if (reaches(edges, units.key(target), units.rides(card))) {
      unqueued.push({ ...clash, why: `${formatCardRef(target)}'s PR already waits on this card's PR` });
    } else if (room <= 0) {
      unqueued.push({ ...clash, why: `this card already has the most dependencies a card may hold` });
    } else {
      waits.push(clash);
      room -= 1;
      // The waits this claim adds count for the next clash in the same claim: two of them may close a cycle together.
      for (const from of units.rides(card)) addEdge(edges, from, units.key(target));
    }
  }
  return { waits, unqueued };
};

const quoted = (path: string): string =>
  path.length <= QUOTED_PATH_LENGTH ? path : `${path.slice(0, QUOTED_PATH_LENGTH - 1)}…`;

const overlap = (clash: Clash): string => {
  const words =
    normaliseClaim(clash.ours) === normaliseClaim(clash.theirs)
      ? `both claim ${quoted(clash.ours)}`
      : `${quoted(clash.ours)} overlaps its claim ${quoted(clash.theirs)}`;
  return clash.via === undefined ? words : `${words} (claimed by ${formatCardRef(clash.via)}, which ships in it)`;
};

/** The note a queued card carries: who it waits on and why. */
const queuedNote = (clash: Clash): string =>
  `${CLASH_QUEUED_PREFIX} ${formatCardRef(clash.card)} to merge: ${overlap(clash)}. It can be built now; its PR merges after ${formatCardRef(clash.card)} ships.`;

/** The note a clash that could not be queued leaves, so a lead still sees it. */
const unqueuedNote = (clash: Clash & { readonly why: string }): string =>
  `clashes with ${formatCardRef(clash.card)} (${overlap(clash)}) but was not queued: ${clash.why}`;

type NewEvent = CardEvent extends infer E
  ? E extends CardEvent
    ? Omit<E, 'seq' | 'at' | 'actor' | 'actorVia'>
    : never
  : never;

const appended = (card: Card, event: NewEvent, at: string, actor: CardActor): Card => ({
  ...card,
  history: [...card.history, { ...event, seq: card.history.length + 1, at, actor } as CardEvent],
});

/** The facts a queue write needs: the board as read in the dependency section, the time, and who made the claim. */
export interface ClashContext {
  readonly index: BoardIndex;
  readonly laneSets: LaneSets;
  readonly now: string;
  /** Who made the claim; the dependency is recorded as the daemon's, acting for that session. */
  readonly actor: CardActor;
}

/**
 * The card with its claims queued: one `depended` event and one note per card it now waits on, and a note per clash
 * that could not be queued. The events are the daemon's, for the session that made the claim. Unchanged when
 * nothing clashes.
 */
export const queueBehindClashes = (card: Card, claimed: readonly string[], context: ClashContext): Card => {
  const plan = planClashes(card, claimed, context.index, context.laneSets);
  const daemon: CardActor =
    context.actor.ferret === undefined ? { kind: 'daemon' } : { kind: 'daemon', ferret: context.actor.ferret };
  let queued = card;
  for (const clash of plan.waits) {
    queued = appended(queued, { type: 'depended', task: clash.card, until: 'shipped' }, context.now, daemon);
    queued = appended(queued, { type: 'note', text: queuedNote(clash) }, context.now, daemon);
    queued = { ...queued, dependsOn: [...queued.dependsOn, { task: clash.card, until: 'shipped' }] };
  }
  for (const clash of plan.unqueued) {
    queued = appended(queued, { type: 'note', text: unqueuedNote(clash) }, context.now, daemon);
  }
  return queued;
};
