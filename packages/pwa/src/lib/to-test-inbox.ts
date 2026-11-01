/**
 * CARDS WAITING FOR THE OWNER'S TRY, AS INBOX ITEMS.
 *
 * A card in a verify lane (Released · to test) waits for the owner's verdict, so it belongs in the Inbox beside the
 * agenda items. This reads them out of the board model the app already holds and names, for each, the two lanes the
 * verdict moves it to — Done into the project's Done lane, Not good back to its rework lane. Nothing here moves a
 * card: the moves are the board's own (`useBoardAnswers`), so no new way to close a card exists.
 */

import type { ReleasedIn, SessionView } from '@ferretry/protocol';
import { sessionTask } from '../shell/session-title.ts';
import { doneLaneOf, notGoodLaneOf } from './board-done.ts';
import { awaitingOwner } from './awaiting-owner.ts';
import type { BoardModel } from './board-model.ts';
import type { BoardCardOf, BoardGroupOf } from './board-view.ts';
import { displayCallsign } from './callsign.ts';

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
  /** The task the ferret that worked on it was given ("Credentials Build Lead"), never its callsign; `null` when unknown. */
  readonly taskName: string | null;
  /** The name of the project (the board) the card is on; `null` until the app knows it. */
  readonly projectName: string | null;
  /** When it started waiting for the owner: its release, else when it was last touched. */
  readonly since: string | null;
  /** The owner's snooze on it, while it is still in the lane it was snoozed in; `null` when never snoozed or moved on. */
  readonly snoozedUntil: string | null;
}

export const toTestKey = (card: BoardCardOf): string => `to-test:${card.key}`;

/** "Shipped in v1.2.0", or `null` for a card that has not shipped. */
export const releaseWords = (shippedIn: Pick<ReleasedIn, 'version'> | null): string | null =>
  shippedIn === null ? null : `Shipped in v${shippedIn.version}`;

const instantMs = (since: string | null): number => (since === null ? 0 : Date.parse(since));

const sinceOf = (card: BoardCardOf): string | null => card.task.shippedIn?.at ?? card.task.lastTouchedAt;

/** A snooze holds only in the lane it was made in: a card sent back and released again is not hidden by an old one. */
const snoozedUntilOf = (card: BoardCardOf): string | null => {
  const { snoozed, laneId } = card.task;
  return snoozed == null || snoozed.laneId !== laneId ? null : snoozed.until;
};

/** Whether the owner has put the card aside and the time is not up yet. */
export const isSnoozed = (row: Pick<ToTestCard, 'snoozedUntil'>, now: number): boolean =>
  row.snoozedUntil !== null && Date.parse(row.snoozedUntil) > now;

/** The rows to answer now, and the ones put aside until later (soonest wake first). */
export const splitSnoozed = (
  rows: readonly ToTestCard[],
  now: number,
): { readonly awake: readonly ToTestCard[]; readonly snoozed: readonly ToTestCard[] } => ({
  awake: rows.filter(row => !isSnoozed(row, now)),
  snoozed: rows
    .filter(row => isSnoozed(row, now))
    .sort((a, b) => Date.parse(a.snoozedUntil ?? '') - Date.parse(b.snoozedUntil ?? '')),
});

/** The soonest time a snoozed row wakes after `now`, or `null` when none is snoozed. */
export const nextWake = (rows: readonly ToTestCard[], now: number): number | null => {
  const wakes = rows.filter(row => isSnoozed(row, now)).map(row => Date.parse(row.snoozedUntil ?? ''));
  return wakes.length === 0 ? null : Math.min(...wakes);
};

/** One card as a card to test: `null` when it is dropped, a person did not ask for it, or its project's lanes do not name where Done and Not good go. */
export const toTestOf = (card: BoardCardOf, group: BoardGroupOf): ToTestCard | null => {
  if (awaitingOwner(card, group.laneSet) !== 'try') return null;
  const doneLaneId = doneLaneOf(group.laneSet);
  const notGoodLaneId = notGoodLaneOf(group.laneSet);
  if (doneLaneId === null || notGoodLaneId === null) return null;
  return {
    key: toTestKey(card),
    card,
    group,
    doneLaneId,
    notGoodLaneId,
    howToTest: card.task.howToTest,
    taskName: null,
    projectName: null,
    since: sinceOf(card),
    snoozedUntil: snoozedUntilOf(card),
  };
};

/** Each session's task by session id: the work it was given. A session with none (or only its callsign) is left out. */
export const sessionTaskNames = (sessions: readonly Pick<SessionView, 'config'>[]): ReadonlyMap<string, string> => {
  const names = new Map<string, string>();
  for (const { config } of sessions) {
    const task = sessionTask(config.name);
    if (task !== '' && task.toLowerCase() !== displayCallsign(config.teammate).toLowerCase())
      names.set(config.id, task);
  }
  return names;
};

/** The card with the task name of the ferret on it (its assignee, else its owner); the same card when nothing is known. */
export const withTaskName = (row: ToTestCard, names: ReadonlyMap<string, string> | undefined): ToTestCard => {
  if (names === undefined) return row;
  const { assignee, owner } = row.card.task;
  const taskName = (assignee === null ? undefined : names.get(assignee)) ?? names.get(owner) ?? null;
  return taskName === row.taskName ? row : { ...row, taskName };
};

/**
 * Every card in a verify lane that the owner can answer: a person asked for it, it is not dropped, and its project's
 * lanes name both where Done and where Not good go. Newest release first; a card with no release after those that have one.
 */
export const toTestCards = (model: BoardModel): readonly ToTestCard[] =>
  model.groups
    .flatMap(group =>
      group.lanes
        .filter(lane => lane.category === 'verify')
        .flatMap(lane => lane.cards)
        .flatMap(card => toTestOf(card, group) ?? []),
    )
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
      (needle === '' ||
        `${row.card.task.title} ${row.card.task.id} ${row.projectName ?? ''}`.toLowerCase().includes(needle)),
  );
};

/** The card with the name of its project; the same card when the name is unknown. */
export const withProjectName = (row: ToTestCard, names: ReadonlyMap<string, string> | undefined): ToTestCard => {
  const projectName = names?.get(row.group.projectId) ?? null;
  return projectName === null || projectName === row.projectName ? row : { ...row, projectName };
};
