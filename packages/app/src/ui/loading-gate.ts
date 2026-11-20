/**
 * THE ONE LOADER THRESHOLD. How long a wait stays invisible before any loader may draw (a read that answers inside it
 * paints nothing), how long the fade-in takes, and how long a loader that did appear stays. `loading.tsx` and
 * `spinner.tsx` both read these, and `loading.css` carries the same delay as the fallback of `--loading-delay`
 * (`loading-gate.test.ts` holds the two to each other).
 */
import type { CSSProperties } from 'react';

/** A loader stays invisible this long: a read that answers inside it paints nothing (no flash for a fast load). */
export const LOADING_DELAY_MS = 300;
/** Once a loader has become visible it stays at least this long, so a slow-then-fast read never blinks it. */
export const LOADING_MIN_MS = 300;
/** How long a loader takes to fade in once it is due; the minimum display time starts when it is FULLY there. */
export const LOADING_FADE_MS = 160;

/** The custom properties the loader stylesheet reads. `delayMs` defaults to the one threshold. */
export const loadingGateStyle = (delayMs: number = LOADING_DELAY_MS): CSSProperties =>
  ({ '--loading-delay': `${delayMs}ms`, '--loading-fade': `${LOADING_FADE_MS}ms` }) as CSSProperties;

/** The class that keeps any element invisible for the threshold, then fades it in (`loading.css`). */
export const LOADING_GATE_CLASS = 'fy-wait-gate';
