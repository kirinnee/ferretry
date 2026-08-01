import { useEffect, useRef, useState } from 'react';

/** Opt-in marker; transcript scrollers never carry it because pull loads history there. */
export const PULL_TO_PALETTE_ATTR = 'data-pull-to-palette';
export const PALETTE_PULL_THRESHOLD_PX = 96;

export interface PalettePull {
  readonly armed: boolean;
  readonly startY: number;
  readonly distance: number;
}

export const NO_PULL: PalettePull = { armed: false, startY: 0, distance: 0 };

export const beginPull = ({
  touches,
  scrollTop,
  clientY,
}: {
  touches: number;
  scrollTop: number;
  clientY: number;
}): PalettePull => {
  if (touches !== 1 || scrollTop > 0) return NO_PULL;
  return { armed: true, startY: clientY, distance: 0 };
};

export const advancePull = (
  state: PalettePull,
  { touches, scrollTop, clientY }: { touches: number; scrollTop: number; clientY: number },
): PalettePull => {
  if (!state.armed || touches !== 1 || scrollTop > 0) return NO_PULL;
  const travel = clientY - state.startY;
  return { armed: true, startY: state.startY, distance: travel > 0 ? travel : 0 };
};

export const endPull = (state: PalettePull, threshold = PALETTE_PULL_THRESHOLD_PX): boolean =>
  state.armed && state.distance >= threshold;

export const palettePullProgress = (distance: number, threshold = PALETTE_PULL_THRESHOLD_PX): number => {
  if (!(distance > 0) || !(threshold > 0)) return 0;
  return Math.min(1, distance / threshold);
};

export interface PullToPalette {
  readonly distance: number;
  readonly progress: number;
  readonly armed: boolean;
}

const pullScrollerOf = (target: EventTarget | null): HTMLElement | null => {
  const element = target as Element | null;
  return element === null || typeof element.closest !== 'function'
    ? null
    : element.closest<HTMLElement>(`[${PULL_TO_PALETTE_ATTR}]`);
};

/** Delegated passive pull handling for all opted-in page scrollers under one shell root. */
export function usePullToPalette(
  rootRef: { current: HTMLElement | null },
  {
    enabled,
    onOpen,
    threshold = PALETTE_PULL_THRESHOLD_PX,
  }: { readonly enabled: boolean; readonly onOpen: () => void; readonly threshold?: number },
): PullToPalette {
  const [distance, setDistance] = useState(0);
  const openRef = useRef(onOpen);
  openRef.current = onOpen;

  useEffect(() => {
    const root = rootRef.current;
    if (!enabled || root === null) {
      setDistance(0);
      return undefined;
    }
    let pull = NO_PULL;
    let scroller: HTMLElement | null = null;
    const reset = (): void => {
      pull = NO_PULL;
      scroller = null;
      setDistance(0);
    };
    const onStart = (event: TouchEvent): void => {
      scroller = pullScrollerOf(event.target);
      const touch = event.touches[0];
      if (scroller === null || touch === undefined) {
        reset();
        return;
      }
      pull = beginPull({ touches: event.touches.length, scrollTop: scroller.scrollTop, clientY: touch.clientY });
      setDistance(pull.distance);
    };
    const onMove = (event: TouchEvent): void => {
      if (!pull.armed || scroller === null) return;
      const touch = event.touches[0];
      if (touch === undefined) {
        reset();
        return;
      }
      pull = advancePull(pull, {
        touches: event.touches.length,
        scrollTop: scroller.scrollTop,
        clientY: touch.clientY,
      });
      setDistance(pull.distance);
    };
    const onEnd = (): void => {
      const opens = endPull(pull, threshold);
      reset();
      if (opens) openRef.current();
    };
    root.addEventListener('touchstart', onStart, { passive: true });
    root.addEventListener('touchmove', onMove, { passive: true });
    root.addEventListener('touchend', onEnd, { passive: true });
    root.addEventListener('touchcancel', reset, { passive: true });
    return () => {
      root.removeEventListener('touchstart', onStart);
      root.removeEventListener('touchmove', onMove);
      root.removeEventListener('touchend', onEnd);
      root.removeEventListener('touchcancel', reset);
      setDistance(0);
    };
  }, [enabled, rootRef, threshold]);

  return { distance, progress: palettePullProgress(distance, threshold), armed: distance >= threshold };
}
