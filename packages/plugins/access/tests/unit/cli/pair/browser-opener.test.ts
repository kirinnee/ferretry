/**
 * The state-backed redirect page's lifecycle, with every host edge faked: the page store, the launcher, the
 * timer and the process that is signalled. Nothing is launched, nothing touches the disk, no real process is
 * signalled or ended, and the link carries the fixtures' fake code.
 *
 * The page lives in the fenced state, whose removal is asynchronous. What is proved is the ORDER: a signal
 * must not end the process until that removal has finished, because a page left behind holds a live code.
 */

import { describe, it } from 'bun:test';
import type { ChildProcess, spawn } from 'node:child_process';
import should from 'should';
import {
  DesktopBrowserOpener,
  type ExitingProcess,
  onProcessExit,
} from '../../../../cli/adapters/pair/browser-opener.ts';
import { PAIR_URL } from './fixtures';

/** Lets every promise already queued settle, the way the event loop would between two events. */
const drain = () => new Promise(resolve => setTimeout(resolve, 0));

/** A page store whose removal the test finishes by hand, recording every step in one shared log. */
const pageStore = (log: string[]) => {
  let finish: (() => void) | undefined;
  let removals = 0;
  const createPage = async (_page: string) => ({
    file: '/fenced/fy-pair-ABCDEF/pairing.html',
    discard: () => {
      removals += 1;
      log.push('discard:start');
      return new Promise<void>(resolve => {
        finish = () => {
          log.push('discard:done');
          resolve();
        };
      });
    },
  });
  return { createPage, finish: () => finish?.(), removals: () => removals };
};

/** A process that records its listeners and its exits, and ends nothing. */
const fakeProcess = (log: string[]) => {
  const listeners = new Map<string, () => void>();
  const host: ExitingProcess = {
    once: (event, listener) => {
      listeners.set(event, listener);
    },
    exit: code => {
      log.push(`exit:${code}`);
      return undefined as never;
    },
  };
  return { host, listeners };
};

const quietSpawn = (() =>
  ({ on: () => undefined, unref: () => undefined }) as unknown as ChildProcess) as unknown as typeof spawn;

const openerWith = (log: string[], schedule: (run: () => void, ms: number) => void = () => undefined) => {
  const store = pageStore(log);
  const process = fakeProcess(log);
  const opener = new DesktopBrowserOpener({
    platform: 'linux',
    spawn: quietSpawn,
    stateHome: '/unused',
    createPage: store.createPage,
    retentionMs: 30_000,
    schedule,
    onExit: run => onProcessExit(process.host, run),
  });
  return { opener, store, process };
};

describe('DesktopBrowserOpener with a state-backed page', () => {
  it('P106 a signal during the redirect countdown removes the page before the process exits', async () => {
    const log: string[] = [];
    const { opener, store, process } = openerWith(log);
    (await opener.open(PAIR_URL)).should.be.true();

    process.listeners.get('SIGINT')?.();
    await drain();
    // The removal has started and the process is still alive, waiting on it.
    log.should.eql(['discard:start']);

    store.finish();
    await drain();
    log.should.eql(['discard:start', 'discard:done', 'exit:130']);
    // The `exit` event the real exit raises does not remove a second time.
    process.listeners.get('exit')?.();
    await drain();
    store.removals().should.equal(1);
  });

  it('P106 SIGTERM waits for the removal too, and exits with its own status', async () => {
    const log: string[] = [];
    const { opener, store, process } = openerWith(log);
    await opener.open(PAIR_URL);
    process.listeners.get('SIGTERM')?.();
    await drain();
    log.should.eql(['discard:start']);
    store.finish();
    await drain();
    log.should.eql(['discard:start', 'discard:done', 'exit:143']);
  });

  it('P106 a signal after the countdown already removed the page exits at once without removing again', async () => {
    const log: string[] = [];
    const timers: (() => void)[] = [];
    const { opener, store, process } = openerWith(log, run => timers.push(run));
    await opener.open(PAIR_URL);
    timers.should.have.length(1);
    timers[0]?.();
    store.finish();
    await drain();
    process.listeners.get('SIGINT')?.();
    await drain();
    log.should.eql(['discard:start', 'discard:done', 'exit:130']);
    store.removals().should.equal(1);
  });

  it('P106 a removal that fails still lets the signal end the process', async () => {
    const log: string[] = [];
    const process = fakeProcess(log);
    const opener = new DesktopBrowserOpener({
      platform: 'linux',
      spawn: quietSpawn,
      stateHome: '/unused',
      createPage: async () => ({
        file: '/fenced/fy-pair-ABCDEF/pairing.html',
        discard: async () => {
          throw new Error('state refused the removal');
        },
      }),
      retentionMs: 30_000,
      schedule: () => undefined,
      onExit: run => onProcessExit(process.host, run),
    });
    await opener.open(PAIR_URL);
    process.listeners.get('SIGINT')?.();
    await drain();
    log.should.eql(['exit:130']);
  });

  it('P106 a launcher that cannot start removes the page before open answers false', async () => {
    const log: string[] = [];
    const store = pageStore(log);
    const opener = new DesktopBrowserOpener({
      platform: 'linux',
      spawn: (() => {
        throw new Error('spawn xdg-open ENOENT');
      }) as unknown as typeof spawn,
      stateHome: '/unused',
      createPage: store.createPage,
      retentionMs: 30_000,
      schedule: () => undefined,
      onExit: () => undefined,
    });
    let answered: boolean | undefined;
    const opening = opener.open(PAIR_URL).then(result => {
      answered = result;
    });
    await drain();
    should(answered).be.undefined();
    store.finish();
    await opening;
    should(answered).be.false();
    log.should.eql(['discard:start', 'discard:done']);
  });
});
