/**
 * Is this document on screen? A live stream is the one thing a hidden page should not keep paying for:
 * every frame it receives is metered on a relay, and nobody sees it. A consumer detaches while this is
 * `false` and reattaches when it turns `true`.
 */

import { useSyncExternalStore } from 'react';

// A renderer with no document (a server, a test renderer) has nothing to watch and nothing hidden.
const subscribe = (notify: () => void): (() => void) => {
  if (typeof document === 'undefined') return () => undefined;
  document.addEventListener('visibilitychange', notify);
  return () => document.removeEventListener('visibilitychange', notify);
};

const visibleNow = (): boolean => typeof document === 'undefined' || document.visibilityState !== 'hidden';

export function useDocumentVisible(): boolean {
  return useSyncExternalStore(subscribe, visibleNow);
}

/** The document seam {@link whenBackOnScreen} reads: its visibility and its `visibilitychange` event. */
type VisibleDocument = Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;

/**
 * Subscribes a listener to each return of `doc` to the foreground (`visibilitychange` to visible): the shell's re-read
 * trigger for every machine's grants (S1). Bound once by the composition root.
 */
export const whenBackOnScreen =
  (doc: VisibleDocument) =>
  (listener: () => void): (() => void) => {
    const back = (): void => {
      if (doc.visibilityState === 'visible') listener();
    };
    doc.addEventListener('visibilitychange', back);
    return () => doc.removeEventListener('visibilitychange', back);
  };
