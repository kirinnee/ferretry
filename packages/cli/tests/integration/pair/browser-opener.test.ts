/**
 * Handing a pairing link to the desktop, without ever launching one — and without the link ever
 * reaching an argument vector.
 *
 * `spawn` is injected for exactly that reason: a suite that opened a real browser would be a suite that
 * opens a browser on a build machine. What is asserted is the argument vector. The launcher must be
 * given the PATH of a private page and never the link, because an argument is world-readable on a
 * shared host and the link's fragment is a live pairing code. The page itself is real, in a temporary
 * state home, so its mode, its directory and its removal are observed rather than assumed.
 */

import { afterEach, beforeEach, describe, it } from 'bun:test';
import type { ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';

import {
  DesktopBrowserOpener,
  desktopBrowserOpener,
  type ExitingProcess,
  holdProcessOpen,
  onProcessExit,
} from '../../../src/adapters/pair/browser-opener';

const CODE = '7F3K-Q2ND';
const URL = `https://ferretry.example.invalid/pair#v1;u;f;code=${CODE}`;

interface Launch {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: unknown;
}

/** The fake child's `error` listeners, so a test can fail the launcher the way a missing `xdg-open` does. */
type ErrorListener = () => void;

/** A `spawn` that records instead of launching, and answers a child that does nothing. */
const recordingSpawn = (launches: Launch[], failure?: Error, errors: ErrorListener[] = []): typeof spawn => {
  const fake = (command: string, args: readonly string[], options: unknown): ChildProcess => {
    if (failure !== undefined) throw failure;
    launches.push({ command, args, options });
    return {
      on: (event: string, listener: ErrorListener) => {
        if (event === 'error') errors.push(listener);
      },
      unref: () => undefined,
    } as unknown as ChildProcess;
  };
  return fake as unknown as typeof spawn;
};

let stateHome: string;
let timers: { readonly run: () => void; readonly ms: number }[];
let exits: (() => void)[];

beforeEach(() => {
  stateHome = mkdtempSync(join(tmpdir(), 'fy-pair-opener-'));
  timers = [];
  exits = [];
});

afterEach(() => {
  rmSync(stateHome, { recursive: true, force: true });
});

const openerOn = (platform: string, launches: Launch[], failure?: Error, errors?: ErrorListener[]) =>
  new DesktopBrowserOpener({
    platform,
    spawn: recordingSpawn(launches, failure, errors),
    stateHome,
    retentionMs: 10_000,
    schedule: (run, ms) => {
      timers.push({ run, ms });
    },
    onExit: run => {
      exits.push(run);
    },
  });

const openOn = async (platform: string, launches: Launch[] = [], failure?: Error): Promise<boolean> =>
  await openerOn(platform, launches, failure).open(URL);

/** What the state home holds right now — the proof a page is, or is no longer, on disk. */
const leftovers = (): readonly string[] => readdirSync(stateHome);

describe('DesktopBrowserOpener', () => {
  it('uses each platform own launcher, with a path as the argument and never the link', async () => {
    const mac: Launch[] = [];
    (await openOn('darwin', mac)).should.be.true();
    mac[0]?.command.should.equal('open');
    mac[0]?.args.should.have.length(1);

    const linux: Launch[] = [];
    (await openOn('linux', linux)).should.be.true();
    linux[0]?.command.should.equal('xdg-open');
    linux[0]?.args.should.have.length(1);

    // The BSDs run the same freedesktop handler.
    for (const platform of ['freebsd', 'openbsd']) {
      const bsd: Launch[] = [];
      (await openOn(platform, bsd)).should.be.true();
      bsd[0]?.command.should.equal('xdg-open');
    }
  });

  it('never gives the launcher an argument containing the code, the fragment or the link', async () => {
    // The whole point: an argument is `/proc/<pid>/cmdline`, which every local user can read.
    for (const platform of ['darwin', 'linux', 'win32', 'freebsd']) {
      const launches: Launch[] = [];
      await openOn(platform, launches);
      for (const argument of launches[0]?.args ?? []) {
        argument.should.not.containEql(CODE);
        argument.should.not.containEql('#v1');
        argument.should.not.containEql(URL);
      }
    }
  });

  it('writes the redirect page 0600 inside a private 0700 directory under the state home', async () => {
    const launches: Launch[] = [];
    await openOn('linux', launches);
    const file = launches[0]?.args[0] ?? '';
    file.startsWith(stateHome).should.be.true();
    (statSync(file).mode & 0o777).should.equal(0o600);
    (statSync(join(file, '..')).mode & 0o777).should.equal(0o700);
    // The code is on disk only inside the page, which is what carries it to the browser.
    readFileSync(file, 'utf8').should.containEql(CODE);
    readFileSync(file, 'utf8').should.containEql('location.replace(');
  });

  it('removes the page once its short life is up, and never before', async () => {
    const launches: Launch[] = [];
    await openOn('linux', launches);
    const file = launches[0]?.args[0] ?? '';
    timers.should.have.length(1);
    timers[0]?.ms.should.equal(10_000);
    existsSync(file).should.be.true();
    timers[0]?.run();
    existsSync(file).should.be.false();
    // The directory goes with it, so nothing of the page is left under the state home.
    leftovers().should.be.empty();
  });

  it('removes the page when the process exits first, and tolerates the timer firing afterwards', async () => {
    const launches: Launch[] = [];
    await openOn('linux', launches);
    exits.should.have.length(1);
    exits[0]?.();
    existsSync(launches[0]?.args[0] ?? '').should.be.false();
    leftovers().should.be.empty();
    should(() => timers[0]?.run()).not.throw();
  });

  it('removes the page at once when the launcher turns out not to exist', async () => {
    // A missing `xdg-open` fails asynchronously, after `open` has already answered; a page nothing
    // will ever read has no business waiting out its lifetime.
    const errors: ErrorListener[] = [];
    (await openerOn('linux', [], undefined, errors).open(URL)).should.be.true();
    leftovers().should.have.length(1);
    errors[0]?.();
    leftovers().should.be.empty();
  });

  it('gives Windows start the empty title it would otherwise eat the path as', async () => {
    // `start` is a `cmd` builtin whose first quoted argument is the new window's
    // title. Without the empty string, the path becomes that title and nothing opens.
    const windows: Launch[] = [];
    (await openOn('win32', windows)).should.be.true();
    windows[0]?.command.should.equal('cmd');
    windows[0]?.args.slice(0, 3).should.eql(['/c', 'start', '']);
    windows[0]?.args.should.have.length(4);
  });

  it('detaches and discards output, so a two-minute countdown is not fighting a browser', async () => {
    // The browser outlives the terminal, and `fy pair` stays to watch for the
    // scan. A child holding the event loop or writing over the countdown breaks both.
    const launches: Launch[] = [];
    await openOn('darwin', launches);
    should(launches[0]?.options).eql({ detached: true, stdio: 'ignore' });
  });

  it('answers false for a host with no documented launcher, rather than guessing one', async () => {
    const launches: Launch[] = [];
    (await openOn('aix', launches)).should.be.false();
    (await openOn('sunos', launches)).should.be.false();
    // And it does not try something and hope — nor leave a page behind for a launcher that never ran.
    launches.should.be.empty();
    leftovers().should.be.empty();
  });

  it('answers false rather than throwing, and leaves no page, when the launcher is not installed', async () => {
    // A headless box with no `xdg-open` is an ordinary host, not an error. The
    // QR and the link are already on the screen for the caller to point at.
    (await openOn('linux', [], new Error('spawn xdg-open ENOENT'))).should.be.false();
    leftovers().should.be.empty();
  });

  it('answers false, and writes nothing, for a link that would run as code', async () => {
    const launches: Launch[] = [];
    (await openerOn('linux', launches).open('javascript:alert(1)')).should.be.false();
    launches.should.be.empty();
    leftovers().should.be.empty();
  });

  it('answers false when the state home cannot hold a page, rather than falling back to a shared directory', async () => {
    const launches: Launch[] = [];
    const missing = new DesktopBrowserOpener({
      platform: 'linux',
      spawn: recordingSpawn(launches),
      stateHome: join(stateHome, 'does', 'not', 'exist'),
      retentionMs: 10_000,
      schedule: () => undefined,
      onExit: () => undefined,
    });
    (await missing.open(URL)).should.be.false();
    launches.should.be.empty();
  });
});

describe('desktopBrowserOpener', () => {
  it('binds the shipped opener to this host without launching anything', async () => {
    // The factory the composition root mounts. Constructing it must not spawn or write —
    // nothing happens until `open` is called, and this suite never calls it on
    // the real one, because a build machine has no business opening a browser.
    should.exist(desktopBrowserOpener(stateHome));
    leftovers().should.be.empty();
  });
});

describe('onProcessExit', () => {
  /** A process that records what was registered and how it was asked to end, and ends nothing. */
  const fakeProcess = () => {
    const listeners = new Map<string, () => void>();
    const exits: number[] = [];
    const host: ExitingProcess = {
      once: (event, listener) => {
        listeners.set(event, listener);
      },
      exit: code => {
        exits.push(code);
        return undefined as never;
      },
    };
    return { host, listeners, exits };
  };

  it('cleans up on exit without ending the process a second time', () => {
    const { host, listeners, exits } = fakeProcess();
    let cleaned = 0;
    onProcessExit(host, () => {
      cleaned += 1;
    });
    listeners.get('exit')?.();
    cleaned.should.equal(1);
    exits.should.be.empty();
  });

  it('cleans up and then exits with the conventional status when it is signalled', () => {
    // Catching a signal replaces its default action, so the status the default would have produced
    // is restored by hand: 128 plus the signal number.
    const { host, listeners, exits } = fakeProcess();
    let cleaned = 0;
    onProcessExit(host, () => {
      cleaned += 1;
    });
    listeners.get('SIGINT')?.();
    listeners.get('SIGTERM')?.();
    cleaned.should.equal(2);
    exits.should.eql([130, 143]);
  });
});

describe('holdProcessOpen', () => {
  it('runs what it was given once the delay is up', async () => {
    const ran = new Promise<void>(resolve => holdProcessOpen(resolve, 1));
    await ran;
  });
});
