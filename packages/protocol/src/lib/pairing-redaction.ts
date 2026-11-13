/**
 * What stands where a pairing link's fragment was, in anything an agent or a log may read.
 *
 * A pairing link carries its code in the fragment (`#v1;url=…;code=…;fp=…`, docs/pairing.md), and the
 * code is a live credential for somebody's machine. A page address is not secret in general, so it is
 * printed freely; THIS fragment is the one part of an address that must never be.
 */
export const PAIRING_FRAGMENT_HIDDEN = '#<pairing code hidden>';

/**
 * A pairing-link fragment: `#v1;` and EVERYTHING after it up to the next whitespace. Every link that rides
 * the `v1;` grammar — a pairing link, a catalog share or download link — is hidden, because they share the form
 * and a reader cannot tell them apart before reading.
 *
 * THE FIELDS ARE NOT PARSED, ON PURPOSE. The grammar (docs/pairing.md) lets a link carry its fields in any
 * order and ignores one it does not know, and a value may hold any punctuation (`encodeURIComponent` itself
 * leaves `()'!*~` alone). A matcher that stopped at "a character no address contains" could therefore stop
 * BEFORE the code. So once a fragment starts as a pairing fragment, all of it goes. The one thing given back is a run of
 * sentence punctuation at the very END of the word (`…fp=x).`): a code is letters, digits and `-`, so a run with none of
 * those cannot hold one, and the sentence around the address stays readable.
 *
 * The fragment is also matched where an address was percent-encoded into another address (a redirect
 * parameter: `?next=…%23v1%3B…`, and once more for a double encoding), because that carries the same
 * code one layer down.
 */
const PAIRING_FRAGMENT_IN_TEXT = /(?:#|%23|%2523)v1(?:;|%3B|%253B)\S*/giu;

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
  return text.includes('v1')
    ? text.replaceAll(PAIRING_FRAGMENT_IN_TEXT, found => PAIRING_FRAGMENT_HIDDEN + closingPunctuation(found))
    : text;
}

/** The run of sentence punctuation a matched word ends with ("" when it does not), found in one pass from the end. */
function closingPunctuation(word: string): string {
  let start = word.length;
  while (start > 0 && CLOSING.has(word.charAt(start - 1))) start -= 1;
  return word.slice(start);
}

const CLOSING: ReadonlySet<string> = new Set([...')]}>"\'`.,;:!?']);

/**
 * `value` with {@link hidePairingFragments} applied to every string in it: the one projection for a whole
 * result (a JSON answer, a list of pages, a nested echo). Only arrays and plain objects are walked, and a
 * picture's base64 bytes (`screenshotBase64`) pass as they are — they are not text. Pure and total.
 */
export function hidePairingFragmentsIn<T>(value: T): T {
  return walk(value) as T;
}

function walk(value: unknown): unknown {
  if (typeof value === 'string') return hidePairingFragments(value);
  if (Array.isArray(value)) return value.map(walk);
  if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, key === 'screenshotBase64' ? item : walk(item)]),
  );
}
