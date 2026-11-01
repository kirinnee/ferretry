/**
 * THE COMPASS: the second layer of the swipe down, apart from the deck that draws it so each reading is proved without a
 * layout engine. A card pulled DOWN past the Skip threshold with the pointer kept down reveals a small compass:
 *
 * - ↓ (straight, and the first row) is Skip, as it always was;
 * - ↓← is Skip, ↓→ is Not needed (the deck holds it in the undo window);
 * - ↓↓ is Snooze: the three lengths show, and ↓↓↓ picks one by where the finger is — 1 h, 4 h or 1 day.
 *
 * Nothing here is destructive without the Undo: Not needed goes through the undo window, Snooze is `snoozeAction`
 * (the owner's own, kept on the machine) and letting go at ↓↓ before a length is picked changes nothing at all.
 * A direction the host cannot do (`available`) reads as the row above it, never as something else.
 */

import { swipeThreshold } from '../../lib/agenda-inbox.ts';

/** How far past the Skip threshold each further row of the compass starts. */
export const COMPASS_ROW_PX = 56;
/** How far sideways a finger must be, in the first row, to leave plain ↓ for ↓← or ↓→, and in the last to pick 1 h or 1 day. */
export const COMPASS_SIDE_PX = 48;

export type SnoozeLength = '1h' | '4h' | '1d';

/** The length of each snooze the compass offers, in the order it draws them (left to right). */
export const SNOOZE_LENGTHS: readonly { readonly id: SnoozeLength; readonly label: string; readonly ms: number }[] = [
  { id: '1h', label: '1 h', ms: 3_600_000 },
  { id: '4h', label: '4 h', ms: 4 * 3_600_000 },
  { id: '1d', label: '1 day', ms: 24 * 3_600_000 },
];

/** The instant a snooze of this length ends, from `now`. */
export const snoozeUntil = (length: SnoozeLength, now: number): string => {
  const entry = SNOOZE_LENGTHS.find(candidate => candidate.id === length);
  return new Date(now + (entry?.ms ?? 0)).toISOString();
};

/** What letting go would do. `cancel`: the drag has not reached the compass, or sits where nothing is chosen. */
type CompassIntent =
  | { readonly kind: 'cancel' }
  | { readonly kind: 'skip' }
  | { readonly kind: 'not-needed' }
  | { readonly kind: 'snooze-pick' }
  | { readonly kind: 'snooze'; readonly length: SnoozeLength };

/** What the host can do; the rest reads as Skip (a snooze the machine cannot do, a dismiss the card cannot take). */
export interface CompassAvailable {
  readonly notNeeded: boolean;
  readonly snooze: boolean;
}

export interface CompassReading {
  readonly intent: CompassIntent;
  /** Whether the compass is drawn: the drag is past the Skip threshold. */
  readonly revealed: boolean;
  /** The compass slot to light (`down`, `down-left`, `down-right`, `down-down`, `down-down-1h` …), or null. */
  readonly slot: string | null;
}

const NOT_REVEALED: CompassReading = { intent: { kind: 'cancel' }, revealed: false, slot: null };

/** Reads a downward drag of `(dx, dy)` on a card `width` wide. Only a drag that began vertically calls this. */
export const compassReading = (
  dx: number,
  dy: number,
  width: number,
  available: CompassAvailable = { notNeeded: true, snooze: true },
): CompassReading => {
  const threshold = swipeThreshold(width);
  if (dy < threshold) return NOT_REVEALED;
  const past = dy - threshold;
  if (available.snooze && past >= 2 * COMPASS_ROW_PX) {
    const length: SnoozeLength = dx <= -COMPASS_SIDE_PX ? '1h' : dx >= COMPASS_SIDE_PX ? '1d' : '4h';
    return { intent: { kind: 'snooze', length }, revealed: true, slot: `down-down-${length}` };
  }
  if (available.snooze && past >= COMPASS_ROW_PX)
    return { intent: { kind: 'snooze-pick' }, revealed: true, slot: 'down-down' };
  if (dx >= COMPASS_SIDE_PX && available.notNeeded)
    return { intent: { kind: 'not-needed' }, revealed: true, slot: 'down-right' };
  return { intent: { kind: 'skip' }, revealed: true, slot: dx <= -COMPASS_SIDE_PX ? 'down-left' : 'down' };
};
