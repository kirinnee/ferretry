/**
 * THE LIVING BACKGROUND — a faint dot grid that breathes behind a screen, with one soft glow drifting slowly across it.
 * First-run screens use it so the page feels awake without asking for attention.
 *
 *   <main className="relative isolate"><LivingBackground />…</main>
 *
 * CHEAP BY CONSTRUCTION. Two layers, each its own composited layer, each moving only `transform` and `opacity`:
 *   - the grid breathes (opacity and a 4 % scale, 7 s ease in and out);
 *   - the glow drifts (a 40 s translate, there and back).
 * No canvas, no timer, no script per frame, and nothing here is in the layout flow (absolute or fixed, `inset: 0`), so the
 * content around it is the same size and in the same place with or without it.
 *
 * IT STOPS WHEN IT SHOULD. A hidden tab pauses both animations (`data-paused`); with motion off — the OS query OR
 * Settings › Appearance › Motion = Reduced, one answer from {@link useMotionAllowed} — nothing is animated and what is
 * left is the still picture (the stylesheet's resting state is that picture, so a stylesheet that never matches
 * still draws it).
 *
 * STARS (r10 O3, `stars`, on by default with `fill="viewport"`): a still sky of 17 faint stars (one element, many `box-shadow`s,
 * never animated) and three shooting streaks on staggered CSS delays, one every 6 to 11 s, each moving only `transform` and
 * `opacity`. The look is the Pair page's sky ported as CSS (`access/app/features/pairing/pairing-sky.tsx`), not imported.
 * Under reduced motion the stars stay and the streaks are never drawn; a hidden tab pauses them with everything else.
 *
 * LOW CONTRAST ON PURPOSE. Dots and glow use the theme's accent at low opacity and the grid fades out toward the middle,
 * so text keeps its contrast over the busiest frame. It is scenery: `aria-hidden`, never focusable, ignores the pointer.
 */
import { useId } from 'react';
import { useDocumentVisible } from './hooks/use-document-visible.ts';
import './living-background.css';
import { useMotionAllowed } from './use-motion-allowed.ts';

export interface LivingBackgroundProps {
  /**
   * `viewport` (the default) covers the whole window behind the page; `parent` fills the nearest positioned ancestor
   * (a card). Either way the host should be `isolate` so the background sits behind its content and nowhere else.
   */
  readonly fill?: 'viewport' | 'parent';
  /**
   * Draw the stars and shooting streaks. Defaults to on for `viewport` (a first-run page) and off for `parent` (a card).
   */
  readonly stars?: boolean;
}

export function LivingBackground({ fill = 'viewport', stars = fill === 'viewport' }: LivingBackgroundProps) {
  const visible = useDocumentVisible();
  const moving = useMotionAllowed();
  const pattern = `fy-lb-dots-${useId().replaceAll(':', '')}`;
  return (
    <div
      aria-hidden="true"
      className="fy-lb"
      data-fill={fill}
      data-living-background=""
      data-live={moving ? '' : undefined}
      data-paused={visible ? undefined : ''}
      data-stars={stars ? '' : undefined}
    >
      <div className="fy-lb-glow" />
      {stars ? (
        <div className="fy-lb-sky" data-lb-stars="">
          <i className="fy-lb-stars" />
          <i className="fy-lb-streak fy-lb-streak-a" />
          <i className="fy-lb-streak fy-lb-streak-b" />
          <i className="fy-lb-streak fy-lb-streak-c" />
        </div>
      ) : null}
      <svg aria-hidden="true" className="fy-lb-grid" focusable="false" height="100%" width="100%">
        <defs>
          <pattern height="28" id={pattern} patternUnits="userSpaceOnUse" width="28">
            <circle cx="14" cy="14" fill="currentColor" r="1.4" />
          </pattern>
        </defs>
        <rect fill={`url(#${pattern})`} height="100%" width="100%" />
      </svg>
    </div>
  );
}
