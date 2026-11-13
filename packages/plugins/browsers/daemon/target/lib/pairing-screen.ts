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
    const seen = counts.reduce((sum, hit) => sum + (Number.parseInt(hit.content ?? '', 10) || 0), 0);
    return { marked: marked.length > 0, seen };
  } catch {
    return PAIRING_SCREEN_UNKNOWN;
  }
}

interface Hit {
  readonly content?: string;
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
      const attributes = attributesOf(await session.send('DOM.getAttributes', { nodeId }).catch(() => undefined));
      // A text node or an element of some other name: DevTools' plain-text search matched words, not the marker.
      if (attributes.get('name') === name) hits.push({ content: attributes.get('content') ?? '' });
    }
    return hits;
  } finally {
    await session.send('DOM.discardSearchResults', { searchId }).catch(() => undefined);
  }
}

/** DevTools lists attributes as one flat `[name, value, name, value…]` array. */
function attributesOf(answer: unknown): ReadonlyMap<string, string> {
  const flat = objectOf(answer).attributes;
  const map = new Map<string, string>();
  if (!Array.isArray(flat)) return map;
  for (let index = 0; index + 1 < flat.length; index += 2)
    if (typeof flat[index] === 'string' && typeof flat[index + 1] === 'string')
      map.set(flat[index] as string, flat[index + 1] as string);
  return map;
}

const objectOf = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
