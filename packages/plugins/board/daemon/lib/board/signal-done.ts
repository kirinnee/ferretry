/**
 * `fy signal done` ON THE BOARD (`board-design.md` §3.1 item 5), as pure rules: the done message becomes a
 * note on the ferret's focus card, and a card still in an `active` lane with no PR moves on to where its
 * work is checked (a review lane, else the verify lane the owner tries it in) — never into a `closed` lane,
 * because only the owner closes. A card whose PR is open waits in the review lane for the merge; one whose PR merged is left to the GitHub watcher.
 */
import { type CardActor, type Card, categoryOf, formatCardRef, type Lane, type LaneSet, MAX_CARD_NOTE_LENGTH, MAX_BOARD_REASON_LENGTH, needsOwner, type CardRef, variantLanes } from '../../../contract/index.ts';
import { gatesBetween, withEvent } from './card-actions.ts';

/** What a `done` with no message says on the card. */
export const DONE_WITHOUT_MESSAGE = 'signalled done';

/** Text cut to a field's limit, saying it was cut. */
export const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

/** The done message as the card's note. */
export const doneNote = (message: string | undefined): string => {
  const said = message?.trim() ?? '';
  return clip(said === '' ? DONE_WITHOUT_MESSAGE : `done: ${said}`, MAX_CARD_NOTE_LENGTH);
};

/** The done message as the move's reason. */
export const doneReason = (message: string | undefined): string => {
  const said = message?.trim() ?? '';
  return clip(said === '' ? DONE_WITHOUT_MESSAGE : said, MAX_BOARD_REASON_LENGTH);
};

/**
 * Where a done card goes: the lane its variant enters on `signal.done` when that lies ahead and is not
 * `closed`, else the first `review` or `verify` lane after its own (a review lane before the verify lane is
 * where the work is checked first; with none, the verify lane, where the owner tries it), else the variant's
 * next lane. A card with an OPEN PR goes to the review lane ahead (and stays there until the PR merges); `null` when it stays — it is not in an `active` lane, its PR merged, it is dropped, or the only
 * lane it could reach is `closed`, because only the owner closes.
 */
export const doneLane = (card: Card, laneSet: LaneSet): Lane | null => {
  if (card.dropped !== null) return null;
  const prs = card.links.prs;
  const openPr = prs.some(pr => pr.state === 'open');
  if (!openPr && prs.some(pr => pr.state === 'merged')) return null;
  const category = categoryOf(laneSet, card.laneId);
  if (!category.ok || category.value !== 'active') return null;
  const lanes = variantLanes(laneSet, card.workflow);
  if (!lanes.ok) return null;
  const from = laneSet.lanes.findIndex(lane => lane.id === card.laneId);
  const later = lanes.value.filter(lane => laneSet.lanes.indexOf(lane) > from && lane.category !== 'closed');
  if (openPr) {
    // An open PR is still in review and CI: the card waits in the review lane until the PR merges.
    return later.find(lane => lane.category === 'review') ?? null;
  }
  const target =
    later.find(lane => lane.enterOn?.includes('signal.done') === true) ??
    later.find(lane => lane.category === 'review' || lane.category === 'verify') ??
    later[0];
  return target ?? null;
};

/** A done move, or why the card stays where it is. */
export type DoneMove = { readonly task: Card } | { readonly held: string };

/**
 * The move a done makes, as the daemon's automatic `signal.done` move with the message as its reason. It
 * is the ferret's claim, not a fact the world reported, so it passes no owner gate and no unfinished
 * blocker: either holds the card where it is, and the reason is said. A gate on the way is where it stops
 * (docs/board.md § Cards show progress): only the owner passes one.
 */
export const doneMove = (
  card: Card,
  target: Lane,
  laneSet: LaneSet,
  blockers: readonly CardRef[],
  message: string | undefined,
  context: { readonly now: string; readonly actor: CardActor },
): DoneMove => {
  const ref = formatCardRef(card);
  const gated = needsOwner(laneSet, card.laneId, target.id);
  if (gated.ok && gated.value) {
    return { held: `only the owner moves ${ref} on from ${card.laneId}, so it stays there` };
  }
  const to = gatesBetween(laneSet, card, target)[0] ?? target;
  if (blockers.length > 0) {
    return { held: `${ref} is blocked by ${blockers.map(formatCardRef).join(', ')}, so it stays in ${card.laneId}` };
  }
  return {
    task: {
      ...withEvent(
        card,
        {
          type: 'moved',
          from: card.laneId,
          to: to.id,
          backward: false,
          reason: doneReason(message),
          auto: true,
          trigger: 'signal.done',
        },
        context,
      ),
      laneId: to.id,
    },
  };
};
