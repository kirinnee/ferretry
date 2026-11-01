/**
 * WHAT A PASTED LINK IS, for "Add a catalog from a link". Pure: it reads text and says which kind of link
 * it is, with one plain sentence for every kind that is not a share link. Nothing is sent from here.
 *
 * A `/join` link is read by its path and its fragment, whatever origin it names: it may have been made
 * for another copy of this app, and the join flow proves the publisher by its fingerprint, not by the host.
 */

import { parseShareFragment } from '@ferretry/protocol';
import { pairingArrival } from './pairing.ts';

export type CatalogLink =
  | { readonly kind: 'join'; readonly fragment: string }
  | { readonly kind: 'empty' | 'damaged' | 'pairing' | 'other'; readonly sentence: string };

export const LINK_EMPTY = 'Paste a share link first.';
export const LINK_DAMAGED = 'This link is damaged or incomplete. Ask for a new one.';
export const LINK_PAIRING = 'This links a device, not a catalog. Open it from Settings › Devices.';
export const LINK_OTHER = 'This is not a catalog share link. Ask the person who shared it for a new one.';

const parsedUrl = (text: string): URL | null => {
  try {
    return new URL(text);
  } catch {
    return null;
  }
};

export function classifyCatalogLink(pasted: string): CatalogLink {
  const text = pasted.trim();
  if (text === '') return { kind: 'empty', sentence: LINK_EMPTY };
  const url = parsedUrl(text);
  if (url === null) return { kind: 'other', sentence: LINK_OTHER };
  if (url.pathname.replace(/\/+$/u, '') === '/join') {
    try {
      parseShareFragment(url.hash);
    } catch {
      return { kind: 'damaged', sentence: LINK_DAMAGED };
    }
    return { kind: 'join', fragment: url.hash };
  }
  if (pairingArrival(text).kind !== 'none') return { kind: 'pairing', sentence: LINK_PAIRING };
  return { kind: 'other', sentence: LINK_OTHER };
}
