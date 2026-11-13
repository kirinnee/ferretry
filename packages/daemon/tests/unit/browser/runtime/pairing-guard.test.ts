import { describe, it } from 'bun:test';
import should from 'should';
import type {
  BrowserActGuard,
  BrowserGuardPage,
  BrowserPairingState,
} from '../../../../src/lib/browser/runtime/index.ts';
import { holdPairingScreen, underGuard } from '../../../../src/lib/browser/runtime/pairing-guard.ts';

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

describe('underGuard', () => {
  const page = pageShowing([]);

  it('should just run the work with no guard, or a guard that hands nothing back', async () => {
    should(await underGuard(undefined, page, async () => 1)).equal(1);
    const quiet: BrowserActGuard = async () => undefined;
    should(await underGuard(quiet, page, async () => 2)).equal(2);
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
