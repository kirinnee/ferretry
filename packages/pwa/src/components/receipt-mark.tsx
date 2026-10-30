/**
 * THE MARKS A RECEIPT IS DRAWN WITH, as one small SVG family so a tick is the same tick everywhere.
 *
 * The owner asked for the shapes a messaging app has taught everyone to read, so these are drawn here
 * instead of borrowed from an icon set whose double tick is two slanted strokes crossing each other:
 *
 *   * ONE CHECK is a single clean tick, 10 units wide.
 *   * TWO, THREE AND FOUR CHECKS are that same tick repeated, each 35% of its width to the right of the one before,
 *     so each sits partly over the last and all stay legible: one saved on this device, two on the machine's queue,
 *     three typed into the ferret, four read.
 *   * Every stroke is 1.75 CSS px with round caps and joins, at a height of 14px.
 *
 * The stroke is `non-scaling`, so it is 1.75px at any size and any device pixel ratio instead of a
 * unit count that rounds differently at 1×, 2× and 3×. Colour is `currentColor`: the stylesheet makes it
 * muted, accent for an answered send and red for a failed one — and the shape alone already says which,
 * so a mark is never carried by colour.
 */

import type { SendReceiptKind } from '../lib/send-receipt.ts';

const HEIGHT = 14;
const STROKE = 1.75;
const CHECK = 'M2 8.5 5.5 12 12 4.5';
const checkAt = (offset: number): string => `M${2 + offset} 8.5 ${5.5 + offset} 12 ${12 + offset} 4.5`;
/** 35% of the check's 10-unit width: far enough to read as two, near enough to overlap. */
const SECOND_OFFSET = 3.5;

interface Drawing {
  /** The viewBox width; its height is always 16. */
  readonly width: number;
  readonly paths: readonly string[];
}

const DRAWINGS: Readonly<Record<SendReceiptKind, Drawing>> = {
  sending: { width: 16, paths: ['M8 4.6V8l2.3 1.5', 'M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2Z'] },
  held: { width: 16, paths: ['M8 4.6V8l2.3 1.5', 'M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2Z'] },
  saved: { width: 14, paths: [CHECK] },
  queued: { width: 17.5, paths: [CHECK, checkAt(SECOND_OFFSET)] },
  delivered: { width: 21, paths: [CHECK, checkAt(SECOND_OFFSET), checkAt(2 * SECOND_OFFSET)] },
  answered: { width: 21, paths: [CHECK, checkAt(SECOND_OFFSET), checkAt(2 * SECOND_OFFSET)] },
  read: { width: 24.5, paths: [CHECK, checkAt(SECOND_OFFSET), checkAt(2 * SECOND_OFFSET), checkAt(3 * SECOND_OFFSET)] },
  typed: { width: 16, paths: ['M10.6 3.4 12.6 5.4 6 12l-2.8.8L4 10Z', 'M9.2 4.8l2 2'] },
  unconfirmed: { width: 16, paths: ['M5.6 5.6a2.6 2.6 0 1 1 3.8 2.3c-.9.5-1.4 1-1.4 2', 'M8 13h.01'] },
  failed: { width: 16, paths: ['M8 2.5v7.5', 'M8 13h.01'] },
  cancelled: { width: 16, paths: ['M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2Z', 'M3.8 12.2 12.2 3.8'] },
};

export function ReceiptMark({ kind, className }: { readonly kind: SendReceiptKind; readonly className?: string }) {
  const { width, paths } = DRAWINGS[kind];
  return (
    <svg
      aria-hidden="true"
      className={className}
      data-receipt-mark={kind}
      fill="none"
      focusable="false"
      height={HEIGHT}
      shapeRendering="geometricPrecision"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={STROKE}
      viewBox={`0 0 ${width} 16`}
      width={(HEIGHT * width) / 16}
    >
      {paths.map(path => (
        <path d={path} key={path} vectorEffect="non-scaling-stroke" />
      ))}
    </svg>
  );
}
