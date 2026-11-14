import { describe, it } from 'bun:test';
import should from 'should';
import type {
  BrowserActGuard,
  BrowserGuardPage,
  BrowserPairingEvidence,
  BrowserPairingState,
} from '../../../../src/lib/browser/runtime/index.ts';
import {
  appOriginSet,
  holdPairingScreen,
  pairingEvidenceOf,
  underGuard,
} from '../../../../src/lib/browser/runtime/pairing-guard.ts';

const refusal = () => new Error('hidden');

const pageShowing = (states: readonly (BrowserPairingState | Error)[]): BrowserGuardPage => {
  const queue = [...states];
  return {
    document: async () => 'loader-1',
    pairing: async () => {
      const next = queue.shift() ?? { marked: false, epochs: {} };
      if (next instanceof Error) throw next;
      return next;
    },
  };
};

const ordinary: BrowserPairingState = { marked: false, epochs: { p1: 2 } };
const marked: BrowserPairingState = { marked: true, epochs: { p1: 3 } };

/** What the daemon and the worker say of an app page nothing has happened to. */
const quiet: BrowserPairingEvidence = { app: true, live: false, minted: 1, commits: 0, linked: false };
const withEvidence = (evidence: Partial<BrowserPairingEvidence>, base = ordinary): BrowserPairingState => ({
  ...base,
  evidence: { ...quiet, ...evidence },
});

const outcome = async (work: Promise<unknown>): Promise<unknown> =>
  await work.then(
    value => value,
    (error: unknown) => error,
  );

describe('holdPairingScreen', () => {
  it('should refuse at once while a pairing document is marked', async () => {
    should(await outcome(holdPairingScreen(pageShowing([marked]), refusal))).be.instanceOf(Error);
  });

  it('should refuse a page that cannot say what it shows, whether it has no way to or the way fails', async () => {
    const mute: BrowserGuardPage = { document: async () => 'loader-1' };

    should(await outcome(holdPairingScreen(mute, refusal))).be.instanceOf(Error);
    should(await outcome(holdPairingScreen(pageShowing([new Error('gone')]), refusal))).be.instanceOf(Error);
  });

  it('should refuse a page that does not answer in time, at either look', async () => {
    const silent: BrowserGuardPage = {
      document: async () => 'loader-1',
      pairing: async () => await new Promise(() => {}),
    };
    const slowAfter: BrowserGuardPage = {
      document: async () => 'loader-1',
      pairing: (() => {
        let looks = 0;
        return async () => {
          looks += 1;
          return looks === 1 ? ordinary : await new Promise<BrowserPairingState>(() => {});
        };
      })(),
    };

    should(await outcome(holdPairingScreen(silent, refusal, { lookMs: 5 }))).be.instanceOf(Error);
    const check = await holdPairingScreen(slowAfter, refusal, { lookMs: 5 });
    should(await outcome(check())).be.instanceOf(Error);
  });

  it('should hand back a check that passes while nothing was shown, and refuses a code shown, gone, or unreadable after', async () => {
    const check = await holdPairingScreen(pageShowing([ordinary, ordinary]), refusal);
    should(await outcome(check())).be.undefined();

    const shown = await holdPairingScreen(pageShowing([ordinary, marked]), refusal);
    should(await outcome(shown())).be.instanceOf(Error);

    const wentAgain = await holdPairingScreen(pageShowing([ordinary, { marked: false, epochs: { p1: 3 } }]), refusal);
    should(await outcome(wentAgain())).be.instanceOf(Error);

    const unreadable = await holdPairingScreen(pageShowing([ordinary, new Error('gone')]), refusal);
    should(await outcome(unreadable())).be.instanceOf(Error);
  });

  it('should refuse a page that came in meanwhile with a code behind it, and let one that never showed one be', async () => {
    const opened = await holdPairingScreen(
      pageShowing([ordinary, { marked: false, epochs: { p1: 2, p2: 1 } }]),
      refusal,
    );
    should(await outcome(opened())).be.instanceOf(Error);

    const clean = await holdPairingScreen(
      pageShowing([ordinary, { marked: false, epochs: { p1: 2, p2: 0 } }]),
      refusal,
    );
    should(await outcome(clean())).be.undefined();
  });
});

