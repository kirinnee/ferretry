import {
  PAIRING_SCREEN_META_NAME,
  PAIRING_SCREEN_SEEN_META_NAME,
  PAIRING_SCREEN_SEEN_SELECTOR,
  PAIRING_SCREEN_SELECTOR,
} from '@ferretry/std/pairing-screen';
import type { InputCdpSession } from './fields.ts';

/**
 * WHAT A DOCUMENT SAYS ABOUT A PAIRING CODE (docs/pairing.md, "Never show it to an agent"): whether the app's marker is
 * in it now, and how many times a code has come on screen in it (the sighting count that outlives the marker).
 */
export interface PairingScreenState {
  /** A `<meta name="ferretry-pairing-screen">` is in the page or in a frame of it: a live code is on screen. */
  readonly marked: boolean;
  /** The sum of the sighting counts of every document the query reached; `-1` when it could not be read. */
  readonly seen: number;
}

/** The answer when the browser cannot say: marked, and a count no real document has. A refusal costs one read. */
export const PAIRING_SCREEN_UNKNOWN: PairingScreenState = { marked: true, seen: -1 };

/** More hits than this is not an app's marker: it is a page hand-built to be noisy, and is refused as unreadable. */
const MAX_HITS = 64;

/**
 * Reads the marker and the sighting count of the page's main document AND of every frame of it that runs in the page's
 * process (a same-origin frame always does) — a plain DevTools DOM search, so NO PAGE SCRIPT RUNS: a page cannot answer
 * for itself, and a page that forges the marker only loses its own reads. A hit counts only when its own attributes
 * name the marker, because DevTools' search also matches plain text and a page may say the selector aloud.
 *
 * FAILS CLOSED. A query that cannot be answered, an answer that is not the shape DevTools gives, or a page that
 * answers with a crowd of hits is {@link PAIRING_SCREEN_UNKNOWN}: marked.
 */
export async function readPairingScreen(session: InputCdpSession): Promise<PairingScreenState> {
  try {
    // The DOM agent answers searches only once it has handed out the document.
    await session.send('DOM.getDocument', { depth: 0 });
    const marked = await hitsOf(session, PAIRING_SCREEN_SELECTOR, PAIRING_SCREEN_META_NAME);
    const counts = await hitsOf(session, PAIRING_SCREEN_SEEN_SELECTOR, PAIRING_SCREEN_SEEN_META_NAME);
    if (marked === undefined || counts === undefined) return PAIRING_SCREEN_UNKNOWN;
    let seen = 0;
    for (const hit of counts) {
      const count = countOf(hit.content);
      if (count === undefined) return PAIRING_SCREEN_UNKNOWN;
      seen += count;
    }
    if (!Number.isSafeInteger(seen)) return PAIRING_SCREEN_UNKNOWN;
    return { marked: marked.length > 0, seen };
  } catch {
    return PAIRING_SCREEN_UNKNOWN;
  }
}

interface Hit {
  /** The element's `content` attribute; absent when it has none. */
  readonly content: string | undefined;
}

/** The elements a search finds whose own `name` attribute is `name`; `undefined` when the answer cannot be believed. */
async function hitsOf(session: InputCdpSession, query: string, name: string): Promise<readonly Hit[] | undefined> {
  const found = objectOf(await session.send('DOM.performSearch', { query }));
  const searchId = found.searchId;
  const count = found.resultCount;
  if (typeof searchId !== 'string' || typeof count !== 'number') return undefined;
  try {
    if (count > MAX_HITS) return undefined;
    if (count === 0) return [];
    const listed = objectOf(await session.send('DOM.getSearchResults', { searchId, fromIndex: 0, toIndex: count }));
    if (!Array.isArray(listed.nodeIds)) return undefined;
    const hits: Hit[] = [];
    for (const nodeId of listed.nodeIds) {
      if (typeof nodeId !== 'number') return undefined;
      // WHAT KIND OF NODE IT IS is asked, not guessed from a failure: a text node (DevTools' plain-text search matched words)
      // is a verified non-hit, while a node that cannot be described or whose attributes are not the shape DevTools gives
      // is one that cannot be inspected — and a possible marker nobody could inspect is a marker (fail closed).
      const node = objectOf(objectOf(await session.send('DOM.describeNode', { nodeId })).node);
      if (node.nodeType !== ELEMENT_NODE) {
        if (typeof node.nodeType !== 'number' || !Number.isInteger(node.nodeType)) return undefined;
        continue;
      }
      const attributes = attributesOf(node.attributes);
      if (attributes === undefined) return undefined;
      // An element of some other name: the search matched its words, not the marker.
      if (attributes.get('name') === name) hits.push({ content: attributes.get('content') });
    }
    return hits;
  } finally {
    await session.send('DOM.discardSearchResults', { searchId }).catch(() => undefined);
  }
}

/** `Node.ELEMENT_NODE`. */
const ELEMENT_NODE = 1;

/** The longest a sighting count's text may be: far past any real count, short of anything that is not one. */
const MAX_COUNT_DIGITS = 9;

/** A sighting count as plain digits only — no sign, no space, no suffix, no leading zero; anything else is `undefined`. */
function countOf(text: string | undefined): number | undefined {
  if (text === undefined || text.length > MAX_COUNT_DIGITS || !/^(?:0|[1-9][0-9]*)$/u.test(text)) return undefined;
  return Number(text);
}

/**
 * DevTools lists attributes as one flat `[name, value, name, value…]` array. An element with NONE has no `attributes`
 * member (a plain `<meta>` always has some); anything else — not an array, an odd length, a non-string — is not what
 * DevTools gives, and is `undefined`.
 */
function attributesOf(flat: unknown): ReadonlyMap<string, string> | undefined {
  const map = new Map<string, string>();
  if (flat === undefined) return map;
  if (!Array.isArray(flat) || flat.length % 2 !== 0) return undefined;
  for (let index = 0; index < flat.length; index += 2) {
    const key = flat[index];
    const value = flat[index + 1];
    if (typeof key !== 'string' || typeof value !== 'string') return undefined;
    if (!map.has(key)) map.set(key, value);
  }
  return map;
}

const objectOf = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
