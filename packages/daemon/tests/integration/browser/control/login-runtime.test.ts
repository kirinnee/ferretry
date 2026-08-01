import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { BrowserControlError } from '../../../../src/lib/index.ts';
import {
  NodeBrowserLoginRuntime,
  XvfbDisplay,
  type BrowserDisplayPort,
  type BrowserLoginChild,
  type XvfbChild,
} from '../../../../src/adapters/index.ts';

/**
 * The host effects the human login window performs, over real spawns of FAKE executables.
 *
 * NOTHING REAL IS STARTED. Every program this adapter runs is a shell script this test writes into a
 * temp directory and points the adapter at — the same technique `BunTmuxProcess`'s test uses, and the
 * reason every executable here is injected rather than looked up inside the adapter. No X server, no
 * Chrome and no VNC listener is put on the machine running these tests, which matters more than usual:
 * the whole point of the subsystem is that a successful call puts all three on the host.
 *
 * The two readiness probes that CANNOT be faked by a script are exercised against the real thing at a
 * loopback address the test owns: a free port is taken by binding one, and "is the VNC server up" is
 * answered by a listener this test opened and closed.
 */

const roots: string[] = [];

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ferretry-login-runtime-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A script the adapter can spawn for real, with the mode the kernel needs to exec it. */
async function script(root: string, name: string, body: string): Promise<string> {
  const file = join(root, name);
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o700);
  return file;
}

/** A child the test settles by hand: no process, so the readiness rules can be driven exactly. */
function fakeChild(exited: Promise<number>): BrowserLoginChild & { readonly signals: string[] } {
  const signals: string[] = [];
  return {
    pid: 4_242,
    exited,
    signals,
    kill: signal => {
      signals.push(signal);
    },
  };
}

/** Never resolves: a child that is neither ready nor dead, which is what a deadline is for. */
const running = (): Promise<number> => new Promise<number>(() => undefined);

/** A clock that advances by a fixed step every time it is read, so a deadline is reached in a bounded
 *  number of polls without any wall-clock waiting. */
function tickingClock(stepMs: number): () => number {
  let current = 0;
  return () => {
    current += stepMs;
    return current;
  };
}

/** An Xvfb child whose stdout the test writes, so `-displayfd` can be simulated without a process. */
function fakeXvfb(chunks: readonly string[], options: { readonly error?: boolean } = {}): XvfbChild {
  const signals: string[] = [];
  return {
    pid: 77,
    exited: running(),
    signals,
    kill: signal => {
      signals.push(signal);
    },
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        if (options.error === true) {
          controller.error(new Error('the display pipe broke'));
          return;
        }
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    }),
  } as XvfbChild & { readonly signals: string[] };
}

const noSleep = async (): Promise<void> => undefined;

