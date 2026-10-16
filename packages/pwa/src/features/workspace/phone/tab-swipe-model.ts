/**
 * WHEN A FINGER ON THE CONTENT MEANS "NEXT TAB". Pure, so every threshold is a
 * unit test rather than a feel.
 *
 * The content is mostly vertical reading — a transcript, a terminal, a file — so
 * the default answer is NO. A swipe only counts when it is clearly sideways from
 * its first few pixels, travels far enough (or is a fast flick), and is one
 * finger. Once a gesture is read as vertical it stays vertical: a scroll that
 * drifts sideways at the end must never change tab under the reader.
 */

/** Movement below this is a tap or a wobble; no direction is decided yet. */
export const SWIPE_LOCK_SLOP_PX = 10;
/** Sideways must beat vertical by this factor to read as a swipe. */
export const SWIPE_HORIZONTAL_RATIO = 1.5;
/** A slow, deliberate drag must travel this far. */
export const SWIPE_DISTANCE_PX = 64;
/** A flick: shorter travel, but fast. */
export const SWIPE_FLICK_DISTANCE_PX = 28;
export const SWIPE_FLICK_VELOCITY = 0.5;

export type SwipeAxis = 'undecided' | 'horizontal' | 'vertical';

export interface TabSwipe {
  readonly startX: number;
  readonly startY: number;
  readonly startAt: number;
  readonly dx: number;
  readonly dy: number;
  readonly at: number;
  readonly axis: SwipeAxis;
}

export interface SwipePoint {
  readonly x: number;
  readonly y: number;
  readonly at: number;
}

export const beginTabSwipe = ({ x, y, at }: SwipePoint): TabSwipe => ({
  startX: x,
  startY: y,
  startAt: at,
  dx: 0,
  dy: 0,
  at,
  axis: 'undecided',
});

/** The axis is decided ONCE, at the first move past the slop, and never revisited. */
const decideAxis = (axis: SwipeAxis, dx: number, dy: number): SwipeAxis => {
  if (axis !== 'undecided') return axis;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_LOCK_SLOP_PX) return 'undecided';
  return Math.abs(dx) >= Math.abs(dy) * SWIPE_HORIZONTAL_RATIO ? 'horizontal' : 'vertical';
};

export const advanceTabSwipe = (swipe: TabSwipe, { x, y, at }: SwipePoint): TabSwipe => {
  const dx = x - swipe.startX;
  const dy = y - swipe.startY;
  return { ...swipe, dx, dy, at, axis: decideAxis(swipe.axis, dx, dy) };
};

/**
 * The tab a finished gesture asks for. A finger moving LEFT pulls the next tab
 * in from the right, as on every phone carousel.
 */
export const resolveTabSwipe = (swipe: TabSwipe): 'next' | 'previous' | null => {
  if (swipe.axis !== 'horizontal') return null;
  const distance = Math.abs(swipe.dx);
  const velocity = distance / Math.max(1, swipe.at - swipe.startAt);
  const far = distance >= SWIPE_DISTANCE_PX;
  const flick = distance >= SWIPE_FLICK_DISTANCE_PX && velocity >= SWIPE_FLICK_VELOCITY;
  if (!far && !flick) return null;
  return swipe.dx < 0 ? 'next' : 'previous';
};
