/**
 * THE CARDS ONE FERRET'S CHAT READS: its ferret-scoped slice of the board, shaped for the `&` menu, the
 * chat search, and the `&F12` proof.
 *
 * One board read (`ferret = <session>`, `state = all`) through the U10 store serves all four, so nothing
 * here asks the daemon for a card by reference. A card an old session owned before the import carries
 * `legacyRef = <session>:<old id>`; `legacyIds` is the map from that old id to the card that replaced it.
 */

import type { BoardTaskView } from '@ferretry/protocol';
import type { BoardModel } from './board-model.ts';
import { taskOrigin } from './board-human.ts';
import { isMine } from './board-model.ts';
import { cardPlaces } from './board-view.ts';
import type { DaemonId } from './daemon-connection.ts';

/** What a chat shows and proves about one card. */
export interface SessionCard {
  readonly id: string;
  readonly title: string;
  /** The card face's one line, searched with the title. */
  readonly summary: string;
  /** The lane's name on the card's own board. */
  readonly lane: string;
  /** In a closed lane, or dropped: hidden from the `&` menu until its id is typed. */
  readonly closed: boolean;
  /** In an active or review lane. */
  readonly active: boolean;
  readonly assignee: string | null;
  /** The latest real activity, or the creation instant for a card never touched. */
  readonly touchedAt: string;
  /** Its ask did not come from the human: another ferret, the Warden or an auto card raised it, and nothing waits on the owner. */
  readonly agentAsked: boolean;
  /** The id this card had as an old task of this session, when it was imported from one. */
  readonly legacyId: string | null;
  /** The pull requests linked to the card, so a line naming one can open it. */
  readonly prs?: readonly { readonly number: number; readonly url: string }[];
}

/** The old id a card was imported under, when it was imported from a task of `sessionId`. */
const legacyIdOf = (task: BoardTaskView, sessionId: string): string | null => {
  const ref = task.legacyRef;
  if (ref === undefined) return null;
  const at = ref.indexOf(':');
  return ref.slice(0, at) === sessionId ? ref.slice(at + 1) : null;
};

/**
 * Whether the ask came from an agent. The daemon says so (`origin`, the same fact the Tasks panel splits on);
 * a daemon that says nothing is an older one, where "the owner raised it or waits on it" is the best proof left.
 */
const askedByAgent = (task: BoardTaskView): boolean => {
  const origin = taskOrigin(task);
  return origin === null ? !isMine(task) : origin === 'agent';
};

const cardsOf = (model: BoardModel, daemonId: DaemonId, sessionId: string, keep: (task: BoardTaskView) => boolean) => {
  const places = cardPlaces(model);
  return model.cards
    .filter(card => card.daemonId === daemonId && keep(card.task))
    .map((card): SessionCard => {
      const category = places.get(card.key)?.category ?? null;
      const task = card.task;
      return {
        id: task.id,
        title: task.title,
        summary: task.summary,
        lane: places.get(card.key)?.laneName ?? task.laneId,
        closed: task.dropped !== null || category === 'closed',
        active: category === 'active' || category === 'review',
        assignee: task.assignee,
        touchedAt: task.lastTouchedAt ?? task.createdAt,
        agentAsked: askedByAgent(task),
        legacyId: legacyIdOf(task, sessionId),
        prs: task.links.prs.map(pr => ({ number: pr.number, url: pr.url })),
      };
    });
};

/** The cards of `model` this ferret owns or is assigned, on `daemonId`. */
export const sessionCards = (model: BoardModel, daemonId: DaemonId, sessionId: string): readonly SessionCard[] =>
  cardsOf(model, daemonId, sessionId, task => task.owner === sessionId || task.assignee === sessionId);

/** Every card of `model` on `daemonId`, owned or not: a project's board as the `&` menu and the proof read it. */
export const projectCards = (model: BoardModel, daemonId: DaemonId, sessionId: string): readonly SessionCard[] =>
  cardsOf(model, daemonId, sessionId, () => true);

/** The card an old reference means, or `null`: a card id on this slice wins, then an imported task's old id. */
export const resolveCardReference = (
  cards: readonly { readonly id: string; readonly legacyId?: string | null }[],
  written: string,
): string | null => {
  const wanted = written.toUpperCase();
  const own = cards.find(card => card.id.toUpperCase() === wanted);
  if (own !== undefined) return own.id;
  return cards.find(card => card.legacyId?.toUpperCase() === wanted)?.id ?? null;
};
