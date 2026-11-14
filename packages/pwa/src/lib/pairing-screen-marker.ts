import { PAIRING_EPOCH_META_NAME, PAIRING_EPOCH_SELECTOR, PAIRING_SCREEN_META_NAME } from '@ferretry/protocol';
import { useLayoutEffect } from 'react';

/**
 * THE MARKER A SCREEN SHOWING A LIVE PAIRING CODE CARRIES (docs/pairing.md, "Never show it to an agent").
 *
 * While any screen shows a pairing code or its QR, the document's head holds a
 * `<meta name="ferretry-pairing-screen" content="shown">`. The browser the daemon drives looks for one before it
 * answers an agent, and refuses the page's text, picture and markup while it is there.
 *
 * EACH SCREEN ADDS AND REMOVES ITS OWN ELEMENT, and the document is the only state: two screens at once cannot clear
 * each other's marker, nothing is counted in the module, and nothing is left behind when a code is discarded, revoked,
 * expires or the screen unmounts.
 *
 * THE MARKER IS NEVER LATE. It is put up in a LAYOUT effect: React runs that inside the commit that put the code on the
 * page, in the same task, before the browser can paint or answer a query — a passive effect runs a task later, and a
 * read in between would see a code and no marker. It is taken down only after the code's own DOM is gone (the layout
 * effect's clean-up can run while a deleted screen's nodes are still being removed, so the removal waits a microtask,
 * which is after the whole commit).
 *
 * A COUNTER OUTLIVES THE MARKER. `<meta name="ferretry-pairing-epoch">` counts how many times this document showed a
 * code and is never removed, so the daemon can tell that a code was shown at some point while an agent's read, picture
 * or script was running even when it is gone again by the time that finishes.
 */

/** Counts one more code shown in this document. */
function bumpEpoch(): void {
  const existing = document.head.querySelector(PAIRING_EPOCH_SELECTOR);
  const seen = Number(existing?.getAttribute('content') ?? 0);
  const next = String(Number.isSafeInteger(seen) && seen >= 0 ? seen + 1 : 1);
  if (existing !== null) {
    existing.setAttribute('content', next);
    return;
  }
  const meta = document.createElement('meta');
  meta.name = PAIRING_EPOCH_META_NAME;
  meta.content = next;
  document.head.appendChild(meta);
}

/** Starts showing the marker; returns the one function that stops it (idempotent). */
export function holdPairingScreenMarker(): () => void {
  if (typeof document === 'undefined') return () => undefined;
  // The counter first: a read that sees the marker also sees a counter that already moved.
  bumpEpoch();
  const meta = document.createElement('meta');
  meta.name = PAIRING_SCREEN_META_NAME;
  meta.content = 'shown';
  document.head.appendChild(meta);
  return () => meta.remove();
}

/** Marks the document for as long as `shown` is true, and for exactly that long. */
export function usePairingScreenMarker(shown: boolean): void {
  useLayoutEffect(() => {
    if (!shown) return undefined;
    const release = holdPairingScreenMarker();
    return () => queueMicrotask(release);
  }, [shown]);
}
