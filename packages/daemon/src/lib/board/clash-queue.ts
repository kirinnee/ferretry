/**
 * CLASHING WORK WAITS ITS TURN (docs/design/clash-queue.md, &I38). The owner: _"make sure that features that will
 * conflcit gets "queued up", and add depends on on the board, and wait for that feature to be built before merging."_
 *
 * A card says what it will touch with its advisory file claims (`files`). When a claim lands, the card that claimed
 * LATER is queued behind every open card on the same board that already claims a clashing path: the daemon adds a
 * `dependsOn` (`until: shipped`) and a note naming the paths, in the same write as the claim. First come, first
 * merged. The work itself still runs in parallel; only the merge waits (the merger asks `fy task merge-gate`).
 *
 * Pure: the caller hands in the card, the claims it just made, and the board as read inside the board-wide
 * dependency section, so two clashing claims are decided one after the other and cannot miss each other.
 */
import {
  type BoardActor,
  type BoardTask,
  type BoardTaskEvent,
  formatTaskRef,
  isBlockerDone,
  MAX_BOARD_DEPENDENCIES,
  type TaskRef,
} from '@ferretry/protocol';
import { type BoardIndex, cardCategory, dependencyCycle, type LaneSets } from './graph.ts';

/** How much of each path a note quotes, so two long paths still fit in one note. */
const QUOTED_PATH_LENGTH = 400;

/** The prefix of the note a queued card carries; `fy task file` and `fy task create` print these notes back. */
export const CLASH_QUEUED_PREFIX = 'queued behind';

/**
 * A claim as compared: no leading `./`, no repeated or trailing `/`. The empty string is the repository root (`.`,
 * `./`), which holds every path.
 */
export const normaliseClaim = (path: string): string => {
  const normal = path
    .trim()
    .replace(/\/{2,}/gu, '/')
    .replace(/^(?:\.\/)+/u, '')
    .replace(/\/+$/u, '');
  return normal === '.' ? '' : normal;
};

/** Whether two claims touch the same files: the same path, or one is a folder the other sits inside. */
export const claimsClash = (a: string, b: string): boolean => {
  const left = normaliseClaim(a);
  const right = normaliseClaim(b);
  if (left === right || left === '' || right === '') return true;
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
};

/** One card a claim clashes with, and the first pair of paths that clash. */
interface Clash {
  readonly task: TaskRef;
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

const ancestorIds = (card: BoardTask, index: BoardIndex): ReadonlySet<string> => {
  const seen = new Set<string>();
  let parent = card.parent === null ? undefined : index.get(card.parent);
  while (parent !== undefined && !seen.has(parent.id)) {
    seen.add(parent.id);
    parent = parent.parent === null ? undefined : index.get(parent.parent);
  }
  return seen;
};

const descendantIds = (card: BoardTask, index: BoardIndex): ReadonlySet<string> => {
  const seen = new Set<string>();
  const pending = [...index.children(card.id)];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (seen.has(next.id)) continue;
    seen.add(next.id);
    pending.push(...index.children(next.id));
  }
  return seen;
};

/** Whether a card can hold another back: open, not dropped, and its work not shipped yet. */
const inQueue = (card: BoardTask, laneSets: LaneSets): boolean => {
  if (card.dropped !== null) return false;
  const category = cardCategory(card, laneSets);
  return category !== undefined && !isBlockerDone(category, 'shipped');
};

/** Whether the card's ferret already took this card out of its queue on purpose (`fy task undepend`). */
const releasedOnPurpose = (card: BoardTask, other: TaskRef): boolean =>
  card.history.some(event => event.type === 'undepended' && event.task.id === other.id);

const firstClash = (claimed: readonly string[], theirs: readonly string[]): Omit<Clash, 'task'> | undefined => {
  for (const ours of claimed) {
    const match = theirs.find(path => claimsClash(ours, path));
    if (match !== undefined) return { ours, theirs: match };
  }
  return undefined;
};

/**
 * The cards a claim queues this card behind. Skipped: the card itself, its ancestors and descendants (a sub-card
 * overlaps its lead's claims by design), cards on other boards, cards it already depends on or took out of its
 * queue on purpose, and cards not in the queue. A clash whose dependency would close a cycle is reported, not added.
 */
