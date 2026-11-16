import { useEffect, useRef } from 'react';

const MARKER = 'fyBackDismiss';

const markerOf = (state: unknown): unknown =>
  typeof state === 'object' && state !== null ? (state as Record<string, unknown>)[MARKER] : undefined;

/**
 * Lets the platform Back (a phone's back gesture, the browser button) dismiss an overlay instead of leaving
 * the page behind it. While `active`, one history entry is pushed at the SAME address, so Back lands on the
 * entry below and the overlay closes; a dismissal made any other way takes that entry back out. If the page
 * navigated away meanwhile, the entry is no longer the current one and is left alone rather than undoing the
 * navigation.
 */
export function useBackDismiss(active: boolean, dismiss: () => void): void {
  const dismissRef = useRef(dismiss);
  useEffect(() => {
    dismissRef.current = dismiss;
  }, [dismiss]);

  useEffect(() => {
    if (!active) return;
    const token = `${Date.now()}-${Math.random()}`;
    const kept = typeof window.history.state === 'object' && window.history.state !== null ? window.history.state : {};
    window.history.pushState({ ...kept, [MARKER]: token }, '');
    let pushed = true;
    const onPop = (): void => {
      if (!pushed || markerOf(window.history.state) === token) return;
      pushed = false;
      dismissRef.current();
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      if (pushed && markerOf(window.history.state) === token) window.history.back();
    };
  }, [active]);
}
