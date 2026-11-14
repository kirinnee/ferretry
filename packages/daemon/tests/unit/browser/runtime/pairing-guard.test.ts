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
const quiet: BrowserPairingEvidence = {
  app: true,
  ownApp: true,
  live: false,
  minted: 1,
  commits: 0,
  lost: 0,
  linked: false,
  blind: false,
};
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
    // Arrange — a live code, a code minted in between and a history that lost its way
    const elsewhere = (evidence: Partial<BrowserPairingEvidence>) =>
      withEvidence({ app: false, ownApp: false, ...evidence });
    const check = await holdPairingScreen(
      pageShowing([elsewhere({ live: true }), elsewhere({ live: true, minted: 5, blind: true })]),
      refusal,
      { script: true },
    );

    // Assert
    should(await outcome(check())).be.undefined();
  });

  it('should refuse a page whose document a pairing link opened on ANY origin, one the daemon does not know too', async () => {
    const elsewhere = withEvidence({ app: false, ownApp: false, linked: true });

    should(await outcome(holdPairingScreen(pageShowing([elsewhere]), refusal))).be.instanceOf(Error);
    // ...and one that was entered by a link only once the operation ran
    const check = await holdPairingScreen(
      pageShowing([withEvidence({ app: false, ownApp: false }), elsewhere]),
      refusal,
    );
    should(await outcome(check())).be.instanceOf(Error);
  });

  it('should leave a page alone that no link opened, whatever its origin: a card, a dialog, a step-up sets nothing', async () => {
    const cases = [
      withEvidence({ app: false, ownApp: false }),
      withEvidence({ app: true, ownApp: true }),
      withEvidence({ app: false, ownApp: false, blind: true }),
    ];

    for (const state of cases) {
      const check = await holdPairingScreen(pageShowing([state, state]), refusal);
      should(await outcome(check())).be.undefined();
    }
  });

  it('should refuse a blind history on an app page only: it cannot prove no link was opened, but only the app’s pages are at risk', async () => {
    should(await outcome(holdPairingScreen(pageShowing([withEvidence({ blind: true })]), refusal))).be.instanceOf(
      Error,
    );
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

describe('holdPairingScreen — r3: what moved, wherever the operation started and ended', () => {
  it('should refuse an operation whose endpoints are both outside the app when an app pairing link committed in between', async () => {
    // Arrange — outside -> app -> outside: the captured bytes survive the departure
    const outside = (commits: number) => withEvidence({ app: false, ownApp: false, commits });
    const check = await holdPairingScreen(pageShowing([outside(0), outside(1)]), refusal);

    // Act / Assert
    should(await outcome(check())).be.instanceOf(Error);
  });

  it('should discard the answer and the error of such an operation, and let one with no commit be', async () => {
    const guard: BrowserActGuard = async guarded => await holdPairingScreen(guarded, refusal);
    const outside = (commits: number) => withEvidence({ app: false, ownApp: false, commits });

    const answered = await outcome(underGuard(guard, pageShowing([outside(0), outside(2)]), async () => 'the code'));
    const failed = await outcome(
      underGuard(guard, pageShowing([outside(0), outside(2)]), async () => Promise.reject(new Error('the code'))),
    );
    const quietly = await outcome(underGuard(guard, pageShowing([outside(3), outside(3)]), async () => 'fine'));

    should((answered as Error).message).equal('hidden');
    should((failed as Error).message).equal('hidden');
    should(quietly).equal('fine');
  });

  it('should refuse an operation the ledger lost track during, wherever it started and ended, and ignore a loss before it', async () => {
    const outside = (lost: number) => withEvidence({ app: false, ownApp: false, lost });

    const during = await holdPairingScreen(pageShowing([outside(0), outside(1)]), refusal);
    const before = await holdPairingScreen(pageShowing([outside(1), outside(1)]), refusal);

    should(await outcome(during())).be.instanceOf(Error);
    should(await outcome(before())).be.undefined();
  });
});

describe('holdPairingScreen — r3: agent script on a Ferretry app origin', () => {
  const scriptRefusal = () => new Error('eval is not available on Ferretry’s own app pages');

  it('should always refuse a script on an app origin, with nothing live, nothing linked and nothing counted', async () => {
    // Arrange — the quietest app page there is
    const check = holdPairingScreen(pageShowing([withEvidence({})]), refusal, { script: true, scriptRefusal });

    // Act
    const error = (await outcome(check)) as Error;

    // Assert
    should(error.message).equal('eval is not available on Ferretry’s own app pages');
  });

  it('should refuse a script that ended up on an app origin though it began outside, and the answer with it', async () => {
    const outside = withEvidence({ app: false, ownApp: false });
    const check = await holdPairingScreen(pageShowing([outside, withEvidence({})]), refusal, {
      script: true,
      scriptRefusal,
    });

    should(((await outcome(check())) as Error).message).equal('eval is not available on Ferretry’s own app pages');
  });

  it('should leave a script on a page that is not an app origin alone, blank pages included', async () => {
    const elsewhere = withEvidence({ app: false, ownApp: false });
    const blank = withEvidence({ app: true, ownApp: false });

    for (const page of [elsewhere, blank]) {
      const check = await holdPairingScreen(pageShowing([page, page]), refusal, { script: true, scriptRefusal });
      should(await outcome(check())).be.undefined();
    }
  });

  it('should keep reading an app page that is quiet: the refusal is for scripts only', async () => {
    const check = await holdPairingScreen(pageShowing([withEvidence({}), withEvidence({})]), refusal);

    should(await outcome(check())).be.undefined();
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

  it('should keep a link and a blind history apart: a link says so on any origin, a blind history only on the app’s', () => {
    const linked = pairingEvidenceOf({ pairingOrigins: ['https://example.test'], pairingLinked: true }, live, apps);
    const blind = pairingEvidenceOf({ pairingOrigins: ['https://example.test'], pairingBlind: true }, live, apps);

    should([linked.app, linked.linked, linked.blind]).eql([false, true, false]);
    should([blind.app, blind.linked, blind.blind]).eql([false, false, true]);
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

    should(evidence).eql({
      app: true,
      ownApp: true,
      live: true,
      minted: 4,
      commits: 7,
      lost: 0,
      linked: true,
      blind: false,
    });
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

  it('should serve the loopback spellings of a wildcard bind, whatever else is configured', () => {
    // Arrange — the documented wildcard bind with a public address and a custom CORS list
    const apps = appOriginSet(['http://0.0.0.0:4000', 'https://daemon.example.test', 'https://custom.example.test']);

    // Assert
    for (const origin of ['http://127.0.0.1:4000', 'http://localhost:4000', 'http://[::1]:4000'])
      should(apps.has(origin)).be.true();
    should(appOriginSet(['http://[::]:4000']).has('http://127.0.0.1:4000')).be.true();
    should(apps.has('https://daemon.example.test')).be.true();
    should(apps.has('http://127.0.0.1:5000')).be.false();
  });

  it('should always hold the hosted app, even when the configured origins name another', () => {
    should(appOriginSet(['https://daemon.example.test']).has('https://ferretry.pages.dev')).be.true();
    should(appOriginSet([]).has('https://ferretry.pages.dev')).be.true();
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
