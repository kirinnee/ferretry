/**
 * What stands where a pairing link's fragment was, in anything an agent or a log may read.
 *
 * A pairing link carries its code in the fragment (`#v1;url=…;code=…;fp=…`, docs/pairing.md), and the
 * code is a live credential for somebody's machine. A page address is not secret in general, so it is
 * printed freely; THIS fragment is the one part of an address that must never be.
 */
export const PAIRING_FRAGMENT_HIDDEN = '#<pairing code hidden>';

/**
 * A pairing-link fragment: `#v1;` and everything after it up to the first character no address
 * contains. Every link that rides the `v1;` grammar — a pairing link, a catalog share or download
 * link — is hidden, because they share the form and a reader cannot tell them apart before reading.
 *
 * The fragment is also matched where an address was percent-encoded into another address (a redirect
 * parameter: `?next=…%23v1%3B…`, and once more for a double encoding), because that carries the same
 * code one layer down.
 */
const PAIRING_FRAGMENT_IN_TEXT = /(?:#|%23|%2523)v1(?:;|%3B|%253B)[^\s"'`<>()[\]{}\\]*/giu;

/**
 * `text` with every pairing-link fragment replaced by {@link PAIRING_FRAGMENT_HIDDEN}. Any other
 * fragment (`#section`) and the rest of the address are returned untouched. Pure and total: a string
 * with no such fragment is returned as it came.
 *
 * ONE FUNCTION FOR EVERY BROWSER SURFACE. A page's address reaches an agent through a result header,
 * a tab list, a navigation echo, a wait, a network or console entry and an error; each of them goes
 * through this, so there is no second opinion about what a pairing fragment looks like.
 */
export function hidePairingFragments(text: string): string {
  return text.includes('v1') ? text.replaceAll(PAIRING_FRAGMENT_IN_TEXT, PAIRING_FRAGMENT_HIDDEN) : text;
}