describe('XvfbDisplay', () => {
  it('should start a real Xvfb-shaped program, take the display it announces, and close it', async () => {
    // The default spawner is the code path production uses, so it is exercised for real here against a
    // script that behaves the way `-displayfd 1` does: the number, a newline, then a long-lived server.
    // Arrange
    const root = await workspace();
    const record = join(root, 'argv.txt');
    const executable = await script(root, 'Xvfb', `printf '%s\\n' "$@" > '${record}'\nprintf '99\\n'\nsleep 5`);
    const subject = new XvfbDisplay({ executable: () => executable, pollIntervalMs: 1 });

    try {
      // Act
      const display = await subject.display();
      const again = await subject.display();

      // Assert
      should(display).equal(':99');
      // Memoized: a second caller shares the one X server rather than starting a second.
      should(again).equal(':99');
      should((await readFile(record, 'utf8')).trimEnd().split('\n')).deepEqual([
        '-displayfd',
        '1',
        '-screen',
        '0',
        // The default screen is the protocol's own maximum viewport, so the window can be as large as
        // any browser surface the product supports.
        '1920x1200x24',
        // Nothing off this machine may reach the screen: the VNC listener is the only published door.
        '-nolisten',
        'tcp',
      ]);
    } finally {
      await subject.close();
    }
  });

  it('should honour an explicit screen size', async () => {
    // Arrange
    const root = await workspace();
    const record = join(root, 'argv.txt');
    const executable = await script(root, 'Xvfb', `printf '%s\\n' "$@" > '${record}'\nprintf '7\\n'\nsleep 5`);
    const subject = new XvfbDisplay({
      executable: () => executable,
      screen: { width: 800, height: 600 },
      pollIntervalMs: 1,
    });

    try {
      // Act
      const display = await subject.display();

      // Assert
      should(display).equal(':7');
      should(await readFile(record, 'utf8')).match(/800x600x24/);
    } finally {
      await subject.close();
    }
  });

  it('should refuse with a sentence naming what to install when the host has no Xvfb', async () => {
    // Arrange
    const subject = new XvfbDisplay({ executable: () => undefined });

    // Act
    const failure = await subject.display().catch((error: unknown) => error);

    // Assert
    should(failure).be.instanceof(BrowserControlError);
    should((failure as BrowserControlError).code).equal('launch_failed');
    should((failure as BrowserControlError).message).match(/Xvfb was not found/);
    // Nothing was taken, so nothing needs releasing.
    await subject.close();
  });

  it('should retry rather than replay a failure, once the host can serve one', async () => {
    // The memo is on the promise, so a failed attempt must clear it: an operator who installs Xvfb and
    // tries again should get a display, not the error the first `start` produced.
    // Arrange
    let present = false;
    const root = await workspace();
    const executable = await script(root, 'Xvfb', `printf '3\\n'\nsleep 5`);
    const subject = new XvfbDisplay({
      executable: () => (present ? executable : undefined),
      pollIntervalMs: 1,
    });

    try {
      // Act
      await should(subject.display()).be.rejectedWith(BrowserControlError);
      present = true;

      // Assert
      should(await subject.display()).equal(':3');
    } finally {
      await subject.close();
    }
  });

  it('should report an Xvfb that died before announcing anything as the launch failure it is', async () => {
    // Arrange
    const root = await workspace();
    const executable = await script(root, 'Xvfb', 'exit 4');
    const subject = new XvfbDisplay({ executable: () => executable, pollIntervalMs: 1 });

    // Act
    const failure = await subject.display().catch((error: unknown) => error);

    // Assert
    should(failure).be.instanceof(BrowserControlError);
    should((failure as BrowserControlError).message).match(/Xvfb exited with status 4/);
  });

  it('should refuse a display number it cannot read, and kill the server that failed to report one', async () => {
    // Three ways the announcement can be unusable while the server is still ALIVE, and all three must
    // end with the child killed rather than left running on a display nothing knows the number of. A
    // live Xvfb is why the deadline is what ends these waits — and why it reports what it learned
    // instead of how long it waited.
    // Arrange
    const closedWithoutNewline = fakeXvfb(['12']);
    const notANumber = fakeXvfb(['bogus\n']);
    const brokenPipe = fakeXvfb([], { error: true });

    // Act
    const outcomes = await Promise.all(
      [closedWithoutNewline, notANumber, brokenPipe].map(async child => {
        const subject = new XvfbDisplay({
          executable: () => '/usr/bin/Xvfb',
          spawn: () => child,
          readinessTimeoutMs: 5,
          pollIntervalMs: 1,
          now: tickingClock(4),
          sleep: noSleep,
        });
        return await subject.display().catch((error: unknown) => error);
      }),
    );

    // Assert
    for (const outcome of outcomes) {
      should(outcome).be.instanceof(BrowserControlError);
      should((outcome as BrowserControlError).message).match(/did not report the display number/);
    }
    for (const child of [closedWithoutNewline, notANumber, brokenPipe]) {
      should((child as XvfbChild & { readonly signals: string[] }).signals).deepEqual(['SIGKILL']);
    }
  });

  it('should give up on an Xvfb that neither announces nor dies, and kill it', async () => {
    // Arrange
    const child = fakeXvfb([]) as XvfbChild & { readonly signals: string[] };
    const hung: XvfbChild = { ...child, stdout: new ReadableStream<Uint8Array>({ start: () => undefined }) };
    const signals: string[] = [];
    const subject = new XvfbDisplay({
      executable: () => '/usr/bin/Xvfb',
      spawn: () => ({ ...hung, kill: signal => signals.push(signal) }),
      readinessTimeoutMs: 5,
      pollIntervalMs: 1,
      now: tickingClock(4),
      sleep: noSleep,
    });

    // Act
    const failure = await subject.display().catch((error: unknown) => error);

    // Assert
    should(failure).be.instanceof(BrowserControlError);
    should((failure as BrowserControlError).message).match(/Xvfb was not ready within 5ms/);
    should(signals).deepEqual(['SIGKILL']);
  });

  it('should terminate the server it took when the daemon closes it', async () => {
    // Arrange
    const signals: string[] = [];
    const subject = new XvfbDisplay({
      executable: () => '/usr/bin/Xvfb',
      spawn: () => ({ ...fakeXvfb(['5\n']), kill: signal => signals.push(signal) }),
      pollIntervalMs: 1,
      sleep: noSleep,
    });

    // Act
    should(await subject.display()).equal(':5');
    await subject.close();
    await subject.close();

    // Assert
    // SIGTERM once: a second close must not signal a child the first one already released.
    should(signals).deepEqual(['SIGTERM']);
  });
});

