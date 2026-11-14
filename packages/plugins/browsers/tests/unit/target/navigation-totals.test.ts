import { describe, expect, test } from 'bun:test';
import {
  MAX_COMMITTED_ORIGINS,
  mergeTotals,
  NavigationLedger,
  type NavigationSource,
  NavigationTotalsLedger,
  parseNavigationEvidence,
} from '../../../daemon/target/lib/navigation-evidence.ts';

/**
 * WHAT THE WORKER HAS COUNTED ACROSS EVERY PAGE (docs/pairing.md, "Never show it to an agent"): pairing links committed,
 * by origin, and navigations it lost track of. One ledger of totals is shared by every page's ledger, the closed ones
 * included, and a count only goes up — so no navigation, close or script can take what a page showed out of it.
 */
const LINK = 'https://app.example.test/pair#v1;url=x;code=FAKE-PAIR-0000';

describe('the worker’s totals', () => {
  test('a link committed by any page is counted under its origin, and a closed page takes none of it away', () => {
    const totals = new NavigationTotalsLedger();
    const first = new NavigationLedger(() => 1, totals);
    const second = new NavigationLedger(() => 1, totals);

    first.commit('main', LINK);
    second.commit('main', LINK);
    second.commit('main', 'https://docs.example.test/#section');
    // the first page closes: nothing is subtracted, there is nothing to call
    const evidence = second.evidence();

    expect(evidence.totals.links).toEqual({ 'https://app.example.test': 2 });
    expect(evidence.totals.lost).toBe(0);
  });

  test('every page answers with the same totals, whichever one is asked', () => {
    const totals = new NavigationTotalsLedger();
    const first = new NavigationLedger(() => 1, totals);
    const second = new NavigationLedger(() => 1, totals);

    first.commit('main', LINK);

    expect(second.evidence().totals).toEqual(first.evidence().totals);
  });

  test('a navigation it cannot follow is counted, and it is counted for every page', async () => {
    const totals = new NavigationTotalsLedger();
    const lost = new NavigationLedger(() => 1, totals);
    const other = new NavigationLedger(() => 1, totals);
    const session: NavigationSource = {
      on: () => undefined,
      send: async method => {
        if (method === 'Page.getFrameTree') throw new Error('the page is gone');
        return {};
      },
    };

    await lost.attach(session);

    expect(lost.evidence().totals.lost).toBe(1);
    expect(other.evidence().totals.lost).toBe(1);
  });

  test('an unreadable frame event and an unattachable page each count as a loss', () => {
    const totals = new NavigationTotalsLedger();
    const ledger = new NavigationLedger(() => 1, totals);

    ledger.lose();
    ledger.lose();

    expect(totals.snapshot().lost).toBe(2);
  });

  test('more origins than it names is one overflow bucket, never a forgotten link', () => {
    const totals = new NavigationTotalsLedger();
    const ledger = new NavigationLedger(() => 1, totals);

    for (let index = 0; index <= MAX_COMMITTED_ORIGINS + 1; index++)
      ledger.commit('main', `https://h${String(index)}.example.test/#v1;code=FAKE-PAIR-0000`);
    const links = totals.snapshot().links;

    expect(Object.keys(links)).toHaveLength(MAX_COMMITTED_ORIGINS + 1);
    expect(links['*']).toBeGreaterThan(0);
    // the page's own list overflowing is that page's flag, not the whole worker's blindness
    expect(ledger.evidence().overflow).toBe(true);
    expect(totals.snapshot().lost).toBe(0);
  });

  test('a fresh totals ledger starts complete: nothing counted, nothing lost', () => {
    expect(new NavigationTotalsLedger().snapshot()).toEqual({ links: {}, lost: 0 });
  });

  test('merging two answers keeps the larger of every count', () => {
    expect(mergeTotals({ links: { a: 1, b: 4 }, lost: 1 }, { links: { a: 3, c: 2 }, lost: 0 })).toEqual({
      links: { a: 3, b: 4, c: 2 },
      lost: 1,
    });
  });
});

describe('the daemon’s belief in the totals', () => {
  const good = {
    seq: 1,
    origins: [{ origin: 'https://app.example.test', firstAt: 1, lastSeq: 1 }],
    overflow: false,
    frames: ['https://app.example.test'],
    taintSeq: 0,
    watchedSince: 1,
    totals: { links: { 'https://app.example.test': 2 }, lost: 0 },
  };

  test('it believes the exact shape', () => {
    expect(parseNavigationEvidence(good)?.totals).toEqual(good.totals);
  });

  test('it believes no evidence without them, and none with a malformed count', () => {
    const { totals: _gone, ...without } = good;
    const bad: unknown[] = [
      without,
      { ...good, totals: null },
      { ...good, totals: { links: {} } },
      { ...good, totals: { lost: 0 } },
      { ...good, totals: { links: {}, lost: -1 } },
      { ...good, totals: { links: {}, lost: 1.5 } },
      { ...good, totals: { links: {}, lost: '0' } },
      { ...good, totals: { links: { a: -1 }, lost: 0 } },
      { ...good, totals: { links: { a: Number.NaN }, lost: 0 } },
      { ...good, totals: { links: { a: '1' }, lost: 0 } },
      { ...good, totals: { links: [], lost: 0 } },
      { ...good, totals: { links: {}, lost: 0, more: 1 } },
      {
        ...good,
        totals: {
          links: Object.fromEntries(Array.from({ length: MAX_COMMITTED_ORIGINS + 2 }, (_, i) => [`h${String(i)}`, 1])),
          lost: 0,
        },
      },
    ];
    for (const value of bad) expect(parseNavigationEvidence(value)).toBeUndefined();
  });
});
