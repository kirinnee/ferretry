/**
 * THE FOLLOW MODEL, as pure decisions: stick to the bottom unless the reader scrolled up.
 *
 * A private copy of the decisions the Chat transcript makes (the same numbers, the same rules), kept here until the
 * shared scroll-follow lands in `@ferretry/app/ui` and Terminals can import it; the pane snapshot follows its tail by
 * the same model. Each decision is a function of numbers read, so every boundary is assertable without a browser.
 *
 * Follow is a sticky STATE, not a distance test on each event. It is broken only by a scroll-up the
 * READER made, and re-engaged only by arriving back at the bottom (or by the "jump to latest" pill).
 */

/**
 * How close to the bottom counts as "back at the bottom" for RE-ENGAGING follow — about three lines.
 *
 * Generous on purpose. Detaching is driven by an explicit upward scroll, never by this number, so a
 * wide band cannot oscillate. And it needs to be wide: on a fast-streaming session the bottom moves
 * away while you scroll toward it, so a tight band leaves a reader wheeling down a few pixels short,
 * detached for good. Following itself stays exact — a pin assigns `scrollTop = scrollHeight`.
 */
const TRANSCRIPT_REENGAGE_PX = 96;

/**
 * How long after a DISCRETE input (a wheel tick, a scrolling key, the inertial coast after a released
 * finger or scrollbar) a scroll-up still counts as the reader's. A continuous gesture — a scrollbar
 * drag, a finger on the glass — is latched by `pointerHeld` instead, for as long as it lasts.
 */
const TRANSCRIPT_INTENT_WINDOW_MS = 1500;

/** Keys that scroll a focused region. Typing in the composer is excluded by the caller. */
export const TRANSCRIPT_SCROLL_KEYS: ReadonlySet<string> = new Set([
  'PageUp',
  'PageDown',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  ' ',
  'Spacebar',
]);

/** The minimal Selection shape the pin guard needs. */
export interface FollowSelectionLike {
  readonly isCollapsed: boolean;
  readonly rangeCount: number;
  readonly anchorNode: Node | null;
  readonly focusNode: Node | null;
}

/**
 * Would a `scrollTop` write destroy a selection the reader is holding in the transcript?
 *
 * Measured in kteam: a write while a range is held collapses it, and a following transcript re-pins
 * on every streaming delta — so without this guard a live conversation cannot be highlighted at all.
 * Either endpoint inside counts; a caret, an empty selection or one wholly outside is no obstacle.
 */
const pinBlockedBySelection = (
  selection: FollowSelectionLike | null,
  contains: (node: Node | null) => boolean,
): boolean => {
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return false;
  return contains(selection.anchorNode) || contains(selection.focusNode);
};

/**
 * May follow write `scrollTop` right now? Not while a pointer is held on the viewport — a touch
 * long-press dwells with the selection still COLLAPSED, the one window the selection check is blind
 * to, and a pin there moves the prose out from under the finger — and not while a selection is held.
 */
export const followPinBlocked = (
  pointerHeld: boolean,
  selection: FollowSelectionLike | null,
  contains: (node: Node | null) => boolean,
): boolean => pointerHeld || pinBlockedBySelection(selection, contains);

/** Did a person cause this scroll? A held pointer, or a discrete input inside the intent window. */
export const scrollIsByReader = (pointerHeld: boolean, intentAt: number, now: number): boolean =>
  pointerHeld || now - intentAt < TRANSCRIPT_INTENT_WINDOW_MS;

/** One read of the viewport's three scroll metrics. */
export interface ScrollMetrics {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/** What the viewport looked like at the last settled observation. */
export interface ScrollMemory {
  readonly lastScrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/** The reader's distance from the bottom, never negative. */
export const gapFromBottom = (metrics: ScrollMetrics): number =>
  Math.max(0, metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight);

export type ScrollVerdict = 'detach' | 'reengage' | 'stay';

/**
 * What one scroll event means for follow.
 *
 * DETACH needs all three of: scrollTop actually went backwards (1px of slack, for fractional-DPR
 * metrics); a person did it; and the content did not shrink and the viewport did not change height this frame.
 * Each guards a measured false positive — a removed footer, a squeezed viewport, a viewport that GREW (the Jump
 * pill's row leaving, the keyboard closing: the browser clamps `scrollTop` to the new, lower maximum) and the
 * browser's own scroll anchoring all lower `scrollTop` with nobody touching anything.
 *
 * RE-ENGAGE needs the reader inside the band AND not moving up. A finger delivers a drag as many
 * small moves; the first ones of any scroll-up start inside the band, and re-engaging there froze a
 * phone transcript at the tail (kteam round 6).
 */
export const scrollVerdict = (
  metrics: ScrollMetrics,
  memory: ScrollMemory,
  state: { readonly following: boolean; readonly byReader: boolean },
): ScrollVerdict => {
  const movedUp = metrics.scrollTop < memory.lastScrollTop - 1;
  const resized =
    metrics.scrollHeight < memory.scrollHeight - 1 || Math.abs(metrics.clientHeight - memory.clientHeight) > 1;
  if (movedUp && state.byReader && !resized && state.following) return 'detach';
  if (!movedUp && !state.following && gapFromBottom(metrics) <= TRANSCRIPT_REENGAGE_PX) return 'reengage';
  return 'stay';
};

/** The pill's words: the count when there is one. */
export const jumpToLatestLabel = (count: number): string =>
  count > 0 ? `${count} new — jump to latest` : 'Jump to latest';

/** A detached reader sees the pill once they are farther than this from the bottom… */
const JUMP_PILL_SHOW_PX = 48;
/** …and it goes away again only inside this, so a few pixels of drift near the tail never toggle it. */
const JUMP_PILL_HIDE_PX = 8;

/** Should the pill show? Hysteresis on the gap: it takes JUMP_PILL_SHOW_PX to appear, only JUMP_PILL_HIDE_PX to leave. */
export const jumpPillShown = (shown: boolean, detached: boolean, gap: number): boolean =>
  detached && gap > (shown ? JUMP_PILL_HIDE_PX : JUMP_PILL_SHOW_PX);
