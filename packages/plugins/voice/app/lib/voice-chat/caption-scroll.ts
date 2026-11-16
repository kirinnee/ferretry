/**
 * WHERE THE CAPTION BOX SCROLLS TO. Pure and total.
 *
 * The captions box shows a fixed number of whole lines, and it must only ever rest on a line boundary,
 * so no line is cut in half at its top or bottom edge. Given where the sentence being said sits inside the
 * scrolled content, this answers the `scrollTop` (a whole number of lines) that brings it into view with a
 * line of context before it, or `null` when there is nothing sensible to do (no line height yet).
 */

export interface CaptionGeometry {
  /** Where the sentence starts and ends inside the scrolled content, in px (a wrapped sentence: its first and last line). */
  readonly top: number;
  readonly bottom: number;
  /** The height of one line, in px. */
  readonly line: number;
  /** The visible height of the box and the height of everything in it, in px. */
  readonly viewport: number;
  readonly content: number;
  /** Where the box is scrolled to now, in px. */
  readonly scrollTop: number;
}

/** Layout is measured in fractions of a pixel: a line is "on" a boundary within this much of a line. */
const SLACK = 0.05;

const isMeasure = (value: number): boolean => Number.isFinite(value);

export const captionScrollTop = (geometry: CaptionGeometry): number | null => {
  const { top, bottom, line, viewport, content, scrollTop } = geometry;
  if (![top, bottom, line, viewport, content, scrollTop].every(isMeasure) || line <= 0) return null;
  const lines = Math.max(1, Math.floor(viewport / line + SLACK));
  const firstLine = Math.max(0, Math.floor(top / line + SLACK));
  const endLine = Math.max(firstLine + 1, Math.ceil(bottom / line - SLACK));
  const current = Math.max(0, Math.round(scrollTop / line));
  // Already fully in view on a line boundary: leave it be, nothing jumps while the voice stays on screen.
  if (firstLine >= current && endLine <= current + lines && Math.abs(scrollTop - current * line) < line * SLACK) {
    return current * line;
  }
  // One line of context before the sentence, unless the sentence fills the box on its own.
  const start = endLine - firstLine < lines ? firstLine - 1 : firstLine;
  const last = Math.max(0, Math.round(content / line) - lines);
  return Math.min(Math.max(0, start), last) * line;
};
