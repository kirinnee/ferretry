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
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import should from 'should';
import {
  createPairingRedirectPage,
  DesktopBrowserOpener,
  type ExitingProcess,
  holdProcessOpen,
  onProcessExit,
} from '../../../../cli/adapters/pair/browser-opener.ts';
import { PAIRING_REDIRECT_DIRECTORY_PREFIX, PairingRedirectsFile } from '../../../../contract/index.ts';
import { CODE, PAIR_URL } from './fixtures';

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

/** What the launcher was asked to run: its program and every argument, as the process table would show them. */
interface Launch {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: unknown;
}

/**
 * The shipped page store (`createPairingRedirectPage`) over the in-memory Access state, with a launcher that only
 * records. The page is therefore the real one the CLI writes — its directory, its name, its bytes — minus the disk.
 */
function launcherWorld(platform = 'linux') {
  const folder = new MemoryStateFolder();
  const state = folder.ownState([PairingRedirectsFile]);
  const launches: Launch[] = [];
  const errors: (() => void)[] = [];
  const timers: { readonly run: () => void; readonly ms: number }[] = [];
  const exits: (() => Promise<void>)[] = [];
  const opener = new DesktopBrowserOpener({
    platform,
    spawn: ((command: string, args: readonly string[], options: unknown) => {
      launches.push({ command, args, options });
      return {
        on: (event: string, listener: () => void) => {
          if (event === 'error') errors.push(listener);
        },
        unref: () => undefined,
      } as unknown as ChildProcess;
    }) as unknown as typeof spawn,
    stateHome: '/unused',
    createPage: page => createPairingRedirectPage(state, page),
    retentionMs: 10_000,
    schedule: (run, ms) => void timers.push({ run, ms }),
    onExit: run => void exits.push(run),
  });
  /** Every path the folder holds, files and directories: empty means nothing of the page is left. */
  const held = () => [...folder.bytes.keys(), ...folder.directories.keys()];
  return { folder, opener, launches, errors, timers, exits, held };
}

describe('DesktopBrowserOpener keeps the link out of every argument vector', () => {
  it('P103 uses each platform own launcher, with a path as the argument and never the link', async () => {
    for (const [platform, command] of [
      ['darwin', 'open'],
      ['linux', 'xdg-open'],
      ['freebsd', 'xdg-open'],
      ['openbsd', 'xdg-open'],
    ] as const) {
      const world = launcherWorld(platform);
      (await world.opener.open(PAIR_URL)).should.be.true();
      world.launches[0]?.command.should.equal(command);
      world.launches[0]?.args.should.have.length(1);
    }
    const windows = launcherWorld('win32');
    (await windows.opener.open(PAIR_URL)).should.be.true();
    windows.launches[0]?.command.should.equal('cmd');
    windows.launches[0]?.args.slice(0, 3).should.eql(['/c', 'start', '']);
  });

  it('P103 never gives the launcher an argument containing the code, the fragment or the link', async () => {
    // An argument is `/proc/<pid>/cmdline`, which every local user can read.
    for (const platform of ['darwin', 'linux', 'win32', 'freebsd']) {
      const world = launcherWorld(platform);
      await world.opener.open(PAIR_URL);
      for (const argument of [world.launches[0]?.command ?? '', ...(world.launches[0]?.args ?? [])]) {
        argument.should.not.containEql(CODE);
        argument.should.not.containEql('#v1');
        argument.should.not.containEql(PAIR_URL);
      }
    }
  });

  it('P103 writes the redirect page into a fresh private directory of the state tree, as an owner-only file', async () => {
    const world = launcherWorld();
    await world.opener.open(PAIR_URL);

    const [directory] = [...world.folder.directories.keys()];
    should(directory).startWith(`pairing-redirects/${PAIRING_REDIRECT_DIRECTORY_PREFIX}`);
    should(world.folder.directories.get(directory ?? '')?.mode).equal(0o700);
    // The file's declared mode is what the real store applies on creation; it is never wider than owner-only.
    should(PairingRedirectsFile.mode).equal(0o600);
    const file = world.launches[0]?.args[0] ?? '';
    file.should.containEql(directory?.replace('pairing-redirects/', '') ?? '?');
    // The code is held only inside the page, which is what carries it to the browser.
    const page = new TextDecoder().decode(world.folder.bytes.get(`${directory}/pairing.html`));
    page.should.containEql(CODE);
    page.should.containEql('location.replace(');
  });
});

describe('DesktopBrowserOpener removes the redirect page on a short life', () => {
  it('P104 removes the page once its short life is up, and never before', async () => {
    const world = launcherWorld();
    await world.opener.open(PAIR_URL);
    world.timers.should.have.length(1);
    world.timers[0]?.ms.should.equal(10_000);
    world.held().should.not.be.empty();

    world.timers[0]?.run();
    await drain();
    // The directory goes with the file, so nothing of the page is left in the state tree.
    world.held().should.be.empty();
  });

  it('P104 removes the page when the process exits first, and tolerates the timer firing afterwards', async () => {
    const world = launcherWorld();
    await world.opener.open(PAIR_URL);
    world.exits.should.have.length(1);
    await world.exits[0]?.();
    world.held().should.be.empty();
    should(() => world.timers[0]?.run()).not.throw();
    await drain();
    world.held().should.be.empty();
  });

  it('P104 removes the page at once when the launcher turns out not to exist', async () => {
    // A missing `xdg-open` fails asynchronously, after `open` has already answered.
    const world = launcherWorld();
    (await world.opener.open(PAIR_URL)).should.be.true();
    world.held().should.not.be.empty();
    world.errors[0]?.();
    await drain();
    world.held().should.be.empty();
  });

  it('P104 holds the process open until the page has had its seconds, then runs the removal', async () => {
    const ran = new Promise<void>(resolve => holdProcessOpen(resolve, 1));
    await ran;
  });
});
