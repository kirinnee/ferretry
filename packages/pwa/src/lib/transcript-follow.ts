/**
 * THE TRANSCRIPT'S FOLLOW MODEL, as pure decisions.
 *
 * Ported from kteam's `components/Transcript.tsx`, which arrived at this shape over eight measured
 * rounds; the reasoning for each rule is restated where the rule lives. The component owns the DOM
 * (listeners, observers, the one `scrollTop` write); everything here is a function of numbers it
 * read, so every boundary is assertable without a browser.
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
export const TRANSCRIPT_REENGAGE_PX = 96;

/**
 * How long after a DISCRETE input (a wheel tick, a scrolling key, the inertial coast after a released
 * finger or scrollbar) a scroll-up still counts as the reader's. A continuous gesture — a scrollbar
 * drag, a finger on the glass — is latched by `pointerHeld` instead, for as long as it lasts.
 */
export const TRANSCRIPT_INTENT_WINDOW_MS = 1500;

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
export const pinBlockedBySelection = (
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
 * metrics); a person did it; and neither the content nor the viewport shrank this frame. Each guards
 * a measured false positive — a removed footer, a squeezed viewport and the browser's own scroll
 * anchoring all lower `scrollTop` with nobody touching anything.
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
  const shrank = metrics.scrollHeight < memory.scrollHeight - 1 || metrics.clientHeight < memory.clientHeight - 1;
  if (movedUp && state.byReader && !shrank && state.following) return 'detach';
  if (!movedUp && !state.following && gapFromBottom(metrics) <= TRANSCRIPT_REENGAGE_PX) return 'reengage';
  return 'stay';
};

/**
 * How many rows arrived at the tail since the last row the reader had, for the pill's count.
 *
 * Zero unless the last row changed and the list did not shrink — a row that merely went away (a
 * reaped ledger row, a sliding window) adds nothing to read. When the old last row is gone from the
 * list the count is at least one, because something new is certainly there.
 */
export const newTailRows = (ids: readonly string[], previousLastId: string | null, previousCount: number): number => {
  const lastId = ids.at(-1);
  if (lastId === undefined || previousLastId === null || lastId === previousLastId || ids.length < previousCount)
    return 0;
  const index = ids.indexOf(previousLastId);
  return Math.max(1, index >= 0 ? ids.length - 1 - index : 1);
};

/**
 * Were rows inserted ABOVE what the reader had? True only when the old first row is still present
 * and no longer first.
 *
 * Deliberately narrower than kteam's "the first id changed". This transcript is a polled TAIL, so its
 * first row also changes when the window slides — rows dropping off the top while new ones join the
 * bottom — and restoring the gap from the bottom then would push a detached reader down by whatever
 * arrived. The browser's own scroll anchoring already holds that case still.
 */
export const prependedAbove = (ids: readonly string[], previousFirstId: string | null): boolean =>
  previousFirstId !== null && ids[0] !== previousFirstId && ids.indexOf(previousFirstId) > 0;

/**
 * Where to put a detached reader after rows were prepended: the same distance from the bottom as the
 * last settled observation. A prepend inserts content above, so that distance is the one quantity it
 * leaves invariant; an in-commit height delta is not trustworthy (kteam measured a full page of error).
 * Undefined when there is nothing to restore or the target would move the reader UP.
 */
export const prependRestoreTarget = (metrics: ScrollMetrics, gap: number): number | undefined => {
  if (gap <= 0) return undefined;
  const target = metrics.scrollHeight - metrics.clientHeight - gap;
  return target > metrics.scrollTop ? target : undefined;
};

/** The pill's words: the count when there is one. */
export const jumpToLatestLabel = (count: number): string =>
  count > 0 ? `${count} new — jump to latest` : 'Jump to latest';

/** A detached reader sees the pill once they are farther than this from the bottom… */
export const JUMP_PILL_SHOW_PX = 48;
/** …and it goes away again only inside this, so a few pixels of drift near the tail never toggle it. */
export const JUMP_PILL_HIDE_PX = 8;

/** Should the pill show? Hysteresis on the gap: it takes JUMP_PILL_SHOW_PX to appear, only JUMP_PILL_HIDE_PX to leave. */
export const jumpPillShown = (shown: boolean, detached: boolean, gap: number): boolean =>
  detached && gap > (shown ? JUMP_PILL_HIDE_PX : JUMP_PILL_SHOW_PX);
