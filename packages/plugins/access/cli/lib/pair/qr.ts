/**
 * Whether a rendered QR can be drawn at all.
 *
 * A QR that wraps is not a degraded QR, it is a picture of two halves of a QR, and no camera will
 * read it. Worse, it still looks like a QR, so the operator aims a phone at it and learns only that
 * pairing is broken. The width is therefore measured before anything is printed, and a QR too wide
 * for the window is withheld and explained rather than mangled.
 */

/** How far the QR is inset from the left margin, so it reads as the centre of the screen rather than as output. */
export const QR_INDENT = 2;

/** The widest line, counted in characters rather than UTF-16 units — every module here is a block character. */
export function qrColumns(rendered: string): number {
  return rendered.split('\n').reduce((widest, line) => Math.max(widest, Array.from(line).length), 0);
}

/**
 * Whether the QR fits, indent included.
 *
 * An unknown width — which is what a pipe reports — draws the QR anyway. Withholding it there would
 * strip the QR from `fy pair | tee`, and a terminal that declines to state its size is not evidence
 * of a narrow one.
 */
export function qrFitsTerminal(rendered: string, columns: number | undefined): boolean {
  return columns === undefined || columns >= qrColumns(rendered) + QR_INDENT;
}
