/**
 * THE RULES FOR WHERE A SWIPE MAY START AND WHICH WAY IT GOES, apart from the deck that draws it so each is proved
 * without a layout engine. The whole card swipes — not only its head — so these are the rules that keep a swipe from
 * taking anything else's gesture:
 *
 * - TOUCH ONLY ({@link isTouch}): a mouse drag selects text, a pen is left to the page.
 * - NEVER ON SOMETHING THE READER PRESSES OR TYPES IN ({@link startsOnInteractive}).
 * - NEVER ON TEXT BEING SELECTED: a touch that goes down inside a selection ({@link startsInSelection}), or is held
 *   {@link LONG_PRESS_MS} before it moves ({@link isLongPress}), is the reader highlighting, so it is not a swipe.
 * - NEVER INSIDE A SCROLLER THAT SCROLLS SIDEWAYS ({@link startsInSidewaysScroller}): a wide table or rendered box
 *   keeps the drag that began in it.
 * - THE DIRECTION IS DECIDED ONCE, AFTER {@link LOCK_PX} of travel ({@link lockOf}): sideways is a swipe; up or down
 *   is the reader scrolling, handed to the browser — except from the card's head, which does not scroll and
 *   keeps its up and down answers ({@link startsInHead}).
 */

import { SWIPE_SLOP_PX } from '../../lib/agenda-inbox.ts';

/** How far a touch travels before its direction is decided, and then kept. */
export const LOCK_PX = SWIPE_SLOP_PX;

/** Only a finger swipes. */
export const isTouch = (event: { readonly pointerType: string }): boolean => event.pointerType === 'touch';

const INTERACTIVE =
  'a[href], button, input, textarea, select, summary, label, [role="button"], [role="link"], [role="menuitem"], [role="slider"], [contenteditable="true"], [data-agenda-no-swipe]';

/** Whether a touch went down on a link, a button, a field or anything else that answers a touch itself. */
export const startsOnInteractive = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest(INTERACTIVE) !== null;

const scrollsSideways = (element: Element): boolean => {
  if (element.scrollWidth <= element.clientWidth + 1) return false;
  const overflow = getComputedStyle(element).overflowX;
  return overflow === 'auto' || overflow === 'scroll';
};

/** Whether a touch went down inside an element, below `boundary`, that has more to scroll sideways. */
export const startsInSidewaysScroller = (target: EventTarget | null, boundary: Element): boolean => {
  for (
    let node = target instanceof Element ? target : null;
    node !== null && node !== boundary;
    node = node.parentElement
  )
    if (scrollsSideways(node)) return true;
  return false;
};

/**
 * The card's head — its header and title, and on a full item view its sticky top, the Inbox's who-and-what line
 * and the quick-reply bar. It is the one part that does not scroll, so a vertical drag there is a swipe (up
 * answers, down skips) rather than a scroll.
 */
export const startsInHead = (target: EventTarget | null): boolean =>
  target instanceof Element &&
  target.closest(
    '.fy-attn-card__meta, [data-agenda-title], [data-agenda-top], [data-inbox-who], [data-agenda-quick-replies]',
  ) !== null;

export type Lock = 'sideways' | 'vertical';

/** Which way a touch that has moved `(dx, dy)` is going: `null` while it is under {@link LOCK_PX}. */
export const lockOf = (dx: number, dy: number): Lock | null => {
  if (Math.hypot(dx, dy) < LOCK_PX) return null;
  return Math.abs(dx) > Math.abs(dy) ? 'sideways' : 'vertical';
};

/** A touch held this long before it moves is the reader selecting text, never a swipe. */
export const LONG_PRESS_MS = 400;

/** Whether a touch held for `elapsedMs` before it travelled is a long-press. */
export const isLongPress = (elapsedMs: number): boolean => elapsedMs >= LONG_PRESS_MS;

/** Whether a touch went down on text the reader already has selected: the drag moves the selection's handles, never the card. */
export const startsInSelection = (
  target: EventTarget | null,
  selection: Pick<Selection, 'isCollapsed' | 'containsNode'> | null = typeof window === 'undefined'
    ? null
    : window.getSelection(),
): boolean =>
  target instanceof Node && selection !== null && !selection.isCollapsed && selection.containsNode(target, true);
