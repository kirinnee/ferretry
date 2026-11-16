import { describe, it } from 'bun:test';
import type { FerretId } from '@ferretry/kernel/contract';
import should from 'should';
import type { BrowserCopyPort } from '../../../daemon/pages/copy-contracts.ts';
import { SealedGate } from '../../../daemon/sealed/gate.ts';
import { SealedPages } from '../../../daemon/sealed/page-guards.ts';
import { secureCopyReach } from '../../../daemon/sealed/reach.ts';

/**
 * Secure copy's clipboard capture, as Browsers' reach runs it (findings 2 and 8 of the secure-clip-2 fix round 1): a clipboard
 * that could not be confirmed empty keeps its page closed and the keyboard paste refused until a retry empties it, and a
 * capture waits for a script that was already running. The page service and the tools are stand-ins; the reach, the gate and
 * the registry are the real ones. Never a real credential.
 */
const SENTINEL = 'FAKE-SC-7f3a91';
const FERRET = 'f1' as FerretId;
const SOURCE = 'https://keys.example.test';
const FOUND = {
  ok: true as const,
  value: SENTINEL,
  origin: SOURCE,
  frameOrigin: SOURCE,
  navigationId: 'loader-1',
};

const TIMERS = {
  after: (ms: number, action: () => void) => {
    const handle = setTimeout(action, ms);
    return () => clearTimeout(handle);
  },
};

function world(read: Awaited<ReturnType<BrowserCopyPort['copyClipboard']>> = FOUND) {
  const sealed = new SealedPages(TIMERS);
  const gate = new SealedGate({ sealed, mask: async text => text });
  const state = { read, clears: [] as boolean[], clearAnswer: false, capturingSeen: [] as boolean[] };
  const pages = {
    copyOnPage: async (
      _ferret: string,
      _key: string,
      { work }: { work: (copy: BrowserCopyPort, pageId: string) => Promise<unknown> },
    ) =>
      await work(
        {
          copyClipboard: async () => {
            state.capturingSeen.push(sealed.isCapturing());
            return state.read;
          },
        } as unknown as BrowserCopyPort,
        'p1',
      ),
    clearClipboard: async () => {
      state.clears.push(state.clearAnswer);
      return state.clearAnswer;
    },
  };
  const tools = {
    copyPageFor: async () => ({ surface: { id: 'p1', name: 'keys' }, guard: async () => undefined }),
    isTakenOver: async () => false,
    addressOf: async () => `${SOURCE}/new`,
  };
  const reach = secureCopyReach({ tools: tools as never, pages: pages as never, gate, scriptWaitMs: 20 });
  return { reach, sealed, gate, state };
}

const queue = { seal: () => undefined };

describe('FINDING 2: a clipboard that could not be emptied is not an ordinary success', () => {
  it('should keep the capture’s page closed and the keyboard paste refused after a read that worked but was not emptied', async () => {
    const { reach, sealed, gate } = world({ ...FOUND, kept: true });

    const answer = await reach.clipboardRead(FERRET, 'keys', queue);

    should(answer.ok).equal(true);
    should(sealed.clipboardKept()).equal(true);
    should(sealed.covering('f2', 'keys.example.test')).have.length(1);
    const refused = await gate
      .check({ ferret: 'f2', tool: 'browser.press', reference: '%browser:x', keys: ['Control+V'] })
      .then(
        () => 'passed',
        (error: Error) => error.message,
      );
    should(refused).containEql('keyboard paste is refused');
  });

  it('should keep it for a read that found nothing, or failed, when the clipboard was not emptied either', async () => {
    for (const read of [
      { ok: false as const, reason: 'empty' as const, kept: true as const },
      { ok: false as const, reason: 'changed' as const, kept: true as const },
    ]) {
      const { reach, sealed } = world(read);

      const answer = await reach.clipboardRead(FERRET, 'keys', queue);

      should(answer.ok).equal(false);
      should(sealed.clipboardKept()).equal(true);
    }
  });

  it('should keep nothing when the clear was confirmed, and end the keeping the moment a retry confirms it', async () => {
    const clean = world(FOUND);
    await clean.reach.clipboardRead(FERRET, 'keys', queue);
    const dirty = world({ ...FOUND, kept: true });
    await dirty.reach.clipboardRead(FERRET, 'keys', queue);

    const stillKept = await dirty.sealed.retryClipboard();
    dirty.state.clearAnswer = true;
    const cleared = await dirty.sealed.retryClipboard();

    should(clean.sealed.clipboardKept()).equal(false);
    should(stillKept).equal(false);
    should(cleared).equal(true);
    should(dirty.sealed.clipboardKept()).equal(false);
    should(dirty.state.clears).eql([false, true]);
    should(dirty.sealed.covering('f2', 'keys.example.test')).eql([]);
  });
});

describe('FINDING 8: a capture waits for a script that was already running, and runs no script of its own meanwhile', () => {
  it('should refuse the capture, reading nothing, when a script is still running after the wait', async () => {
    const { reach, sealed, state } = world();
    const ended = sealed.scriptRunning();

    const answer = await reach.clipboardRead(FERRET, 'keys', queue);
    ended();

    should(answer).match({ ok: false, reason: 'refused', code: 'unavailable' });
    should((answer as { message: string }).message).containEql('A page script was still running');
    should(state.capturingSeen).eql([]);
    should(sealed.isCapturing()).equal(false);
  });

  it('should go ahead once the running script finishes inside the wait, with the capture flag up while it reads', async () => {
    const { reach, sealed, state } = world();
    const ended = sealed.scriptRunning();
    setTimeout(ended, 5);

    const answer = await reach.clipboardRead(FERRET, 'keys', queue);

    should(answer.ok).equal(true);
    should(state.capturingSeen).eql([true]);
    should(sealed.isCapturing()).equal(false);
  });

  it('should raise the capture flag BEFORE it waits, so a script that begins meanwhile is refused by the gate', async () => {
    const { reach, sealed, gate } = world();
    const ended = sealed.scriptRunning();
    const capture = reach.clipboardRead(FERRET, 'keys', queue);
    await Promise.resolve();

    const refused = await gate
      .check({ ferret: 'f1', tool: 'browser.eval', reference: '%browser:a', address: 'https://a.test/' })
      .then(
        () => 'passed',
        (error: Error) => error.message,
      );
    ended();
    await capture;

    should(refused).containEql('clipboard capture is running');
  });
});
