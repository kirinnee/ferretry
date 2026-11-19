import { useSyncExternalStore } from 'react';

/** Tailwind's `lg`: from here the diff may sit in two columns. */
const WIDE = '(min-width: 1024px)';

const subscribe = (notify: () => void): (() => void) => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia(WIDE);
  query.addEventListener('change', notify);
  return () => query.removeEventListener('change', notify);
};

/** Whether the screen is 1024 px or wider. Read on the first render, so the right view draws once with no switch. */
export const useWide = (): boolean =>
  useSyncExternalStore(
    subscribe,
    () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(WIDE).matches,
    () => false,
  );
