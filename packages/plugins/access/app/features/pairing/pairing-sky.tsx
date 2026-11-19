/**
 * THE NIGHT SKY BEHIND THE PAIR PAGE: a slow field of stars, an occasional shooting star, and a faint Fleet Grid —
 * the mascot's world, tied to the logo. It is scenery: `aria-hidden`, never focusable, never in the way.
 *
 * CHEAP BY CONSTRUCTION. Everything is CSS; nothing here runs script after the first render except one visibility
 * flag. The animated parts are few and each moves only `transform` or `opacity`:
 *
 *   - ONE static layer of faint stars (a single element, many `box-shadow`s: no animation at all);
 *   - {@link TWINKLERS}: a dozen larger stars fading in and out (opacity);
 *   - two shooting stars on long, mostly-idle loops (transform + opacity), and ONE streak that runs once on success;
 *   - the Fleet Grid: a single SVG pattern that BREATHES, its opacity and a hair of scale swelling and settling over 7 s
 *     (transform + opacity on the grid's own layer; the stars and shooting stars stay as they were).
 *
 * It PAUSES WHILE THE TAB IS HIDDEN (`animation-play-state`), and under reduced motion — the OS setting or the app's
 * Motion = Reduced (`<html data-motion="reduced">`) — every animation is off and what is left is a still sky
 * (`app/styles.css`, `.fy-sky`).
 *
 * LOW CONTRAST ON PURPOSE: stars and grid are drawn in the theme's own tokens at low opacity, so the card's text keeps
 * its contrast over the busiest frame (measured, `tests/integration/app/pairing-sky.visual.test.ts`).
 */
import { useDocumentVisible } from '@ferretry/app/ui';

/** Fixed positions (percent) and timings, not random: the sky is the same on every visit and every screenshot. */
const TWINKLERS = [
  { x: 6, y: 9, size: 3, delay: 0, seconds: 4.6 },
  { x: 17, y: 31, size: 2, delay: 1.4, seconds: 5.2 },
  { x: 27, y: 6, size: 2, delay: 2.2, seconds: 3.8 },
  { x: 38, y: 17, size: 3, delay: 0.6, seconds: 6.1 },
  { x: 52, y: 5, size: 2, delay: 3.1, seconds: 4.4 },
  { x: 64, y: 14, size: 3, delay: 1.9, seconds: 5.6 },
  { x: 76, y: 8, size: 2, delay: 0.3, seconds: 4.1 },
  { x: 88, y: 20, size: 3, delay: 2.7, seconds: 5.9 },
  { x: 94, y: 6, size: 2, delay: 1.1, seconds: 3.9 },
  { x: 4, y: 52, size: 2, delay: 3.4, seconds: 5.0 },
  { x: 12, y: 74, size: 3, delay: 0.9, seconds: 6.3 },
  { x: 91, y: 48, size: 2, delay: 2.0, seconds: 4.8 },
  { x: 84, y: 71, size: 3, delay: 1.6, seconds: 5.4 },
  { x: 7, y: 92, size: 2, delay: 2.9, seconds: 4.3 },
  { x: 33, y: 88, size: 2, delay: 0.2, seconds: 5.7 },
  { x: 71, y: 91, size: 3, delay: 3.6, seconds: 4.9 },
] as const;

export interface PairingSkyProps {
  /** The pairing worked: the stars brighten and one streak crosses the sky, once. */
  readonly celebrating?: boolean;
}

export function PairingSky({ celebrating = false }: PairingSkyProps) {
  const visible = useDocumentVisible();
  return (
    <div
      className="fy-sky"
      aria-hidden="true"
      data-sky=""
      data-celebrating={celebrating ? '' : undefined}
      data-paused={visible ? undefined : ''}
    >
      <svg className="fy-sky-grid" width="100%" height="100%" aria-hidden="true" focusable="false">
        <defs>
          {/* The Fleet Grid mark's seven cells and its hub, outlined, on a 96-unit tile: the logomark repeated as texture. */}
          <pattern id="fy-sky-grid-tile" width="96" height="96" patternUnits="userSpaceOnUse">
            <g transform="translate(16 16)" fill="none" stroke="currentColor" strokeWidth="1.2">
              <rect x="4" y="4" width="16" height="16" rx="4" />
              <rect x="24" y="4" width="16" height="16" rx="4" />
              <rect x="44" y="4" width="16" height="16" rx="4" />
              <rect x="4" y="24" width="16" height="16" rx="4" />
              <rect x="4" y="44" width="16" height="16" rx="4" />
              <rect x="24" y="44" width="16" height="16" rx="4" />
              <rect x="44" y="44" width="16" height="16" rx="4" />
              <circle cx="32" cy="32" r="8" />
            </g>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#fy-sky-grid-tile)" />
      </svg>
      <i className="fy-sky-dust" />
      <div className="fy-sky-stars">
        {TWINKLERS.map(star => (
          <i
            key={`${star.x}:${star.y}`}
            className="fy-sky-star"
            style={{
              left: `${star.x}%`,
              top: `${star.y}%`,
              width: star.size,
              height: star.size,
              animationDelay: `${star.delay}s`,
              animationDuration: `${star.seconds}s`,
            }}
          />
        ))}
      </div>
      <i className="fy-sky-shooter fy-sky-shooter-a" />
      <i className="fy-sky-shooter fy-sky-shooter-b" />
      {celebrating ? <i className="fy-sky-streak" /> : null}
    </div>
  );
}
