/**
 * CARDS WAITING FOR THE OWNER'S TRY, AS INBOX ITEMS.
 *
 * A card in a verify lane (Released · to test) waits for the owner's verdict, so it belongs in the Inbox beside the
 * agenda items. This reads them out of the board model the app already holds and names, for each, the two lanes the
 * verdict moves it to — Done into the project's Done lane, Not good back to its rework lane. Nothing here moves a
 * card: the moves are the board's own (`useBoardAnswers`), so no new way to close a card exists.
 */

import type { ReleasedIn } from '@ferretry/protocol';
import { doneLaneOf, notGoodLaneOf } from './board-done.ts';
import type { BoardModel } from './board-model.ts';
import type { BoardCardOf, BoardGroupOf } from './board-view.ts';

export interface ToTestCard {
  /** The board card's own key: stable across reads, unique across machines. */
  readonly key: string;
  readonly card: BoardCardOf;
  readonly group: BoardGroupOf;
  /** Where Done closes it. */
  readonly doneLaneId: string;
  /** Where Not good sends it back. */
  readonly notGoodLaneId: string;
  readonly howToTest: string;
  /** When it started waiting for the owner: its release, else when it was last touched. */
  readonly since: string | null;
}

export const toTestKey = (card: BoardCardOf): string => `to-test:${card.key}`;

/** "Shipped in v1.2.0", or `null` for a card that has not shipped. */
export const releaseWords = (shippedIn: Pick<ReleasedIn, 'version'> | null): string | null =>
  shippedIn === null ? null : `Shipped in v${shippedIn.version}`;

const instantMs = (since: string | null): number => (since === null ? 0 : Date.parse(since));

const sinceOf = (card: BoardCardOf): string | null => card.task.shippedIn?.at ?? card.task.lastTouchedAt;

/**
 * Every card in a verify lane that the owner can answer: not dropped, and in a project whose lanes name both where
 * Done and where Not good go. Newest release first; a card with no release after those that have one.
 */
export const toTestCards = (model: BoardModel): readonly ToTestCard[] =>
  model.groups
    .flatMap(group => {
      const doneLaneId = doneLaneOf(group.laneSet);
      const notGoodLaneId = notGoodLaneOf(group.laneSet);
      if (doneLaneId === null || notGoodLaneId === null) return [];
      return group.lanes
        .filter(lane => lane.category === 'verify')
        .flatMap(lane => lane.cards)
        .filter(card => card.task.dropped === null)
        .map(
          (card): ToTestCard => ({
            key: toTestKey(card),
            card,
            group,
            doneLaneId,
            notGoodLaneId,
            howToTest: card.task.howToTest,
            since: sinceOf(card),
          }),
        );
    })
    .sort((a, b) => {
      const released = (row: ToTestCard): number => (row.card.task.shippedIn === null ? 0 : 1);
      if (released(a) !== released(b)) return released(b) - released(a);
      return instantMs(b.since) - instantMs(a.since);
    });

export interface ToTestFilter {
  readonly machine: string | null;
  readonly query: string;
  /** A source filter (`?from=warden`) or a kind filter other than All asks for agenda items only. */
  readonly agendaOnly: boolean;
}

/** The Inbox's own filters over the to-test rows: a machine, the Find box, and nothing at all under an agenda-only filter. */
export const filterToTest = (rows: readonly ToTestCard[], filter: ToTestFilter): readonly ToTestCard[] => {
  if (filter.agendaOnly) return [];
  const needle = filter.query.trim().toLowerCase();
  return rows.filter(
    row =>
      (filter.machine === null || row.card.daemonId === filter.machine) &&
      (needle === '' || `${row.card.task.title} ${row.card.task.id}`.toLowerCase().includes(needle)),
  );
};
