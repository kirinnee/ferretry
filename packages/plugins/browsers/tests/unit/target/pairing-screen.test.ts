import { describe, expect, test } from 'bun:test';
import { PAIRING_SCREEN_META_NAME, PAIRING_SCREEN_SEEN_META_NAME } from '@ferretry/std/pairing-screen';
import type { InputCdpSession } from '../../../daemon/target/lib/fields.ts';
import { PAIRING_SCREEN_UNKNOWN, readPairingScreen } from '../../../daemon/target/lib/pairing-screen.ts';

/**
 * WHAT THE BROWSER WORKER SAYS ABOUT A PAIRING CODE (docs/pairing.md, "Never show it to an agent"): a DevTools DOM
 * search — never a page script — for the app's marker and its sighting count, believed only in the shape DevTools gives.
 */
interface Node {
  readonly id: number;
  /** `null`: a text node, which DevTools' plain-text search may match and which has no attributes. */
  readonly attributes: readonly string[] | null;
  /** How DevTools' answer about this node is malformed, when a case is about that. */
  readonly shape?: 'broken' | 'odd' | 'unreadable';
}

/** A DevTools session over a document of `nodes`: a search finds the nodes the test lists for that query. */
function sessionOf(
  hits: Readonly<Record<string, readonly Node[]>>,
  options: { readonly failOn?: string; readonly shape?: 'wrong' } = {},
) {
  const sent: string[] = [];
  const discarded: string[] = [];
  const nodes = new Map<number, Node>();
  for (const found of Object.values(hits)) for (const node of found) nodes.set(node.id, node);
  const session: InputCdpSession = {
    send: async (method, params) => {
      sent.push(method);
      if (method === options.failOn) throw new Error('the page is gone');
      switch (method) {
        case 'DOM.getDocument':
          return { root: { nodeId: 1 } };
        case 'DOM.performSearch':
          if (options.shape === 'wrong') return { resultCount: 'many' };
          return { searchId: String(params?.query), resultCount: (hits[String(params?.query)] ?? []).length };
        case 'DOM.getSearchResults':
          return { nodeIds: (hits[String(params?.searchId)] ?? []).map(node => node.id) };
        case 'DOM.describeNode': {
          const node = nodes.get(Number(params?.nodeId));
          if (node === undefined) throw new Error('No node with given id found');
          if (node.attributes === null) return { node: { nodeType: 3, nodeName: '#text' } };
          if (node.shape === 'broken') return { node: { nodeType: 1, nodeName: 'META', attributes: 'name' } };
          if (node.shape === 'odd') return { node: { nodeType: 1, nodeName: 'META', attributes: ['name'] } };
          if (node.shape === 'unreadable') return { node: {} };
          return { node: { nodeType: 1, nodeName: 'META', attributes: node.attributes } };
        }
        case 'DOM.discardSearchResults':
          discarded.push(String(params?.searchId));
          return {};
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
  };
  return { session, sent, discarded };
}

const MARKER = 'meta[name="ferretry-pairing-screen"]';
const SEEN = 'meta[name="ferretry-pairing-screen-seen"]';
const marker = (id: number): Node => ({ id, attributes: ['name', PAIRING_SCREEN_META_NAME, 'content', 'shown'] });
const seen = (id: number, count: number): Node => ({
  id,
  attributes: ['name', PAIRING_SCREEN_SEEN_META_NAME, 'content', String(count)],
});

describe('the worker’s look for the pairing-screen marker', () => {
  test('it says marked when the marker is in the document, with the sighting count', async () => {
    const { session, discarded } = sessionOf({ [MARKER]: [marker(5)], [SEEN]: [seen(6, 3)] });
    expect(await readPairingScreen(session)).toEqual({ marked: true, seen: 3 });
    expect(discarded.sort()).toEqual([MARKER, SEEN].sort());
  });

  test('it says unmarked, with the count a gone code left behind, when only the sighting element is there', async () => {
    const { session } = sessionOf({ [MARKER]: [], [SEEN]: [seen(6, 2)] });
    expect(await readPairingScreen(session)).toEqual({ marked: false, seen: 2 });
  });

  test('it says unmarked and never seen for a page that never showed a code', async () => {
    const { session } = sessionOf({ [MARKER]: [], [SEEN]: [] });
    expect(await readPairingScreen(session)).toEqual({ marked: false, seen: 0 });
  });

  test('it adds up every document it reached: a marker in a frame counts, and so do the frames’ own counts', async () => {
    const { session } = sessionOf({ [MARKER]: [marker(5), marker(9)], [SEEN]: [seen(6, 1), seen(10, 4)] });
    expect(await readPairingScreen(session)).toEqual({ marked: true, seen: 5 });
  });

  test('it ignores a hit that is not the marker: DevTools’ search also matches words, and a page may say the selector aloud', async () => {
    const wording: Node = { id: 7, attributes: null };
    const other: Node = { id: 8, attributes: ['name', 'viewport', 'content', 'width=device-width'] };
    const { session } = sessionOf({ [MARKER]: [wording, other], [SEEN]: [wording] });
    expect(await readPairingScreen(session)).toEqual({ marked: false, seen: 0 });
  });

  test('it FAILS CLOSED on a count that is not plain digits: no NaN becomes zero, no prefix is believed', async () => {
    for (const content of ['12abc', 'lots', '', '-1', '+3', '1e3', ' 4', '0x10', '01', '1.5', '1234567890', '９']) {
      const forged: Node = { id: 6, attributes: ['name', PAIRING_SCREEN_SEEN_META_NAME, 'content', content] };
      expect(await readPairingScreen(sessionOf({ [MARKER]: [], [SEEN]: [forged] }).session)).toEqual(
        PAIRING_SCREEN_UNKNOWN,
      );
    }
    const none: Node = { id: 6, attributes: ['name', PAIRING_SCREEN_SEEN_META_NAME] };
    expect(await readPairingScreen(sessionOf({ [MARKER]: [], [SEEN]: [none] }).session)).toEqual(
      PAIRING_SCREEN_UNKNOWN,
    );
  });

  test('it reads a count of plain digits', async () => {
    const plain: Node = { id: 6, attributes: ['name', PAIRING_SCREEN_SEEN_META_NAME, 'content', '12'] };
    expect(await readPairingScreen(sessionOf({ [MARKER]: [], [SEEN]: [plain] }).session)).toEqual({
      marked: false,
      seen: 12,
    });
  });

  test('it FAILS CLOSED when a possible marker cannot be inspected: a failed describe is not an empty attribute map', async () => {
    const hit = marker(5);
    for (const method of ['DOM.describeNode'])
      expect(await readPairingScreen(sessionOf({ [MARKER]: [hit], [SEEN]: [] }, { failOn: method }).session)).toEqual(
        PAIRING_SCREEN_UNKNOWN,
      );
  });

  test('it FAILS CLOSED on a node whose attributes are not the shape DevTools gives', async () => {
    for (const shape of ['broken', 'odd', 'unreadable'] as const) {
      const hit: Node = { id: 5, attributes: ['name', PAIRING_SCREEN_META_NAME, 'content', 'shown'], shape };
      expect(await readPairingScreen(sessionOf({ [MARKER]: [hit], [SEEN]: [] }).session)).toEqual(
        PAIRING_SCREEN_UNKNOWN,
      );
    }
  });

  test('it FAILS CLOSED when any DevTools call cannot be answered', async () => {
    for (const method of ['DOM.getDocument', 'DOM.performSearch', 'DOM.getSearchResults'])
      expect(
        await readPairingScreen(sessionOf({ [MARKER]: [marker(5)], [SEEN]: [seen(6, 1)] }, { failOn: method }).session),
      ).toEqual(PAIRING_SCREEN_UNKNOWN);
  });

  test('it FAILS CLOSED on an answer that is not the shape DevTools gives', async () => {
    expect(await readPairingScreen(sessionOf({}, { shape: 'wrong' }).session)).toEqual(PAIRING_SCREEN_UNKNOWN);
  });

  test('it FAILS CLOSED on a page that answers a search with a crowd', async () => {
    const crowd = Array.from({ length: 65 }, (_, index) => marker(index + 10));
    expect(await readPairingScreen(sessionOf({ [MARKER]: crowd, [SEEN]: [] }).session)).toEqual(PAIRING_SCREEN_UNKNOWN);
  });

  test('its refusal is marked, with a count no document has', () => {
    expect(PAIRING_SCREEN_UNKNOWN).toEqual({ marked: true, seen: -1 });
  });

  test('it asks only DevTools’ DOM domain: no page script runs', async () => {
    const { session, sent } = sessionOf({ [MARKER]: [marker(5)], [SEEN]: [seen(6, 1)] });
    await readPairingScreen(session);
    expect(sent.every(method => method.startsWith('DOM.'))).toBe(true);
  });
});
