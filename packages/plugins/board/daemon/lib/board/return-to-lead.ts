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
 * with a PR open or merged-not-closed, or a top-level card a helper held, is returned. With no live ancestor
 * nothing is returned and the card is an orphan, which the Warden reports.
 */
import { type Card, isSubCard, type LaneCategory } from '../../../contract/index.ts';
import { type CardContext, withEvent } from './card-actions.ts';
import { nearestLiveLead, presenceOf, type FerretRoster } from './activity.ts';
import { effectiveAssignee } from './authority.ts';
import { MAX_LINEAGE_DEPTH } from './lineage.ts';
import { HELPER_ENDED_GRACE_MS, isHandedHelper, isPrFreeHelper } from './sub-card-close.ts';

export { nearestLiveLead };

/** The lanes a card sits in while somebody is doing it; anywhere else it is unclaimed, shipped, or finished. */
const WORKING_CATEGORIES: readonly LaneCategory[] = ['active', 'review'];

/** Whether the card's ferret is gone and has been untouched for the grace (a session that blinks is not ended). */
export const endedForGrace = (
  card: Pick<Card, 'createdAt'> & { readonly lastTouchedAt?: string | null },
  roster: FerretRoster,
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
 * alive. The grace is not judged here ({@link returnTarget} does), so this is the question the card's write asks again
 * with a fresh roster. A sub-card is returned only while it is a helper's with a PR: a lead's own bookkeeping has no
 * helper to send back from, and a PR-free helper closes instead. The helper rule is judged here, not left to the
 * sweep, because a returned card reads as bookkeeping once its lead owns it.
 */
export const returnLead = (
  card: Pick<Card, 'assignee' | 'owner' | 'dropped' | 'parent' | 'links'>,
  category: LaneCategory | undefined,
  roster: FerretRoster,
): string | null => {
  if (card.dropped !== null || category === undefined || !WORKING_CATEGORIES.includes(category)) return null;
  if (isSubCard(card) && (!isHandedHelper(card) || isPrFreeHelper(card))) return null;
  const ferret = effectiveAssignee(card);
  return presenceOf(roster, ferret) === 'dead' ? nearestLiveLead(roster, ferret) : null;
};

/** {@link returnLead} for a ferret that has been gone for the grace (a session that blinks is not ended). */
export const returnTarget = (
  card: Pick<Card, 'assignee' | 'owner' | 'dropped' | 'createdAt' | 'parent' | 'links'> & {
    readonly lastTouchedAt?: string | null;
  },
  category: LaneCategory | undefined,
  roster: FerretRoster,
  nowMs: number,
): string | null =>
  endedForGrace(card, roster, effectiveAssignee(card), nowMs) ? returnLead(card, category, roster) : null;

/** The card handed back: assigned to `lead`, with the ferret that finished recorded in the event. */
export const returnCard = (
  card: Card,
  lead: string,
  finished: string,
  context: Pick<CardContext, 'now'>,
): Card => ({
  ...withEvent(
    card,
    { type: 'assigned', from: card.assignee, to: lead, returnedFrom: finished },
    { now: context.now, actor: { kind: 'daemon' } },
  ),
  assignee: lead,
});

/**
 * The sessions from `ferret` up to `lead`, both included, walked up the roster's `lead`: exactly the ones a return
 * rests on (the ferret is gone, each one between is gone, `lead` is alive), so those are the ones whose standing is
 * held still while the card is handed over. `null` when `lead` is not above `ferret`.
 */
export const lineageThrough = (roster: FerretRoster, ferret: string, lead: string): readonly string[] | null => {
  const line = [ferret];
  while (line.length <= MAX_LINEAGE_DEPTH) {
    const next = roster.sessions.get(line[line.length - 1] as string)?.lead;
    if (next === undefined || next === '' || line.includes(next)) return null;
    line.push(next);
    if (next === lead) return line;
  }
  return null;
};
