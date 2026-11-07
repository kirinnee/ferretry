/**
 * Is this document on screen? A live stream is the one thing a hidden page should not keep paying for:
 * every frame it receives is metered on a relay, and nobody sees it. A consumer detaches while this is
 * `false` and reattaches when it turns `true`.
 */

import { useSyncExternalStore } from 'react';

const subscribe = (notify: () => void): (() => void) => {
  document.addEventListener('visibilitychange', notify);
  return () => document.removeEventListener('visibilitychange', notify);
};

const visibleNow = (): boolean => document.visibilityState !== 'hidden';

export function useDocumentVisible(): boolean {
  return useSyncExternalStore(subscribe, visibleNow);
}
