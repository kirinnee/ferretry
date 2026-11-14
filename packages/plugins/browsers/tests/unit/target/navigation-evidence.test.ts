import { describe, expect, test } from 'bun:test';
import {
  carriesCredentialFragment,
  MAX_COMMITTED_ORIGINS,
  NavigationLedger,
  type NavigationSource,
  originOf,
  parseNavigationEvidence,
} from '../../../daemon/target/lib/navigation-evidence.ts';

/**
 * WHERE A PAGE HAS BEEN, as the browser's own frame events say it (docs/pairing.md, "Never show it to an agent"): kept by
 * the worker, believed by the daemon only in its exact shape.
 */
function source(tree: unknown, options: { readonly failTree?: boolean } = {}) {
  const listeners = new Map<string, (params: never) => void>();
  const sent: string[] = [];
  const session: NavigationSource = {
    on: (event, listener) => {
      listeners.set(event, listener);
    },
    send: async method => {
      sent.push(method);
      if (method === 'Page.getFrameTree') {
        if (options.failTree === true) throw new Error('the page is gone');
        return { frameTree: tree };
      }
      return {};
    },
  };
  const emit = (event: string, params: unknown): void => listeners.get(event)?.(params as never);
  return { session, emit, sent };
}

const frame = (id: string, url: string, extra: Record<string, unknown> = {}) => ({ id, url, ...extra });

describe('the navigation ledger', () => {
  test('it seeds from the frame tree: the main frame and every child, with their origins', async () => {
    const clock = { at: 100 };
    const ledger = new NavigationLedger(() => clock.at);
    const { session } = source({
      frame: frame('main', 'https://docs.example.test/a'),
      childFrames: [{ frame: frame('kid', 'https://app.example.test/x', { parentId: 'main' }) }],
    });

    await ledger.attach(session);
    const evidence = ledger.evidence();

    expect(evidence.frames).toEqual(['https://docs.example.test', 'https://app.example.test']);
    expect(evidence.origins.map(entry => entry.origin)).toEqual([
      'https://docs.example.test',
      'https://app.example.test',
    ]);
    expect(evidence.watchedSince).toBe(100);
    expect(evidence.taintSeq).toBe(0);
    expect(evidence.overflow).toBe(false);
  });

  test('every navigation, in-document move, attach and detach moves the count, and the history survives the frame', async () => {
    const ledger = new NavigationLedger(() => 5);
    const { session, emit } = source({ frame: frame('main', 'https://docs.example.test/') });
    await ledger.attach(session);
    const seeded = ledger.evidence().seq;

    emit('Page.frameAttached', { frameId: 'kid' });
    emit('Page.frameNavigated', { frame: frame('kid', 'https://app.example.test/pair', { parentId: 'main' }) });
    emit('Page.frameDetached', { frameId: 'kid' });
    emit('Page.navigatedWithinDocument', { frameId: 'main', url: 'https://docs.example.test/#x' });
    const evidence = ledger.evidence();

    expect(evidence.seq).toBe(seeded + 4);
    // the frame that held the app is gone; the ledger still says the target had it
    expect(evidence.frames).toEqual(['https://docs.example.test']);
    expect(evidence.origins.find(entry => entry.origin === 'https://app.example.test')?.lastSeq).toBe(seeded + 2);
  });

  test('a committed address carrying the pairing grammar taints the target for life, even after it is replaced', async () => {
    const ledger = new NavigationLedger(() => 5);
    const { session, emit } = source({ frame: frame('main', 'https://docs.example.test/') });
    await ledger.attach(session);

    emit('Page.frameNavigated', {
      frame: frame('main', 'https://app.example.test/pair', { urlFragment: '#v1;url=x;code=FAKE-PAIR-0000' }),
    });
    const tainted = ledger.evidence().taintSeq;
    emit('Page.navigatedWithinDocument', { frameId: 'main', url: 'https://app.example.test/pair' });
    emit('Page.frameNavigated', { frame: frame('main', 'https://docs.example.test/') });

    expect(tainted).toBeGreaterThan(0);
    expect(ledger.evidence().taintSeq).toBe(tainted);
  });

  test('a page that cannot be seeded is a ledger that says it cannot tell where the page is', async () => {
    const ledger = new NavigationLedger(() => 5);

    await ledger.attach(source({}, { failTree: true }).session);

    expect(ledger.evidence().origins.map(entry => entry.origin)).toEqual(['?']);
  });

  test('it forgets nothing silently: more origins than it keeps is an overflow, and the first are still there', () => {
    const ledger = new NavigationLedger(() => 5);
    for (let index = 0; index <= MAX_COMMITTED_ORIGINS; index++)
      ledger.commit('main', `https://h${String(index)}.example.test/`);

    const evidence = ledger.evidence();

    expect(evidence.overflow).toBe(true);
    expect(evidence.origins).toHaveLength(MAX_COMMITTED_ORIGINS);
    expect(evidence.origins[0]?.origin).toBe('https://h0.example.test');
  });

  test('an address nobody can read has the origin `?`, and an opaque one `null`', () => {
    expect(originOf('not a url')).toBe('?');
    expect(originOf('about:blank')).toBe('null');
    expect(originOf('https://a.example.test:8443/x')).toBe('https://a.example.test:8443');
  });
});

