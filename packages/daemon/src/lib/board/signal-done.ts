/**
 * `fy signal done` ON THE BOARD (`board-design.md` §3.1 item 5), as pure rules: the done message becomes a
 * note on the ferret's focus card, and a card still in an `active` lane with no PR moves on to where its
 * work is checked — never into a `closed` lane, because only the owner closes. A card with a PR is left
 * where it is: the GitHub watcher owns its lane.
 */
import {
  type BoardActor,
  type BoardTask,
  categoryOf,
  formatTaskRef,
  type Lane,
  type LaneSet,
  MAX_BOARD_NOTE_LENGTH,
  MAX_BOARD_REASON_LENGTH,
  needsOwner,
  type TaskRef,
  variantLanes,
} from '@ferretry/protocol';
import { withEvent } from './card-actions.ts';

/** What a `done` with no message says on the card. */
export const DONE_WITHOUT_MESSAGE = 'signalled done';

/** Text cut to a field's limit, saying it was cut. */
export const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

/** The done message as the card's note. */
export const doneNote = (message: string | undefined): string => {
  const said = message?.trim() ?? '';
  return clip(said === '' ? DONE_WITHOUT_MESSAGE : `done: ${said}`, MAX_BOARD_NOTE_LENGTH);
};

/** The done message as the move's reason. */
export const doneReason = (message: string | undefined): string => {
  const said = message?.trim() ?? '';
  return clip(said === '' ? DONE_WITHOUT_MESSAGE : said, MAX_BOARD_REASON_LENGTH);
};

/**
 * Where a done card goes: the lane its variant enters on `signal.done` when that lies ahead, else the first
 * `review` or `verify` lane after its own, else the variant's next lane. `null` when it stays — it is not in
 * an `active` lane, it has a PR, it is dropped, or the lane it would reach is `closed` (a `quick` board
 * closes on `signal.done`, and only the owner closes here).
 */
export const doneLane = (card: BoardTask, laneSet: LaneSet): Lane | null => {
  if (card.dropped !== null || card.links.prs.length > 0) return null;
  const category = categoryOf(laneSet, card.laneId);
  if (!category.ok || category.value !== 'active') return null;
  const lanes = variantLanes(laneSet, card.workflow);
  if (!lanes.ok) return null;
  const from = laneSet.lanes.findIndex(lane => lane.id === card.laneId);
  const later = lanes.value.filter(lane => laneSet.lanes.indexOf(lane) > from);
  const target =
    later.find(lane => lane.enterOn?.includes('signal.done') === true) ??
    later.find(lane => lane.category === 'review' || lane.category === 'verify') ??
    later[0];
  return target === undefined || target.category === 'closed' ? null : target;
};

/** A done move, or why the card stays where it is. */
export type DoneMove = { readonly task: BoardTask } | { readonly held: string };

/**
 * The move a done makes, as the daemon's automatic `signal.done` move with the message as its reason. It
 * is the ferret's claim, not a fact the world reported, so it passes no owner gate and no unfinished
 * blocker: either holds the card where it is, and the reason is said.
 */
export const doneMove = (
  card: BoardTask,
  target: Lane,
  laneSet: LaneSet,
  blockers: readonly TaskRef[],
  message: string | undefined,
  context: { readonly now: string; readonly actor: BoardActor },
): DoneMove => {
  const ref = formatTaskRef(card);
  const gated = needsOwner(laneSet, card.laneId, target.id);
  if (gated.ok && gated.value) {
    return { held: `only the owner moves ${ref} on from ${card.laneId}, so it stays there` };
  }
  if (blockers.length > 0) {
    return { held: `${ref} is blocked by ${blockers.map(formatTaskRef).join(', ')}, so it stays in ${card.laneId}` };
  }
  return {
    task: {
      ...withEvent(
        card,
        {
          type: 'moved',
          from: card.laneId,
          to: target.id,
          backward: false,
          reason: doneReason(message),
          auto: true,
          trigger: 'signal.done',
        },
        context,
      ),
      laneId: target.id,
    },
  };
};
