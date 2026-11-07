import { useEffect, useRef, useState } from 'react';

/** Downward travel needed to focus search from the top of a touch list. */
export const PULL_THRESHOLD_PX = 64;

export const pullProgress = (distance: number, threshold = PULL_THRESHOLD_PX): number => {
  if (!(distance > 0) || !(threshold > 0)) return 0;
  return Math.min(1, distance / threshold);
};

export const pullTriggered = (distance: number, threshold = PULL_THRESHOLD_PX): boolean => distance >= threshold;

export interface PullToSearch {
  readonly distance: number;
  readonly progress: number;
  readonly armed: boolean;
}

/**
 * Passive, top-of-list touch pull. The owning scroller supplies
 * `overscroll-y-contain`; this hook never prevents default or competes with
 * native scroll/long-press handling.
 */
export function usePullToSearch(
  scrollerRef: { current: HTMLElement | null },
  {
    enabled,
    onTrigger,
    threshold = PULL_THRESHOLD_PX,
  }: { readonly enabled: boolean; readonly onTrigger: () => void; readonly threshold?: number },
): PullToSearch {
  const [distance, setDistance] = useState(0);
  const triggerRef = useRef(onTrigger);
  triggerRef.current = onTrigger;

  useEffect(() => {
    const element = scrollerRef.current;
    if (!enabled || element === null) return undefined;
    let pulling = false;
    let startY = 0;
    let pulled = 0;
    const reset = (): void => {
      pulling = false;
      pulled = 0;
      setDistance(0);
    };
    const onStart = (event: TouchEvent): void => {
      if (event.touches.length !== 1) {
        reset();
        return;
      }
      if (element.scrollTop <= 0) {
        pulling = true;
        startY = event.touches[0]?.clientY ?? 0;
        pulled = 0;
      } else {
        pulling = false;
      }
    };
    const onMove = (event: TouchEvent): void => {
      if (!pulling) return;
      if (element.scrollTop > 0) {
        reset();
        return;
      }
      const next = (event.touches[0]?.clientY ?? startY) - startY;
      pulled = next > 0 ? next : 0;
      setDistance(pulled);
    };
    const onEnd = (): void => {
      const fired = pulling && pulled >= threshold;
      reset();
      if (fired) triggerRef.current();
    };
    element.addEventListener('touchstart', onStart, { passive: true });
    element.addEventListener('touchmove', onMove, { passive: true });
    element.addEventListener('touchend', onEnd, { passive: true });
    element.addEventListener('touchcancel', reset, { passive: true });
    return () => {
      element.removeEventListener('touchstart', onStart);
      element.removeEventListener('touchmove', onMove);
      element.removeEventListener('touchend', onEnd);
      element.removeEventListener('touchcancel', reset);
    };
  }, [enabled, scrollerRef, threshold]);

  return { distance, progress: pullProgress(distance, threshold), armed: pullTriggered(distance, threshold) };
}
