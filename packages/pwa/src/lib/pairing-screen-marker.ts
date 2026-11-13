import { PAIRING_SCREEN_META_NAME } from '@ferretry/protocol';
import { useEffect } from 'react';

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
 */

/** Starts showing the marker; returns the one function that stops it (idempotent). */
export function holdPairingScreenMarker(): () => void {
  if (typeof document === 'undefined') return () => undefined;
  const meta = document.createElement('meta');
  meta.name = PAIRING_SCREEN_META_NAME;
  meta.content = 'shown';
  document.head.appendChild(meta);
  return () => meta.remove();
}

/** Marks the document for as long as `shown` is true, and for exactly that long. */
export function usePairingScreenMarker(shown: boolean): void {
  useEffect(() => (shown ? holdPairingScreenMarker() : undefined), [shown]);
}