export const planClashes = (
  card: BoardTask,
  claimed: readonly string[],
  index: BoardIndex,
  laneSets: LaneSets,
): ClashPlan => {
  if (claimed.length === 0) return { waits: [], unqueued: [] };
  const family = new Set([card.id, ...ancestorIds(card, index), ...descendantIds(card, index)]);
  const waits: Clash[] = [];
  const unqueued: (Clash & { why: string })[] = [];
  let room = MAX_BOARD_DEPENDENCIES - card.dependsOn.length;
  for (const other of index.cards) {
    if (family.has(other.id) || other.projectId !== card.projectId || other.files.length === 0) continue;
    if (card.dependsOn.some(dependency => dependency.task.id === other.id && index.isLocal(dependency.task))) continue;
    if (!inQueue(other, laneSets) || releasedOnPurpose(card, other)) continue;
    const pair = firstClash(claimed, other.files);
    if (pair === undefined) continue;
    const clash: Clash = { task: { id: other.id }, ...pair };
    const cycle = dependencyCycle(index, card.id, clash.task);
    if (cycle !== null) {
      unqueued.push({ ...clash, why: `${formatTaskRef(other)} already waits on this card (${cycle})` });
    } else if (room <= 0) {
      unqueued.push({ ...clash, why: `this card already has the most dependencies a card may hold` });
    } else {
      waits.push(clash);
      room -= 1;
    }
  }
  return { waits, unqueued };
};

const quoted = (path: string): string =>
  path.length <= QUOTED_PATH_LENGTH ? path : `${path.slice(0, QUOTED_PATH_LENGTH - 1)}…`;

const overlap = (clash: Clash): string =>
  normaliseClaim(clash.ours) === normaliseClaim(clash.theirs)
    ? `both claim ${quoted(clash.ours)}`
    : `${quoted(clash.ours)} overlaps its claim ${quoted(clash.theirs)}`;

/** The note a queued card carries: who it waits on and why. */
const queuedNote = (clash: Clash): string =>
  `${CLASH_QUEUED_PREFIX} ${formatTaskRef(clash.task)} to merge: ${overlap(clash)}. It can be built now; its PR merges after ${formatTaskRef(clash.task)} ships.`;

/** The note a clash that could not be queued leaves, so a lead still sees it. */
const unqueuedNote = (clash: Clash & { readonly why: string }): string =>
  `clashes with ${formatTaskRef(clash.task)} (${overlap(clash)}) but was not queued: ${clash.why}`;

type NewEvent = BoardTaskEvent extends infer E
  ? E extends BoardTaskEvent
    ? Omit<E, 'seq' | 'at' | 'actor' | 'actorVia'>
    : never
  : never;

const appended = (card: BoardTask, event: NewEvent, at: string, actor: BoardActor): BoardTask => ({
  ...card,
  history: [...card.history, { ...event, seq: card.history.length + 1, at, actor } as BoardTaskEvent],
});

/** The facts a queue write needs: the board as read in the dependency section, the time, and who made the claim. */
export interface ClashContext {
  readonly index: BoardIndex;
  readonly laneSets: LaneSets;
  readonly now: string;
  /** Who made the claim; the dependency is recorded as the daemon's, acting for that session. */
  readonly actor: BoardActor;
}

/**
 * The card with its claims queued: one `depended` event and one note per card it now waits on, and a note per clash
 * that could not be queued. The events are the daemon's, for the session that made the claim. Unchanged when
 * nothing clashes.
 */
export const queueBehindClashes = (card: BoardTask, claimed: readonly string[], context: ClashContext): BoardTask => {
  const plan = planClashes(card, claimed, context.index, context.laneSets);
  const daemon: BoardActor =
    context.actor.sessionId === undefined ? { kind: 'daemon' } : { kind: 'daemon', sessionId: context.actor.sessionId };
  let queued = card;
  for (const clash of plan.waits) {
    queued = appended(queued, { type: 'depended', task: clash.task, until: 'shipped' }, context.now, daemon);
    queued = appended(queued, { type: 'note', text: queuedNote(clash) }, context.now, daemon);
    queued = { ...queued, dependsOn: [...queued.dependsOn, { task: clash.task, until: 'shipped' }] };
  }
  for (const clash of plan.unqueued) {
    queued = appended(queued, { type: 'note', text: unqueuedNote(clash) }, context.now, daemon);
  }
  return queued;
};
