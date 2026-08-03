/**
 * The Ferretry logomark, inline.
 *
 * The mark is Fleet Grid, from `docs/brand/fleet-grid/`: eight perimeter slots
 * around one round hub, with one slot simply ABSENT — because Ferretry refuses to
 * draw a healthy square for a report it never received. The absence is the
 * meaning, not a gap to be tidied, which is why the shape count is asserted in
 * `tests/unit/brand-mark.test.tsx`.
 *
 * INLINE SVG RATHER THAN AN <img>, for three reasons that are all about being
 * correct rather than about being clever:
 *
 *   1. `currentColor`. An `<img>` is an opaque box: it cannot inherit `--fg`,
 *      `--accent`, or the tint of whatever chrome it sits in, so a themed app
 *      would need one file per theme per mode. This paints the cells with
 *      `currentColor` and takes the hub from `--accent`, so ONE component is
 *      right in all seven families, in light and dark, and in a tinted lockup.
 *      `docs/brand/fleet-grid/logomark-mono.svg` exists for exactly this use.
 *   2. No second network round trip for 300 bytes, and no flash of missing mark
 *      before it arrives — this sits in a header the reader sees first.
 *   3. The deployment sends `default-src 'self'`. A local asset would satisfy
 *      that too, but inline cannot be broken by a path change at all.
 *
 * The geometry is the brand file's, unchanged and NOT simplified: every edge sits
 * on the 4-unit grid, so the mark stays crisp down to 16px. It is the same
 * geometry `public/icons/favicon.svg` ships, deliberately — the tab and the
 * header must not be two slightly different marks.
 *
 * DECORATIVE BY DEFAULT. Every place this renders today sits beside the word
 * Ferretry as a lockup, so the mark is `aria-hidden` and the text carries the
 * name. A screen reader announcing "Ferretry graphic, Ferretry" is a worse
 * outcome than one that announces the word once.
 */

import { cn } from '../lib/class-names.ts';

/** The 4-unit grid the mark is drawn on, so the cell geometry is stated once. */
const CELLS = [
  [4, 4],
  [24, 4],
  [44, 4],
  [4, 24],
  // (44, 24) is deliberately empty — the report that never arrived.
  [4, 44],
  [24, 44],
  [44, 44],
] as const;

export interface BrandMarkProps {
  /** Rendered edge length in px. 20 matches the icon size of the header lockups. */
  readonly size?: number;
  readonly className?: string;
}

export function BrandMark({ size = 20, className = '' }: BrandMarkProps) {
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      aria-hidden="true"
      // Keeps the mark out of the tab order in the browsers that still put SVG
      // in it, which no `aria-hidden` alone prevents.
      focusable="false"
      className={cn('shrink-0', className)}
    >
      <g fill="currentColor">
        {CELLS.map(([x, y]) => (
          <rect key={`${x}-${y}`} x={x} y={y} width={16} height={16} rx={4} />
        ))}
      </g>
      {/* The hub is the daemon, and it takes `--accent` rather than
          `currentColor` so it reads as a different KIND of thing from the agents
          around it. In an already-accent-tinted lockup the two colours coincide
          and the round silhouette carries the distinction on its own. */}
      <circle cx={32} cy={32} r={8} fill="var(--accent)" />
    </svg>
  );
}