describe('the credential-fragment test the worker keeps', () => {
  test('it reads the pairing grammar and the credential parts, however they are spelled', () => {
    for (const fragment of [
      '#v1;url=x',
      '#v1',
      '#V1;url=x',
      '#%76%31;url=x',
      '#v1 ;url=x',
      '#a=1;code=FAKE-PAIR-0000',
      '#share=fy_share_x',
      '#c=1',
      '#%2523v1;x',
    ])
      expect(carriesCredentialFragment(fragment)).toBe(true);
  });

  test('it leaves an ordinary anchor alone', () => {
    for (const fragment of ['', '#', '#section-2', '#v10', '#version', '#top'])
      expect(carriesCredentialFragment(fragment)).toBe(false);
  });
});

describe('the daemon’s belief in the worker’s navigation evidence', () => {
  const good = {
    seq: 3,
    origins: [{ origin: 'https://app.example.test', firstAt: 10, lastSeq: 3 }],
    overflow: false,
    frames: ['https://app.example.test'],
    taintSeq: 0,
    watchedSince: 5,
  };

  test('it believes the exact shape', () => {
    expect(parseNavigationEvidence(good)).toEqual(good);
  });

  test('it believes nothing else: wrong types, extra members, absent members, impossible numbers', () => {
    const bad: unknown[] = [
      undefined,
      null,
      'x',
      {},
      { ...good, seq: -1 },
      { ...good, seq: 1.5 },
      { ...good, seq: Number.NaN },
      { ...good, seq: '3' },
      { ...good, overflow: 'no' },
      { ...good, taintSeq: 9 },
      { ...good, watchedSince: Number.POSITIVE_INFINITY },
      { ...good, frames: 'x' },
      { ...good, frames: [1] },
      { ...good, frames: [''] },
      { ...good, extra: 1 },
      { ...good, origins: [{ origin: 'https://a', firstAt: 1, lastSeq: 9 }] },
      { ...good, origins: [{ origin: 'https://a', firstAt: 1, lastSeq: 1, more: true }] },
      { ...good, origins: [{ origin: '', firstAt: 1, lastSeq: 1 }] },
      {
        ...good,
        origins: [
          { origin: 'https://a', firstAt: 1, lastSeq: 1 },
          { origin: 'https://a', firstAt: 1, lastSeq: 1 },
        ],
      },
      {
        ...good,
        origins: Array.from({ length: MAX_COMMITTED_ORIGINS + 1 }, (_, index) => ({
          origin: `https://h${String(index)}`,
          firstAt: 1,
          lastSeq: 1,
        })),
      },
      { seq: 1 },
    ];
    for (const value of bad) expect(parseNavigationEvidence(value)).toBeUndefined();
  });
});
