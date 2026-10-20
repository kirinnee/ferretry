/**
 * WHAT DRAGGING A MACHINE HEADING DECIDES, as pure functions: where a pointer would drop it, how fast
 * the list scrolls under it, and what a screen reader is told. The gesture wiring that feeds these is
 * `machine-reorder.tsx`; nothing here touches the DOM.
 */

import type { DaemonId } from '../lib/daemon-connection.ts';
import type { DropEdge } from '../lib/machine-order.ts';

/** A finger must rest this long on the handle before it lifts the machine; a swipe sooner is a scroll. */
export const LIFT_MS = 350;
/** Movement past this many pixels is a drag (mouse) or a scroll (touch before the lift). */
export const SLOP_PX = 8;
/** The band at the list's top and bottom edge inside which a drag scrolls it. */
export const SCROLL_EDGE_PX = 48;
/** The fastest the list scrolls, in pixels per frame, with the pointer on the very edge. */
export const SCROLL_MAX_PX = 16;

export interface MachineBox {
  readonly id: DaemonId;
  readonly top: number;
  readonly bottom: number;
}

export interface DropTarget {
  readonly id: DaemonId;
  readonly edge: DropEdge;
}

/**
 * Which heading the pointer is over and which side of its middle it is on. The dragged machine is not
 * a target for itself; with nothing else there is no target at all.
 */
export const dropTarget = (boxes: readonly MachineBox[], dragged: DaemonId, y: number): DropTarget | null => {
  const others = boxes.filter(box => box.id !== dragged);
  const over = others.find(box => y < (box.top + box.bottom) / 2);
  if (over !== undefined) return { id: over.id, edge: 'before' };
  const last = others.at(-1);
  return last === undefined ? null : { id: last.id, edge: 'after' };
};

/** Pixels to scroll this frame: negative near the top edge, positive near the bottom, scaled by depth. */
export const autoScrollDelta = (y: number, top: number, bottom: number): number => {
  if (y < top + SCROLL_EDGE_PX)
    return -Math.round(SCROLL_MAX_PX * Math.min(1, (top + SCROLL_EDGE_PX - y) / SCROLL_EDGE_PX));
  if (y > bottom - SCROLL_EDGE_PX)
    return Math.round(SCROLL_MAX_PX * Math.min(1, (y - (bottom - SCROLL_EDGE_PX)) / SCROLL_EDGE_PX));
  return 0;
};

const place = (index: number, count: number): string => `position ${index + 1} of ${count}`;

export const pickedUpMessage = (name: string, index: number, count: number): string =>
  `Picked up ${name}, ${place(index, count)}. Use the up and down arrow keys to move it, Space to drop, Escape to cancel.`;

export const movedMessage = (name: string, index: number, count: number): string =>
  `${name} moved to ${place(index, count)}.`;

export const droppedMessage = (name: string, index: number, count: number): string =>
  `Dropped ${name} at ${place(index, count)}.`;

export const cancelledMessage = (name: string, index: number, count: number): string =>
  `Reorder cancelled. ${name} is back at ${place(index, count)}.`;

/** `ids` with `id` one place up or down, or `ids` itself at either end. */
export const shifted = (ids: readonly DaemonId[], id: DaemonId, delta: -1 | 1): readonly DaemonId[] => {
  const from = ids.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ids.length) return ids;
  const next = [...ids];
  next[from] = ids[to] as DaemonId;
  next[to] = id;
  return next;
};
