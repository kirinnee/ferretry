import type { UrlPolicy } from 'durian-markdown';

/**
 * THE ONE DOOR EVERY LINK IN A MESSAGE PASSES, at parse and again at render. A link an agent wrote may go to the
 * outside web (`http`, `https`), to a mail address (`mailto:`), or to a heading of the same message (`#anchor`). Nothing
 * else is a destination:
 *
 *  - an IMAGE is never drawn: Durian's default lets any https picture through, which is a tracking pixel (and our CSP
 *    would block it, leaving a broken box). A picture goes through an `fy-render` image block.
 *  - a REFERENCE ENVELOPE (`#fy-reference?…`, however it is spelled) is not a link: a reference is a token that our own
 *    proof gate turned into a chip, never an address an agent can write (docs/reference-standard.md §1). Dropping it here
 *    means a forged one is the text the agent wrote, not a click target.
 *  - an app route (`/d/…`), any relative path and a protocol-relative address would navigate THIS app or another origin
 *    unasked; they are dropped, and the text stays.
 *
 * Durian runs its own scheme check after this returns (a script, `data:`, `blob:` and `file:` are always refused).
 */
export const hypermediaUrlPolicy: UrlPolicy = (url, kind) => {
  if (kind === 'image') return null;
  const address = url.trim();
  if (address === '' || address.length > 2048) return null;
  if (address.startsWith('#')) return forgesReference(address) ? null : address;
  return /^(?:https?:|mailto:)/iu.test(address) ? address : null;
};

/** The reserved envelope's name, found through every spelling a browser would still read as the same fragment. */
function forgesReference(fragment: string): boolean {
  let decoded = fragment;
  try {
    decoded = decodeURIComponent(fragment);
  } catch {
    // A malformed escape is read as typed, and still checked below.
  }
  // Control characters and spaces are ignored by the browser's URL parser, so they are ignored here too.
  const squeezed = decoded.replace(/[\p{Cc}\p{Cf}\p{Z}]/gu, '');
  return /^#fy-reference/iu.test(squeezed) || /^#fy-reference/iu.test(fragment.replace(/[\p{Cc}\p{Z}]/gu, ''));
}
