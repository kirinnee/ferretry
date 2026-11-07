/**
 * WHETHER THE PRIMARY POINTER IS A MOUSE OR TRACKPAD (`(pointer: fine)`): on such a screen swiping does
 * not matter, so the chat's agenda has no swipe arrows and may dock beside the chat. A browser with no
 * `matchMedia` is read as coarse, which keeps the touch layout.
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
