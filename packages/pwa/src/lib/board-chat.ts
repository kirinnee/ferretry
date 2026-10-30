/**
 * THE BOARD, AS ONE FERRET'S CHAT SEES IT: its focus card, the cards it owns, and the cards its sub-ferrets hold.
 *
 * `mergeBoard` has already built the model; these functions only pick one ferret's part of it and say how
 * the header chip reads. They never touch the network or the clock, so each is a plain value-to-value test.
 *
 * Order, top to bottom: the focus card on its own, then the owned cards grouped by lane (the lanes' own
 * order), then the sub-ferrets' cards as a mini tree. A card is shown once: the focus card is not repeated
 * among the owned, and an owned card is not repeated among the children's.
 */

import { formatTaskRef, type LaneCategory, type SessionView, type TaskRef } from '@ferretry/protocol';
import type { BoardModel } from './board-model.ts';
import type { BoardLoadStatus } from './board-store.ts';
import {
  type BoardCardOf,
  type BoardCardPlace,
  type BoardTreeRow,
  buildTree,
  cardPlaces,
  flattenTree,
} from './board-view.ts';
import type { DaemonId } from './daemon-connection.ts';

/** Every session that descends from `sessionId`, by the `parent` links of `sessions`. */
export const descendantSessionIds = (sessions: readonly SessionView[], sessionId: string): ReadonlySet<string> => {
  const found = new Set<string>();
  let frontier = new Set([sessionId]);
  while (frontier.size > 0) {
    const next = new Set<string>();
    for (const session of sessions) {
      const parent = session.config.parent;
      if (parent !== undefined && frontier.has(parent) && !found.has(session.config.id)) {
        found.add(session.config.id);
        next.add(session.config.id);
      }
    }
    frontier = next;
  }
  return found;
};

export interface ChatWho {
  /** The machine the chat's daemon is: a card on another machine is never this ferret's. */
  readonly daemonId: DaemonId;
  readonly sessionId: string;
  /** The session's focus card, when it has one. */
  readonly focus: TaskRef | null;
  /** Its sub-ferrets, any depth (`descendantSessionIds`). */
  readonly relatives: ReadonlySet<string>;
}

/** The owned cards that sit in one lane of one board. */
interface ChatLaneGroup {
  readonly key: string;
  readonly laneName: string;
  readonly cards: readonly BoardCardOf[];
}

export interface ChatCards {
  readonly focus: BoardCardOf | null;
  readonly owned: readonly ChatLaneGroup[];
  /** The sub-ferrets' cards, a card under its parent when the parent is among them. */
  readonly children: readonly BoardTreeRow[];
  readonly places: ReadonlyMap<string, BoardCardPlace>;
  /** The same cards as Kanban columns (`chatKanban`). */
  readonly lanes: readonly ChatKanbanLane[];
  /** Every card drawn, once. */
  readonly total: number;
}

const isOn = (card: BoardCardOf, daemonId: DaemonId): boolean => card.daemonId === daemonId;

const heldBy = (card: BoardCardOf, sessions: ReadonlySet<string>): boolean =>
  sessions.has(card.task.owner) || (card.task.assignee !== null && sessions.has(card.task.assignee));

/** This ferret's part of the board: the focus card, what it owns and what its sub-ferrets hold. */
export const chatCards = (model: BoardModel, who: ChatWho): ChatCards => {
  const places = cardPlaces(model);
  const here = model.cards.filter(card => isOn(card, who.daemonId));
  const focusId = who.focus?.id ?? null;
  const focus = focusId === null ? null : (here.find(card => card.task.id === focusId) ?? null);
  const mine = new Set([who.sessionId]);
  const ownedCards = here.filter(card => card !== focus && heldBy(card, mine));

  const taken = new Set<BoardCardOf>([...(focus === null ? [] : [focus]), ...ownedCards]);
  const known = new Set([...taken].map(card => card.task.id));
  const childCards: BoardCardOf[] = [];
  let grew = true;
  while (grew) {
    grew = false;
    for (const card of here) {
      if (taken.has(card)) continue;
      const parent = card.task.parent;
      if (heldBy(card, who.relatives) || (parent !== null && known.has(parent.id))) {
        taken.add(card);
        known.add(card.task.id);
        childCards.push(card);
        grew = true;
      }
    }
  }

  const owned = new Set(ownedCards);
  const groups: ChatLaneGroup[] = [];
  for (const group of model.groups) {
    if (group.daemonId !== who.daemonId) continue;
    for (const lane of group.lanes) {
      const cards = lane.cards.filter(card => owned.has(card));
      if (cards.length > 0) groups.push({ key: `${group.key}/${lane.id}`, laneName: lane.name, cards });
    }
    const unplaced = group.unplaced.filter(card => owned.has(card));
    if (unplaced.length > 0) groups.push({ key: `${group.key}/unplaced`, laneName: 'Unplaced', cards: unplaced });
  }

  return {
    focus,
    owned: groups,
    children: flattenTree(buildTree(childCards)),
    places,
    lanes: chatKanban(model, taken, who.daemonId),
    total: taken.size,
  };
};

// ---------------------------------------------------------------------------------------------------
// The header chip and the Info row
// ---------------------------------------------------------------------------------------------------

type ChatChipTone = 'ok' | 'quiet' | 'warn' | 'pend' | 'err';

