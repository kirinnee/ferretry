/** Air past the last letter, so a scrolled title ends clear of the box's edge. */
const AIR_PX = 8;
/** A reader can follow about this many pixels a second. */
const PX_PER_SECOND = 16;
/** No title scrolls for less than a slow breath, however little it overflows. */
const MIN_SECONDS = 8;
/** Within this much of its box a title is called fitting: rounding is not overflow. */
const SLACK_PX = 1;

export interface Marquee {
  /** How far, in px, the title travels to show its end. */
  readonly distance: number;
  readonly seconds: number;
}

/** How a one-line title that may be wider than its box scrolls; null when it fits (or the box is not laid out). */
export function marqueeOf(textWidth: number, boxWidth: number): Marquee | null {
  if (boxWidth <= 0 || textWidth <= boxWidth + SLACK_PX) return null;
  const distance = Math.ceil(textWidth - boxWidth) + AIR_PX;
  return { distance, seconds: Math.max(MIN_SECONDS, Math.ceil(distance / PX_PER_SECOND)) };
}
