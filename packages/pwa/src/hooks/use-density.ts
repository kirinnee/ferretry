/**
 * Reader-local density preference, ported from kteam's `useDensity`.
 *
 * Density is deliberately device-wide: it controls how much information this
 * browser can comfortably show, so it must not follow a selected daemon.  The
 * store owns persistence while this hook owns the one-time pointer default and
 * the root metadata consumed by density-aware shell treatments.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import type { DaemonControlsStore, Density } from '../lib/controls.ts';

export interface DensityOption {
  readonly id: Density;
  readonly label: string;
  readonly description: string;
}

export const DENSITY_OPTIONS: readonly DensityOption[] = [
  { id: 'full', label: 'Full', description: 'Show the available session detail.' },
  { id: 'compact', label: 'Compact', description: 'Keep rows easy to scan.' },
  { id: 'minimal', label: 'Minimal', description: 'Prioritise the session names.' },
];

/** Compact is the approved implicit default only for a coarse, no-hover primary pointer. */
export const implicitDensity = (touchPrimary: boolean): Density => (touchPrimary ? 'compact' : 'full');

let firstLoadDefault: Density | undefined;

/** Reads one media-query result defensively; browser capability probes can throw in embedded webviews. */
export const densityFromMediaQuery = (match: () => boolean): Density => {
  try {
    return implicitDensity(match());
  } catch {
    return 'full';
  }
};

/** The browser-free capability port used by the cached first-load read below. */
export const densityFromMatchMedia = (
  matchMedia: ((query: string) => Readonly<{ matches: boolean }>) | undefined,
): Density =>
  matchMedia ? densityFromMediaQuery(() => matchMedia('(pointer: coarse) and (hover: none)').matches) : 'full';

/** Samples the device once. Resizing must never turn an implicit preference into a stored choice. */
export const readImplicitDensity = (): Density => {
  if (firstLoadDefault !== undefined) return firstLoadDefault;
  firstLoadDefault = typeof window === 'undefined' ? 'full' : densityFromMatchMedia(window.matchMedia);
  return firstLoadDefault;
};

export interface DensityState {
  readonly density: Density;
  /** null means the current value is the sampled device default, not a persisted choice. */
  readonly explicit: Density | null;
  readonly setDensity: (density: Density) => void;
}

export const useDensity = (controls: DaemonControlsStore): DensityState => {
  const device = useSyncExternalStore(
    controls.subscribe,
    () => controls.snapshot().device,
    () => controls.snapshot().device,
  );
  const [fallback] = useState(readImplicitDensity);
  const density = device.density ?? fallback;

  useEffect(() => {
    if (typeof document !== 'undefined') document.documentElement.dataset.density = density;
  }, [density]);

  const setDensity = useCallback((next: Density) => controls.setDeviceControls({ density: next }), [controls]);
  return { density, explicit: device.density, setDensity };
};