/** What the chat's header says about the session's card. */
export type ChatChip =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'card';
      readonly id: string;
      /** `&F18`. */
      readonly ref: string;
      /** The card's title; `null` until the board has been read, or once the card has left the open board. */
      readonly title: string | null;
      /** The lane's name; `null` when the card is not on the board that was read. */
      readonly lane: string | null;
      /** `active`, `idle`, `stale`, `waiting`, `waiting on you` or `orphaned`; `closed` for a card off the open board; `null` while unread. */
      readonly activity: string | null;
      readonly tone: ChatChipTone;
    };

const ACTIVITY_TONE: Readonly<Record<BoardCardOf['task']['activity'], ChatChipTone>> = {
  active: 'ok',
  idle: 'quiet',
  stale: 'warn',
  waiting: 'pend',
  orphaned: 'err',
};

/**
 * The chip for a session's focus card. A focus that names a card the open board does not hold, read to the
 * end, is a card that is closed or dropped; while the board is still being read the chip says only the id.
 */
export const chatChip = (
  focus: TaskRef | undefined,
  found: BoardCardOf | null,
  place: BoardCardPlace | undefined,
  status: BoardLoadStatus,
): ChatChip => {
  if (focus === undefined) return { kind: 'none' };
  const ref = formatTaskRef(focus);
  if (found !== null) {
    const { task } = found;
    return {
      kind: 'card',
      id: focus.id,
      ref,
      title: task.title,
      lane: place?.laneName ?? null,
      activity: task.activity === 'waiting' && task.waitingOnOwner.length > 0 ? 'waiting on you' : task.activity,
      tone: ACTIVITY_TONE[task.activity],
    };
  }
  const read = status === 'ready';
  return {
    kind: 'card',
    id: focus.id,
    ref,
    title: null,
    lane: null,
    activity: read ? 'closed' : null,
    tone: 'quiet',
  };
};

/** The chip as one sentence, for a title and a screen reader: `&F18 Board system, Plan/Design, active`. */
export const chatChipSentence = (chip: ChatChip): string => {
  if (chip.kind === 'none') return 'No card';
  return [chip.ref, chip.title, chip.lane, chip.activity].filter(part => part !== null).join(', ');
};

/** The Info row's words for a card chip: `&F18 (Plan/Design)`, or just `&F18` while its lane is unknown. */
export const chatCardLabel = (chip: Extract<ChatChip, { kind: 'card' }>): string =>
  chip.lane === null ? chip.ref : `${chip.ref} (${chip.lane})`;

/** Everything a chat's card surfaces share: the chip, the tab's cards and how far the read got. */
export interface BoardChat {
  readonly chip: ChatChip;
  readonly cards: ChatCards;
  readonly status: BoardLoadStatus;
  readonly refresh: () => void;
}

// ---------------------------------------------------------------------------------------------------
// The Kanban: the same cards, one column per lane
// ---------------------------------------------------------------------------------------------------

/** One lane of the chat's Kanban: only the cards this ferret holds, in the lane's own order. */
interface ChatKanbanLane {
  readonly key: string;
  readonly name: string;
  readonly category: LaneCategory | null;
  readonly cards: readonly BoardCardOf[];
}

/**
 * Every card the chat draws, once: the focus card, the owned cards, then the sub-ferrets'. The List and the
 * Kanban arrange this same set, so a view switch never changes which cards are there.
 */
export const chatDrawn = (cards: ChatCards): readonly BoardCardOf[] => [
  ...(cards.focus === null ? [] : [cards.focus]),
  ...cards.owned.flatMap(group => group.cards),
  ...cards.children.map(row => row.card),
];

/**
 * The chat's cards as Kanban columns. A lane with none of this ferret's cards is left out, since a pane this
 * narrow has no room for empty columns and the card count already says what is there. A project with no lane
 * set (a daemon from before lanes) keeps its cards in one `Unplaced` column rather than losing them.
 */
const chatKanban = (
  model: BoardModel,
  drawn: ReadonlySet<BoardCardOf>,
  daemonId: DaemonId,
): readonly ChatKanbanLane[] => {
  const lanes: ChatKanbanLane[] = [];
  for (const group of model.groups) {
    if (group.daemonId !== daemonId) continue;
    for (const lane of group.lanes) {
      const held = lane.cards.filter(card => drawn.has(card));
      if (held.length > 0) {
        lanes.push({ key: `${group.key}/${lane.id}`, name: lane.name, category: lane.category, cards: held });
      }
    }
    const unplaced = group.unplaced.filter(card => drawn.has(card));
    if (unplaced.length > 0) {
      lanes.push({ key: `${group.key}/unplaced`, name: 'Unplaced', category: null, cards: unplaced });
    }
  }
  return lanes;
};

/** What the card detail needs of its neighbours (children, the release each machine runs): the chat's cards. */
export const chatSiblings = (
  cards: ChatCards,
): readonly {
  readonly task: BoardCardOf['task'];
  readonly laneName: string;
  readonly runningOn: BoardCardOf['runningOn'];
}[] =>
  chatDrawn(cards).map(card => ({
    task: card.task,
    laneName: cards.places.get(card.key)?.laneName ?? card.task.laneId,
    runningOn: card.runningOn,
  }));
