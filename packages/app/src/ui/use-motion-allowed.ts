/**
 * MAY THIS SCREEN MOVE? The ONE answer every animated piece asks (a sortable list's settle, a setting preview's loop, a
 * breathing grid), so none of them re-reads the two switches itself.
 *
 * It is `false` under EITHER switch:
 *   - the operating system's `prefers-reduced-motion: reduce`, or
 *   - Settings › Appearance › Motion › Reduced, which the shell writes as `<html data-motion="reduced">`.
 *
 * `usePrefersReducedMotion` (bottom-sheet) reads only the first, so a person who chose "Reduced" in Ferretry but not in
 * their OS would still have been animated. This hook follows both, live: flipping either one re-renders its readers.
 */
import { useSyncExternalStore } from 'react';

const OS_REDUCED = '(prefers-reduced-motion: reduce)';
const APP_ATTRIBUTE = 'data-motion';

const osReduces = (): boolean => typeof window !== 'undefined' && window.matchMedia?.(OS_REDUCED).matches === true;

const appReduces = (): boolean =>
  typeof document !== 'undefined' && document.documentElement.getAttribute(APP_ATTRIBUTE) === 'reduced';

/** Pure: movement is allowed only when neither switch asks for stillness. */
export const motionAllowed = (osReducedMotion: boolean, appReducedMotion: boolean): boolean =>
  !osReducedMotion && !appReducedMotion;

const subscribe = (notify: () => void): (() => void) => {
  const media = typeof window !== 'undefined' ? (window.matchMedia?.(OS_REDUCED) ?? null) : null;
  media?.addEventListener('change', notify);
  const observer = typeof MutationObserver === 'function' ? new MutationObserver(notify) : null;
  observer?.observe(document.documentElement, { attributes: true, attributeFilter: [APP_ATTRIBUTE] });
  return () => {
    media?.removeEventListener('change', notify);
    observer?.disconnect();
  };
};

const allowedNow = (): boolean => motionAllowed(osReduces(), appReduces());

export function useMotionAllowed(): boolean {
  return useSyncExternalStore(subscribe, allowedNow);
}