/** A display the runtime tests can hand out without an X server behind it. */
function fakeDisplay(): BrowserDisplayPort & { closed: number } {
  const port = {
    closed: 0,
    display: async () => ':9',
    close: async () => {
      port.closed += 1;
    },
  };
  return port;
}

describe('NodeBrowserLoginRuntime', () => {
  it('should describe this host from its own environment by default', async () => {
    // Arrange
    const root = await workspace();
    const subject = new NodeBrowserLoginRuntime({ display: fakeDisplay(), secretsDirectory: root });

    // Assert
    should(subject.platform).equal(process.platform);
    should(subject.environmentSource).equal(process.env);
    should(subject.hostname).be.a.String().and.not.empty();
    should(subject.sshUser).be.a.String().and.not.empty();
    // The clock is the wall clock the window stamps `openedAt` and `expiresAt` from.
    should(subject.now()).be.approximately(Date.now(), 5_000);
  });

  it('should delegate the display it renders on, and release it on close', async () => {
    // Arrange
    const root = await workspace();
    const display = fakeDisplay();
    const subject = new NodeBrowserLoginRuntime({ display, secretsDirectory: root });

    // Act
    const resolved = await subject.display();
    await subject.close();

    // Assert
    should(resolved).equal(':9');
    should(display.closed).equal(1);
  });

  it("should prefer the operator's Chrome and otherwise this platform's candidates", async () => {
    // Arrange
    const root = await workspace();
    const override = join(root, 'my-chrome');
    await writeFile(override, '');
    const base = { display: fakeDisplay(), secretsDirectory: root, platform: 'linux' as const };

    // Act
    const chosen = new NodeBrowserLoginRuntime({
      ...base,
      chromeOverride: () => override,
      exists: candidate => candidate === override,
    }).chromeExecutable();
    const discovered = new NodeBrowserLoginRuntime({
      ...base,
      exists: candidate => candidate === '/usr/bin/chromium',
    }).chromeExecutable();
    const missing = () => new NodeBrowserLoginRuntime({ ...base, exists: () => false }).chromeExecutable();

    // Assert
    should(chosen).equal(override);
    should(discovered).equal('/usr/bin/chromium');
    should(missing).throw(/Google Chrome was not found/);
  });

  it('should name the missing program rather than spawning whatever answers to its name', async () => {
    // Arrange
    const root = await workspace();
    const absent = new NodeBrowserLoginRuntime({ display: fakeDisplay(), secretsDirectory: root });
    const present = new NodeBrowserLoginRuntime({
      display: fakeDisplay(),
      secretsDirectory: root,
      x11vncExecutable: () => '/usr/bin/x11vnc',
      timeoutExecutable: () => '/usr/bin/timeout',
    });

    // Assert
    should(() => absent.x11vncExecutable()).throw(/x11vnc was not found/);
    should(() => absent.timeoutExecutable()).throw(/timeout\(1\) was not found/);
    should(present.x11vncExecutable()).equal('/usr/bin/x11vnc');
    should(present.timeoutExecutable()).equal('/usr/bin/timeout');
  });

  it('should read a real Chrome version, and refuse an answer it cannot use', async () => {
    // A blank or failed version is not cosmetic: the profile store refuses a profile primed by a newer
    // Chrome, so a downgrade must not be able to reuse a profile it can corrupt.
    // Arrange
    const root = await workspace();
    const good = await script(root, 'chrome', "printf 'Google Chrome 130.0.6723.116 \\n'");
    const failing = await script(root, 'broken', 'exit 3');
    const silent = await script(root, 'silent', 'exit 0');
    const subject = new NodeBrowserLoginRuntime({ display: fakeDisplay(), secretsDirectory: root });

    // Act
    const version = await subject.chromeVersion(good);

    // Assert
    should(version).equal('Google Chrome 130.0.6723.116');
    await should(subject.chromeVersion(failing)).be.rejectedWith(/did not report a version \(status 3\)/);
    await should(subject.chromeVersion(silent)).be.rejectedWith(/did not report a version \(status 0\)/);
  });

  it('should spawn with a narrow environment and drop the variables the host does not set', async () => {
    // `browserEnvironment` deliberately produces a SPARSE record, and an absent variable must be absent
    // in the child rather than the string "undefined".
    // Arrange
    const root = await workspace();
    const record = join(root, 'env.txt');
    const executable = await script(
      root,
      'chrome',
      `printf 'HOME=%s\\n' "$HOME" > '${record}'\nprintf 'LANG=[%s]\\n' "$LANG" >> '${record}'`,
    );
    const subject = new NodeBrowserLoginRuntime({ display: fakeDisplay(), secretsDirectory: root });

    // Act
    const child = subject.spawn([executable], { HOME: root, LANG: undefined });
    const code = await child.exited;

    // Assert
    should(code).equal(0);
    should(child.pid).be.above(0);
    should(await readFile(record, 'utf8')).equal(`HOME=${root}\nLANG=[]\n`);
  });

  it('should take a port that is genuinely free on loopback', async () => {
    // Arrange
    const root = await workspace();
    const subject = new NodeBrowserLoginRuntime({ display: fakeDisplay(), secretsDirectory: root });

    // Act
    const port = await subject.freePort();

    // Assert
    should(port).be.above(0).and.below(65_536);
    // Proof it is free: the test can bind it.
    const server = Bun.listen({ hostname: '127.0.0.1', port, socket: { data: () => undefined } });
    server.stop(true);
  });

  it('should write the VNC password where only this daemon can read it', async () => {
    // Arrange
    const root = await workspace();
    const directory = join(root, 'browser');
    const subject = new NodeBrowserLoginRuntime({ display: fakeDisplay(), secretsDirectory: directory });

    // Act
    const file = await subject.writePassword('abcd2345');

    // Assert
    should(file).equal(join(directory, 'vnc-password'));
    should(await readFile(file, 'utf8')).equal('abcd2345\n');
    // eslint-disable-next-line no-bitwise
    should((await stat(file)).mode & 0o777).equal(0o600);
    // eslint-disable-next-line no-bitwise
    should((await stat(directory)).mode & 0o777).equal(0o700);
  });

  it('should re-tighten a password file a crashed window left behind', async () => {
    // The mode argument applies only when the file is created, so a leftover file would otherwise keep
    // whatever mode it had.
    // Arrange
    const root = await workspace();
    const directory = join(root, 'browser');
    await mkdir(directory, { recursive: true });
    const stale = join(directory, 'vnc-password');
    await writeFile(stale, 'old\n');
    await chmod(stale, 0o644);
    const subject = new NodeBrowserLoginRuntime({ display: fakeDisplay(), secretsDirectory: directory });

    // Act
    await subject.writePassword('efgh6789');

    // Assert
    // eslint-disable-next-line no-bitwise
    should((await stat(stale)).mode & 0o777).equal(0o600);
    should(await readFile(stale, 'utf8')).equal('efgh6789\n');
  });

  it('should treat a password file x11vnc already deleted as a clean removal', async () => {
    // `-passwdfile rm:` deletes it after reading, so the usual case is a file that is already gone.
    // Arrange
    const root = await workspace();
    const subject = new NodeBrowserLoginRuntime({ display: fakeDisplay(), secretsDirectory: root });
    const file = await subject.writePassword('ijkl2345');

    // Act
    await subject.removePassword(file);
    await subject.removePassword(file);

    // Assert
    should(await Bun.file(file).exists()).be.false();
  });

  it("should wait for Chrome's startup marker inside the profile it was pointed at", async () => {
    // Arrange
    const root = await workspace();
    const profile = join(root, 'profile');
    await mkdir(profile, { recursive: true });
    const subject = new NodeBrowserLoginRuntime({
      display: fakeDisplay(),
      secretsDirectory: root,
      pollIntervalMs: 1,
    });
    const child = fakeChild(running());
    // Appears while the wait is polling, which is what makes this a wait rather than a check.
    setTimeout(() => void writeFile(join(profile, 'SingletonLock'), ''), 5);

    // Act + Assert
    await subject.waitForChrome(profile, child);
  });

  it('should report a Chrome that exited before it started, however it exited', async () => {
    // Both shapes of "not running" must end the wait: a child that exited with a status, and one whose
    // exit could not even be observed. Waiting twenty seconds for a process that is already gone
    // reports a timeout in place of the launch failure the daemon already had.
    // Arrange
    const root = await workspace();
    const subject = new NodeBrowserLoginRuntime({
      display: fakeDisplay(),
      secretsDirectory: root,
      pollIntervalMs: 1,
      sleep: noSleep,
      exists: () => false,
    });

    // Act + Assert
    await should(subject.waitForChrome('/nowhere', fakeChild(Promise.resolve(9)))).be.rejectedWith(
      /Chrome exited with status 9/,
    );
    await should(
      subject.waitForChrome('/nowhere', fakeChild(Promise.reject(new Error('unwatchable')))),
    ).be.rejectedWith(/Chrome exited with status -1/);
  });

  it('should give up on a Chrome that neither starts nor dies', async () => {
    // Arrange
    const root = await workspace();
    const subject = new NodeBrowserLoginRuntime({
      display: fakeDisplay(),
      secretsDirectory: root,
      readinessTimeoutMs: 7,
      pollIntervalMs: 1,
      now: tickingClock(5),
      sleep: noSleep,
      exists: () => false,
    });

    // Act + Assert
    await should(subject.waitForChrome('/nowhere', fakeChild(running()))).be.rejectedWith(
      /Chrome was not ready within 7ms/,
    );
  });

  it('should wait for the VNC server by connecting to the loopback port it claims', async () => {
    // The one probe that cannot be faked by a script, so it runs against a real listener the test owns.
    // Arrange
    const root = await workspace();
    const subject = new NodeBrowserLoginRuntime({
      display: fakeDisplay(),
      secretsDirectory: root,
      pollIntervalMs: 1,
    });
    const port = await subject.freePort();
    const server = Bun.listen({ hostname: '127.0.0.1', port, socket: { data: () => undefined } });

    try {
      // Act + Assert
      await subject.waitForVnc(port, fakeChild(running()));
    } finally {
      server.stop(true);
    }
  });

  it('should not mistake a closed port for a VNC server that is up', async () => {
    // Arrange
    const root = await workspace();
    const subject = new NodeBrowserLoginRuntime({
      display: fakeDisplay(),
      secretsDirectory: root,
      readinessTimeoutMs: 3,
      pollIntervalMs: 1,
      now: tickingClock(2),
      sleep: noSleep,
    });
    const port = await subject.freePort();

    // Act + Assert
    await should(subject.waitForVnc(port, fakeChild(running()))).be.rejectedWith(
      /the VNC server was not ready within 3ms/,
    );
  });

  it('should end a child politely, and kill the one that ignores it', async () => {
    // Arrange
    const root = await workspace();
    const subject = new NodeBrowserLoginRuntime({
      display: fakeDisplay(),
      secretsDirectory: root,
      terminateGraceMs: 5,
      pollIntervalMs: 1,
      now: tickingClock(4),
      sleep: noSleep,
    });
    const polite = fakeChild(Promise.resolve(0));
    const unreapable = fakeChild(Promise.reject(new Error('gone but unwatchable')));
    const stubborn = fakeChild(running());

    // Act
    await subject.terminateChrome(polite);
    await subject.terminateVnc(unreapable);
    await subject.terminateVnc(stubborn);

    // Assert
    should(polite.signals).deepEqual(['SIGTERM']);
    // A child whose exit cannot be observed is still a child that is not running: it is not killed
    // twice for the crime of being unwatchable.
    should(unreapable.signals).deepEqual(['SIGTERM']);
    should(stubborn.signals).deepEqual(['SIGTERM', 'SIGKILL']);
  });
});