describe('holdPairingScreen — the evidence outside the page', () => {
  it('should refuse an app page while a code is live, with no marker and no counter on it', async () => {
    // Arrange — a script erased the marker and the counter; the daemon still knows a code is live
    const erased = withEvidence({ live: true }, { marked: false, epochs: {} });

    // Act / Assert
    should(await outcome(holdPairingScreen(pageShowing([erased]), refusal))).be.instanceOf(Error);
  });

  it('should leave a page that is not the app’s alone, whatever the daemon and the browser say of codes', async () => {
    // Arrange — a live code, a code minted in between and a link opened elsewhere
    const elsewhere = (evidence: Partial<BrowserPairingEvidence>) => withEvidence({ app: false, ...evidence });
    const check = await holdPairingScreen(
      pageShowing([elsewhere({ live: true }), elsewhere({ live: true, minted: 5, commits: 3, linked: true })]),
      refusal,
      { script: true },
    );

    // Assert
    should(await outcome(check())).be.undefined();
  });

  it('should refuse a page whose document a pairing link opened, with no code live', async () => {
    should(await outcome(holdPairingScreen(pageShowing([withEvidence({ linked: true })]), refusal))).be.instanceOf(
      Error,
    );
  });

  it('should refuse a script, and only a script, on an app page once a pairing link was opened on an app origin anywhere', async () => {
    const afterALink = withEvidence({ commits: 1 });

    should(await outcome(holdPairingScreen(pageShowing([afterALink]), refusal, { script: true }))).be.instanceOf(Error);
    const read = await holdPairingScreen(pageShowing([afterALink, afterALink]), refusal);
    should(await outcome(read())).be.undefined();
  });

  it('should refuse a read that spans a navigation: the new document has no marker and no counter, but a link was opened', async () => {
    // Arrange — the counter and the marker are back to nothing, as a navigation leaves them
    const before = withEvidence({ commits: 0 });
    const after = withEvidence({ commits: 1 }, { marked: false, epochs: {} });
    const check = await holdPairingScreen(pageShowing([before, after]), refusal);

    // Act / Assert
    should(await outcome(check())).be.instanceOf(Error);
  });

  it('should refuse an operation a mint overlapped, though no code was live at either look', async () => {
    // Arrange — minted and redeemed (or expired) in between
    const check = await holdPairingScreen(
      pageShowing([withEvidence({ minted: 1 }), withEvidence({ minted: 2 })]),
      refusal,
    );

    // Act / Assert
    should(await outcome(check())).be.instanceOf(Error);
  });

  it('should refuse when the page moved to an app origin while the operation ran and a code was minted meanwhile', async () => {
    const check = await holdPairingScreen(
      pageShowing([withEvidence({ app: false, minted: 1 }), withEvidence({ app: true, minted: 2 })]),
      refusal,
    );

    should(await outcome(check())).be.instanceOf(Error);
  });

  it('should refuse when a code is live at the second look only, and answer when the evidence did not move', async () => {
    const live = await holdPairingScreen(pageShowing([withEvidence({}), withEvidence({ live: true })]), refusal);
    should(await outcome(live())).be.instanceOf(Error);

    const same = await holdPairingScreen(pageShowing([withEvidence({}), withEvidence({})]), refusal);
    should(await outcome(same())).be.undefined();
  });

  it('should put the refusal in place of the answer and of the error of an operation a mint overlapped', async () => {
    const guard: BrowserActGuard = async guarded => await holdPairingScreen(guarded, refusal);
    const states = () => pageShowing([withEvidence({ minted: 1 }), withEvidence({ minted: 2 })]);

    const answered = await outcome(underGuard(guard, states(), async () => 'the code'));
    const failed = await outcome(underGuard(guard, states(), async () => Promise.reject(new Error('the code'))));

    should((answered as Error).message).equal('hidden');
    should((failed as Error).message).equal('hidden');
  });
});

describe('pairingEvidenceOf', () => {
  const apps = appOriginSet(['https://ferretry.pages.dev', 'http://127.0.0.1:4000']);
  const live = { live: true, minted: 4 };

  it('should say whether any page the script could reach is the app’s, counting an origin nobody could tell as the app’s', () => {
    should(pairingEvidenceOf({ pairingOrigins: ['https://example.test'] }, live, apps).app).be.false();
    should(
      pairingEvidenceOf({ pairingOrigins: ['https://example.test', 'https://ferretry.pages.dev'] }, live, apps).app,
    ).be.true();
    should(pairingEvidenceOf({ pairingOrigins: ['https://example.test', ''] }, live, apps).app).be.true();
    should(pairingEvidenceOf({ pairingOrigins: ['*'] }, live, apps).app).be.true();
    should(pairingEvidenceOf({}, live, apps).app).be.true();
  });

  it('should add up only the pairing links opened on an app origin, and carry the daemon’s own count of codes', () => {
    const evidence = pairingEvidenceOf(
      {
        pairingOrigins: ['https://ferretry.pages.dev'],
        pairingCommits: { 'https://ferretry.pages.dev': 2, 'https://example.test': 9, '': 1, '*': 4 },
        pairingLinked: true,
      },
      live,
      apps,
    );

    should(evidence).eql({ app: true, live: true, minted: 4, commits: 7, linked: true });
  });
});

describe('appOriginSet', () => {
  it('should hold each origin in its canonical form, and every spelling of loopback on a loopback one’s port', () => {
    const apps = appOriginSet(['https://ferretry.pages.dev/', 'http://127.0.0.1:4000', 'not an origin']);

    should([...apps].sort()).eql([
      'http://127.0.0.1:4000',
      'http://[::1]:4000',
      'http://localhost:4000',
      'https://ferretry.pages.dev',
    ]);
  });

  it('should not widen a public host to loopback', () => {
    should(appOriginSet(['https://example.test:8443']).has('https://localhost:8443')).be.false();
  });
});

describe('underGuard', () => {
  const page = pageShowing([]);

  it('should just run the work with no guard, or a guard that hands nothing back', async () => {
    should(await underGuard(undefined, page, async () => 1)).equal(1);
    const quiet2: BrowserActGuard = async () => undefined;
    should(await underGuard(quiet2, page, async () => 2)).equal(2);
  });

  it('should let the work’s own error through when the check finds nothing to refuse', async () => {
    const guard: BrowserActGuard = async guarded => await holdPairingScreen(guarded, refusal);
    const failure = new Error('the page crashed');

    should(
      await outcome(underGuard(guard, pageShowing([ordinary, ordinary]), async () => Promise.reject(failure))),
    ).equal(failure);
  });

  it('should put the refusal in place of the work’s error or answer', async () => {
    const guard: BrowserActGuard = async guarded => await holdPairingScreen(guarded, refusal);

    const answered = await outcome(underGuard(guard, pageShowing([ordinary, marked]), async () => 'the code'));
    const failed = await outcome(
      underGuard(guard, pageShowing([ordinary, marked]), async () => Promise.reject(new Error('the code'))),
    );

    should((answered as Error).message).equal('hidden');
    should((failed as Error).message).equal('hidden');
  });
});
