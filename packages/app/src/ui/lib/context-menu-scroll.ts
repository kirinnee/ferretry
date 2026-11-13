/**
 * WHAT A SCROLL MEANS TO AN OPEN CONTEXT MENU — decided here, pure, so the rule is asserted without a DOM.
 *
 * A menu is anchored to its trigger. A scroll only matters when it can have moved that trigger, and even
 * then it matters differently depending on who scrolled: a reader who is leaving the spot closes the menu,
 * but a transcript that follows its tail when a message lands scrolls ITSELF and must not close every
 * "⋯" menu on the page — the menu simply travels with its trigger.
 */

export interface ScrollPoint {
  readonly x: number;
  readonly y: number;
}

/** How long after a reader's wheel / touch / scroll key / outside press a scroll still counts as theirs. */
export const READER_INPUT_WINDOW_MS = 1000;

/** What the scroll event let the menu observe about its trigger; `null` when no trigger is known. */
interface ScrollTrigger {
  readonly connected: boolean;
  /** The scrolled thing holds the trigger (the document and the window always do). */
  readonly insideScroller: boolean;
}

export interface ScrollFacts {
  readonly trigger: ScrollTrigger | null;
  readonly readerDriven: boolean;
  /** The trigger's top-left when the menu opened. */
  readonly origin: ScrollPoint | null;
  /** The trigger's top-left now. */
  readonly current: ScrollPoint | null;
}

export type ScrollVerdict =
  | { readonly kind: 'ignore' }
  | { readonly kind: 'dismiss' }
  | { readonly kind: 'follow'; readonly dx: number; readonly dy: number };

const IGNORE: ScrollVerdict = { kind: 'ignore' };
const DISMISS: ScrollVerdict = { kind: 'dismiss' };

/** Was the last reader input recent enough to own a scroll happening at `now`? */
export function isReaderDriven(lastInputAt: number | null, now: number): boolean {
  return lastInputAt !== null && now - lastInputAt >= 0 && now - lastInputAt <= READER_INPUT_WINDOW_MS;
}

/**
 * Should this scroll dismiss the menu, leave it alone, or move it with its trigger?
 * An unknown trigger keeps the old behaviour: with nothing to measure, any scroll dismisses.
 */
export function decideScroll(facts: ScrollFacts): ScrollVerdict {
  const { trigger } = facts;
  if (trigger === null) return DISMISS;
  if (!trigger.insideScroller) return IGNORE;
  if (facts.readerDriven) return DISMISS;
  if (!trigger.connected || facts.origin === null || facts.current === null) return DISMISS;
  return { kind: 'follow', dx: facts.current.x - facts.origin.x, dy: facts.current.y - facts.origin.y };
}
