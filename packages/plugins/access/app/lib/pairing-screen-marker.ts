import { PAIRING_SCREEN_META_NAME, PAIRING_SCREEN_SEEN_META_NAME } from '@ferretry/std/pairing-screen';
import { useLayoutEffect } from 'react';

/**
 * THE MARKER A SCREEN SHOWING A LIVE PAIRING CODE CARRIES (docs/pairing.md, "Never show it to an agent").
 *
 * While any screen shows a pairing code or its QR, the document's head holds a
 * `<meta name="ferretry-pairing-screen" content="shown">`. The browser the daemon drives looks for one before it
 * answers an agent, and refuses the page's text, picture and markup while it is there. The NAMES are owned by
 * `@ferretry/std/pairing-screen`, which the agent browser imports too, so the two cannot drift apart.
 *
 * EACH SCREEN ADDS AND REMOVES ITS OWN ELEMENT, and the document is the only state: two screens at once cannot clear
 * each other's marker, nothing is counted in the module, and nothing is left behind when a code is discarded, revoked,
 * expires or the screen unmounts.
 *
 * THE MARKER IS HELD IN THE SAME SYNCHRONOUS COMMIT AS THE CODE. It is a LAYOUT effect, not a passive one: a passive
 * effect runs in a later task, after the browser may have painted (or a DevTools read been answered) with the code on
 * screen and no marker. A layout effect's setup runs in the commit that inserted the code's DOM, and its cleanup in the
 * commit that removes it, so no task can observe the code without the marker.
 *
 * A second element, `ferretry-pairing-screen-seen`, counts how many times a code has come on screen in this document
 * and is never removed: a read that straddles a code appearing and going away still knows (see
 * `@ferretry/std/pairing-screen`).
 */

/** Starts showing the marker; returns the one function that stops it (idempotent). */
export function holdPairingScreenMarker(): () => void {
  if (typeof document === 'undefined') return () => undefined;
  countSighting();
  const meta = document.createElement('meta');
  meta.name = PAIRING_SCREEN_META_NAME;
  meta.content = 'shown';
  document.head.appendChild(meta);
  return () => meta.remove();
}

/** Adds one to the document's sighting count, creating the element on the first. */
function countSighting(): void {
  const found = document.head.querySelector(`meta[name="${PAIRING_SCREEN_SEEN_META_NAME}"]`);
  if (found !== null) {
    found.setAttribute('content', String((Number(found.getAttribute('content')) || 0) + 1));
    return;
  }
  const seen = document.createElement('meta');
  seen.name = PAIRING_SCREEN_SEEN_META_NAME;
  seen.content = '1';
  document.head.appendChild(seen);
}

/** Marks the document for as long as `shown` is true, and for exactly that long. */
export function usePairingScreenMarker(shown: boolean): void {
  useLayoutEffect(() => (shown ? holdPairingScreenMarker() : undefined), [shown]);
}
