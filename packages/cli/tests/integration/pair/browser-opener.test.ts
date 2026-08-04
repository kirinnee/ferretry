/**
 * Handing a URL to the desktop, without ever launching one.
 *
 * `spawn` is injected for exactly that reason: a suite that opened a real
 * browser would be a suite that opens a browser on a build machine. What is
 * asserted is the argument vector — the URL must arrive as an ARGUMENT and never
 * inside a command string, because a link that can become a command is a link
 * that can run one.
 */

import { describe, it } from 'bun:test';
import type { ChildProcess, spawn } from 'node:child_process';
import should from 'should';

import { DesktopBrowserOpener, desktopBrowserOpener } from '../../../src/adapters/pair/browser-opener';

const URL = 'https://ferretry.example.invalid/pair#v1;u;f;CODE';

interface Launch {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: unknown;
}

/** A `spawn` that records instead of launching, and answers a child that does nothing. */
const recordingSpawn = (launches: Launch[], failure?: Error): typeof spawn => {
  const fake = (command: string, args: readonly string[], options: unknown): ChildProcess => {
    if (failure !== undefined) throw failure;
    launches.push({ command, args, options });
    return { on: () => undefined, unref: () => undefined } as unknown as ChildProcess;
  };
  return fake as unknown as typeof spawn;
};

const openOn = async (platform: string, launches: Launch[] = [], failure?: Error): Promise<boolean> =>
  await new DesktopBrowserOpener({ platform, spawn: recordingSpawn(launches, failure) }).open(URL);

describe('DesktopBrowserOpener', () => {
  it('uses each platform own launcher, with the URL as an argument', async () => {
    const mac: Launch[] = [];
    (await openOn('darwin', mac)).should.be.true();
    mac[0]?.command.should.equal('open');
    mac[0]?.args.should.eql([URL]);

    const linux: Launch[] = [];
    (await openOn('linux', linux)).should.be.true();
    linux[0]?.command.should.equal('xdg-open');
    linux[0]?.args.should.eql([URL]);

    // The BSDs run the same freedesktop handler.
    for (const platform of ['freebsd', 'openbsd']) {
      const bsd: Launch[] = [];
      (await openOn(platform, bsd)).should.be.true();
      bsd[0]?.command.should.equal('xdg-open');
    }
  });

  it('gives Windows start the empty title it would otherwise eat the URL as', async () => {
    // `start` is a `cmd` builtin whose first quoted argument is the new window's
    // title. Without the empty string, the URL becomes that title and nothing opens.
    const windows: Launch[] = [];
    (await openOn('win32', windows)).should.be.true();
    windows[0]?.command.should.equal('cmd');
    windows[0]?.args.should.eql(['/c', 'start', '', URL]);
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
    // And it does not try something and hope.
    launches.should.be.empty();
  });

  it('answers false rather than throwing when the launcher is not installed', async () => {
    // A headless box with no `xdg-open` is an ordinary host, not an error. The
    // QR and the link are already on the screen for the caller to point at.
    (await openOn('linux', [], new Error('spawn xdg-open ENOENT'))).should.be.false();
  });
});

describe('desktopBrowserOpener', () => {
  it('binds the shipped opener to this host without launching anything', async () => {
    // The factory the composition root mounts. Constructing it must not spawn —
    // nothing happens until `open` is called, and this suite never calls it on
    // the real one, because a build machine has no business opening a browser.
    should.exist(desktopBrowserOpener());
  });
});
