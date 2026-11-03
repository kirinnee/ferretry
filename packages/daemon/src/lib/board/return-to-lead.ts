/**
 * A FINISHED HELPER'S CARD GOES BACK TO ITS LEAD (docs/board.md § A finished helper's card goes back to its lead).
 *
 * When the ferret a card is assigned to has ended (`fy signal done`, stopped, completed) and the card is still open
 * work, the daemon assigns it to the nearest LIVE ancestor of that ferret: the lead that started it, else the lead's
 * lead, an ended one skipped. Nobody is asked or messaged; the card's history says
 * `returned to <lead>: <ferret> finished`. These are the pure decisions: the board sweep asks WHEN, and
 * {@link returnCard} makes the write.
 *
 * It sits BEHIND the sub-card closes ({@link sub-card-close}): a helper's card with no PR still closes as
 * "helper finished" and a sub-card whose PR shipped closes with the parent carrying the test. What is left, a card
 * with a PR open or merged-not-closed, or a top-level card a sub-ferret held, is returned. With no live ancestor
 * nothing is returned and the card is an orphan, which the Warden reports.
 */
import type { BoardTask, LaneCategory } from '@ferretry/protocol';
import { type CardContext, withEvent } from './card-actions.ts';
import { nearestLiveLead, presenceOf, type SessionRoster } from './activity.ts';
import { effectiveAssignee } from './authority.ts';
import { HELPER_ENDED_GRACE_MS } from './sub-card-close.ts';

export { nearestLiveLead };

/** The lanes a card sits in while somebody is doing it; anywhere else it is unclaimed, shipped, or finished. */
export const WORKING_CATEGORIES: readonly LaneCategory[] = ['active', 'review'];

/** Whether the card's ferret is gone and has been untouched for the grace (a session that blinks is not ended). */
export const endedForGrace = (
  card: Pick<BoardTask, 'createdAt'> & { readonly lastTouchedAt?: string | null },
  roster: SessionRoster,
  ferret: string,
  nowMs: number,
): boolean => {
  if (presenceOf(roster, ferret) !== 'dead') return false;
  const touched = Date.parse(card.lastTouchedAt ?? card.createdAt);
  return Number.isNaN(touched) || nowMs - touched >= HELPER_ENDED_GRACE_MS;
};

/**
 * The live lead an ended ferret's card goes back to, or `null` when it stays: the card is open work in a working
 * lane (not backlog, not shipped, not closed or dropped), its assignee has ended, and somebody above that ferret is
 * alive. The caller has already let a PR-free helper close instead.
 */
export const returnTarget = (
  card: Pick<BoardTask, 'assignee' | 'owner' | 'dropped' | 'createdAt'> & { readonly lastTouchedAt?: string | null },
  category: LaneCategory | undefined,
  roster: SessionRoster,
  nowMs: number,
): string | null => {
  if (card.dropped !== null || category === undefined || !WORKING_CATEGORIES.includes(category)) return null;
  const ferret = effectiveAssignee(card);
  return endedForGrace(card, roster, ferret, nowMs) ? nearestLiveLead(roster, ferret) : null;
};

/** The card handed back: assigned to `lead`, with the ferret that finished recorded in the event. */
export const returnCard = (
  card: BoardTask,
  lead: string,
  finished: string,
  context: Pick<CardContext, 'now'>,
): BoardTask => ({
  ...withEvent(
    card,
    { type: 'assigned', from: card.assignee, to: lead, returnedFrom: finished },
    { now: context.now, actor: { kind: 'daemon' } },
  ),
  assignee: lead,
});
