/**
 * WHETHER THE PRIMARY POINTER IS A MOUSE OR TRACKPAD (`(pointer: fine)`): on such a screen swiping does
 * not matter, so the Attention page draws the selected item flat — no card, no swipe arrows. A browser
 * with no `matchMedia` is read as coarse, which keeps the swipe card.
 */

import { useSyncExternalStore } from 'react';

const FINE_POINTER = '(pointer: fine)';

const subscribe = (notify: () => void): (() => void) => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia(FINE_POINTER);
  query.addEventListener('change', notify);
  return () => query.removeEventListener('change', notify);
};

const read = (): boolean =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(FINE_POINTER).matches;

export const useFinePointer = (): boolean => useSyncExternalStore(subscribe, read, () => false);
