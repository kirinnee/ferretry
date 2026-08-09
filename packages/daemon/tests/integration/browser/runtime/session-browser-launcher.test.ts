import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserScreencastFrame } from '@ferretry/protocol';
import should from 'should';
import { BrowserProfileStore } from '../../../../src/adapters/browser/control/profile-store.ts';
import { NodeSessionBrowserLauncher } from '../../../../src/adapters/browser/runtime/session-browser-launcher.ts';
import { BrowserWorkerClient } from '../../../../src/adapters/browser/transport/worker-client.ts';
import { type BrowserAutomation, BrowserTransportError } from '../../../../src/lib/browser/transport/index.ts';

/** The same scriptable worker the transport tier drives, reached here through the launcher's OWN
 *  default wiring rather than an injected one. */
const WORKER_ENTRY = join(import.meta.dir, '..', 'transport', 'fixtures', 'fake-worker.mjs');

const roots: string[] = [];
const opened: BrowserAutomation[] = [];
afterEach(async () => {
  // Never leave a child behind: these are real processes.
  await Promise.all(opened.splice(0).map(browser => browser.close().catch(() => undefined)));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

/**
 * A Chrome stand-in that answers `--version` and then serves the private debugging endpoint.
 *
 * `exec` IS LOAD-BEARING. Without it the shell forks the server and stays as the parent, so the pid
 * the launcher holds is the shell's: killing it reaps the shell and orphans a listening server that
 * outlives the whole test run. `exec` replaces the shell, so the pid the launcher kills — SIGTERM
 * then SIGKILL on a clean close, SIGKILL first on a failed launch — is the server itself, and the pid
 * these cases assert against is a process the kernel really did remove.
 *
 * `ignoreTerm` makes it survive SIGTERM the way a wedged browser does. That is what turns "the
 * profile is free" into a claim only a real escalation can satisfy: a launcher that merely SENDS a
 * signal and releases the lease is indistinguishable from one that waits, until the process refuses
 * the polite request.
 */
async function fakeChrome(options: { readonly ignoreTerm?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ferretry-session-browser-'));
  roots.push(root);
  const file = join(root, 'chrome');
  const trap = options.ignoreTerm ? "process.on('SIGTERM',()=>{});" : '';
  await writeFile(
    file,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'Google Chrome 150.0'; exit 0; fi
port=$(printf '%s\\n' "$@" | sed -n 's/--remote-debugging-port=//p')
exec node -e "${trap}require('http').createServer((q,s)=>{s.writeHead(200,{'content-type':'application/json'});s.end('{}')}).listen(process.argv[1],'127.0.0.1')" "$port"
`,
  );
  await chmod(file, 0o700);
  return file;
}

/** The environment the launcher is given: a fake Chrome and nothing else this host happens to set. */
function environment(chrome: string): Record<string, string | undefined> {
  return { FY_CHROME_BIN: chrome, DISPLAY: ':99', PATH: process.env.PATH, HOME: process.env.HOME };
}

/**
 * The Chrome pid the launcher recorded on the lease — the same fact the profile store reads to refuse
 * a second acquirer. Read back through the file rather than out of the object under test, and read
 * WHILE the lease exists: a released lease is deleted, so this is the only window in which the pid a
 * later assertion needs can be captured at all.
 */
async function leasedChromePid(root: string): Promise<number> {
  const record: unknown = JSON.parse(await readFile(join(root, 'browser', 'profile.lock'), 'utf8'));
  const pid = (record as { readonly chromePid?: unknown }).chromePid;
  should(pid).be.a.Number();
  return pid as number;
}

/** Whether a pid is still a process. A child Bun has reaped is gone; one merely signalled is not. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

describe('NodeSessionBrowserLauncher', () => {
  it('should lease a profile, wait for the private CDP endpoint, and release both worker and Chrome', async () => {
    const chrome = await fakeChrome();
    const root = await mkdtemp(join(tmpdir(), 'ferretry-session-profile-'));
    roots.push(root);
    const calls: string[] = [];
    const worker = {
      unexpectedExit: new Promise<number>(() => undefined),
      close: async () => {
        calls.push('worker-close');
      },
    };
    const launcher = new NodeSessionBrowserLauncher(
      new BrowserProfileStore(root),
      '/worker.ts',
      process.execPath,
      { FY_CHROME_BIN: chrome, DISPLAY: ':99', PATH: process.env.PATH, HOME: process.env.HOME },
      async options => {
        calls.push(`worker:${options.endpoint}`);
        return worker as never;
      },
    );
    const browser = await launcher.launch('s1', { width: 800, height: 600 });
    // Registered before the first assertion: a case that fails here must still not leave Chrome up.
    opened.push(browser);
    should(calls[0]).match(/^worker:http:\/\/127\.0\.0\.1:/);
    await browser.close();
    should(calls).containEql('worker-close');
    should(await new BrowserProfileStore(root).acquire({ sessionId: 'again' })).have.property('sessionId', 'again');
  });

  it('should connect its own worker client, so composition names only a runtime and an entry point', async () => {
    // THE POINT OF THIS CASE IS THE ARGUMENT IT DOES NOT PASS. The case above injects a `connectWorker`,
    // which proves the lease and the CDP wait but leaves the launcher's own default — the one thing
    // `bin/fyd.ts` actually relies on — unexercised: composition hands this class a runtime and a
    // worker entry and nothing else, so if the default did not spawn and handshake a worker, a daemon
    // would compose cleanly and fail only when a session first asked for a browser.
    // Arrange
    const chrome = await fakeChrome();
    const root = await mkdtemp(join(tmpdir(), 'ferretry-session-profile-'));
    roots.push(root);
    const launcher = new NodeSessionBrowserLauncher(new BrowserProfileStore(root), WORKER_ENTRY, process.execPath, {
      FY_CHROME_BIN: chrome,
      DISPLAY: ':99',
      PATH: process.env.PATH,
      HOME: process.env.HOME,
    });

    // Act — a real worker process, spawned and handshaken by the launcher's own client.
    const browser = await launcher.launch('s1', { width: 800, height: 600 });
    opened.push(browser);
    const snapshot = await browser.navigate('https://example.test/');

    // Assert — the answer came back through the worker's own protocol, so the whole chain is live.
    should(snapshot).have.property('activePageId', 'p1');
  });

  it('should carry a screencast frame from the worker to the viewer that asked for one', async () => {
    // The viewer half of the automation contract is the half a lease could silently drop: every other
    // method is a one-line delegation, while the screencast hands the worker a LISTENER and is the only
    // path by which a frame reaches a socket at all.
    // Arrange
    const chrome = await fakeChrome();
    const root = await mkdtemp(join(tmpdir(), 'ferretry-session-profile-'));
    roots.push(root);
    const launcher = new NodeSessionBrowserLauncher(new BrowserProfileStore(root), WORKER_ENTRY, process.execPath, {
      FY_CHROME_BIN: chrome,
      DISPLAY: ':99',
      PATH: process.env.PATH,
      HOME: process.env.HOME,
    });
    const browser = await launcher.launch('s1', { width: 800, height: 600 });
    opened.push(browser);
    const frames: BrowserScreencastFrame[] = [];

    // Act — `emit-frames` is the fixture's instruction to publish frames while replying.
    await browser.startScreencast({ width: 800, height: 600 }, frame => frames.push(frame));
    await browser.navigate('emit-frames');
    await browser.stopScreencast();

    // Assert — a frame the worker produced reached the listener the caller registered, carrying the
    // page identity a viewer needs. Only the first arrives: composition names no frame interval, so
    // the client's own default clock coalesces the rest, which is the production behaviour.
    should(frames[0]).have.property('dataBase64', 'AAAA');
    should(frames[0]).have.property('pageId', 'p1');
  });

  /**
   * The lifecycle cases. Every one of them asserts the SAME invariant from a different entry: the
   * shared profile becomes acquirable only after BOTH children are really gone. That is the whole
   * safety property of a shared profile — a lease released a moment early lets a login window, or the
   * next session, open a second Chrome over a profile the first one is still writing to.
   *
   * They assert on REAPED PIDS, not on call order: a pid that no longer exists is the only evidence
   * that survives an implementation which sends a signal and reports success.
   */
  it('should reap Chrome and free the profile before it reports that the worker died', async () => {
    // Arrange — a Chrome that ignores SIGTERM, so nothing here can pass by accident of timing, and a
    // real worker child whose pid the test keeps so it can prove that child is gone too.
    const chrome = await fakeChrome({ ignoreTerm: true });
    const root = await mkdtemp(join(tmpdir(), 'ferretry-session-profile-'));
    roots.push(root);
    let worker: BrowserWorkerClient | undefined;
    const launcher = new NodeSessionBrowserLauncher(
      new BrowserProfileStore(root),
      WORKER_ENTRY,
      process.execPath,
      environment(chrome),
      async options => {
        worker = await BrowserWorkerClient.connect(options);
        return worker;
      },
    );
    const browser = await launcher.launch('s1', { width: 800, height: 600 });
    opened.push(browser);
    const chromePid = await leasedChromePid(root);
    should(alive(chromePid)).be.true();

    // Act — `crashes` is the fixture's instruction to exit mid-request. The worker dies with Chrome
    // still up: the case a race between the two children silently loses, because the worker settling
    // first was treated as the whole browser being gone.
    await browser.navigate('crashes').catch(() => undefined);
    const code = await browser.unexpectedExit;

    // Assert — the exit is observable only once its peer has been reaped and the lease released, so a
    // caller that learns the browser died can never win a race against its own cleanup.
    should(code).equal(3);
    should(alive(chromePid)).be.false();
    should(alive((worker as BrowserWorkerClient).pid)).be.false();
    should(await new BrowserProfileStore(root).acquire({ sessionId: 'again' })).have.property('sessionId', 'again');
  });

  it('should close the worker and free the profile when Chrome is the child that dies', async () => {
    // The mirror image of the case above, and the reason teardown cannot be written for one direction:
    // when Chrome is what died, the WORKER is the survivor holding a browser session open.
    // Arrange
    const chrome = await fakeChrome();
    const root = await mkdtemp(join(tmpdir(), 'ferretry-session-profile-'));
    roots.push(root);
    let worker: BrowserWorkerClient | undefined;
    const launcher = new NodeSessionBrowserLauncher(
      new BrowserProfileStore(root),
      WORKER_ENTRY,
      process.execPath,
      environment(chrome),
      async options => {
        worker = await BrowserWorkerClient.connect(options);
        return worker;
      },
    );
    const browser = await launcher.launch('s1', { width: 800, height: 600 });
    opened.push(browser);
    const chromePid = await leasedChromePid(root);

    // Act — Chrome dies the way a crashed browser does, with nothing telling the worker about it.
    process.kill(chromePid, 'SIGKILL');
    await browser.unexpectedExit;

    // Assert
    should(alive(chromePid)).be.false();
    should(alive((worker as BrowserWorkerClient).pid)).be.false();
    should(await new BrowserProfileStore(root).acquire({ sessionId: 'again' })).have.property('sessionId', 'again');
  });

  it('should escalate to SIGKILL and wait for a stubborn Chrome before releasing the lease', async () => {
    // A normal close. SIGTERM is a REQUEST, and a browser that traps it to shut its profile down
    // cleanly is the normal case, not the pathological one — so a close that releases the lease on the
    // strength of having sent one hands the profile away while Chrome still owns it.
    // Arrange
    const chrome = await fakeChrome({ ignoreTerm: true });
    const root = await mkdtemp(join(tmpdir(), 'ferretry-session-profile-'));
    roots.push(root);
    let worker: BrowserWorkerClient | undefined;
    const launcher = new NodeSessionBrowserLauncher(
      new BrowserProfileStore(root),
      WORKER_ENTRY,
      process.execPath,
      environment(chrome),
      async options => {
        worker = await BrowserWorkerClient.connect(options);
        return worker;
      },
    );
    const browser = await launcher.launch('s1', { width: 800, height: 600 });
    opened.push(browser);
    const chromePid = await leasedChromePid(root);

    // Act — and a second close, because teardown has to be single-flight: two closes must not signal a
    // recycled pid or release a lease a later session has since taken.
    await browser.close();
    await browser.close();

    // Assert
    should(alive(chromePid)).be.false();
    should(alive((worker as BrowserWorkerClient).pid)).be.false();
    should(await new BrowserProfileStore(root).acquire({ sessionId: 'again' })).have.property('sessionId', 'again');
  });

  it('should reap Chrome before releasing the lease when the launch itself fails', async () => {
    // The failure path leases a profile and starts a browser BEFORE it can fail, so it owns the same
    // ordering obligation as a close: a launch that throws while its Chrome is still coming up leaves
    // the next acquirer opening over it.
    // Arrange
    const chrome = await fakeChrome({ ignoreTerm: true });
    const root = await mkdtemp(join(tmpdir(), 'ferretry-session-profile-'));
    roots.push(root);
    let chromePid = 0;
    const launcher = new NodeSessionBrowserLauncher(
      new BrowserProfileStore(root),
      WORKER_ENTRY,
      process.execPath,
      environment(chrome),
      async () => {
        // Captured while the launch is still in flight: the failure deletes the lease record, and this
        // pid is the only evidence left that the browser it named did not outlive it.
        chromePid = await leasedChromePid(root);
        throw new Error('the worker refused to connect');
      },
    );

    // Act
    await should(launcher.launch('s1', { width: 800, height: 600 })).be.rejectedWith(/the worker refused to connect/u);

    // Assert
    should(alive(chromePid)).be.false();
    should(await new BrowserProfileStore(root).acquire({ sessionId: 'again' })).have.property('sessionId', 'again');
  });

  it('should keep the profile leased when the worker could not be confirmed dead', async () => {
    // The fail-safe, and the one case where holding a lease is the RIGHT answer. `close()` on the real
    // client rejects for exactly one reason — it escalated to SIGKILL and still could not confirm the
    // child exited — so a worker that may still be driving a browser must not be followed by handing
    // the profile to somebody else. That is a survivor no signal reaches, which no real process can be
    // made to be on demand, so the worker is injected: the branch is what is under test, not the pid.
    // Arrange
    const chrome = await fakeChrome();
    const root = await mkdtemp(join(tmpdir(), 'ferretry-session-profile-'));
    roots.push(root);
    const worker = {
      unexpectedExit: new Promise<number>(() => undefined),
      close: async () => {
        throw new BrowserTransportError('upstream_failed', 'browser worker could not be terminated', 504);
      },
    };
    const launcher = new NodeSessionBrowserLauncher(
      new BrowserProfileStore(root),
      '/worker.ts',
      process.execPath,
      environment(chrome),
      async () => worker as never,
    );
    const browser = await launcher.launch('s1', { width: 800, height: 600 });
    opened.push(browser);
    const chromePid = await leasedChromePid(root);

    // Act — close reports no failure: there is nobody to report it to, and the lease IS the report.
    await browser.close();

    // Assert — Chrome is still reaped, because an unkillable worker is no reason to leave a browser
    // up, and the profile stays leased to the session whose worker could not be accounted for.
    should(alive(chromePid)).be.false();
    await should(new BrowserProfileStore(root).acquire({ sessionId: 'again' })).be.rejectedWith(
      /leased by session s1/u,
    );
  });

  it('should refuse the SAME session a second launch while its uncertain lease is retained', async () => {
    // The quarantine is only worth the name if it holds against the caller most likely to come back:
    // the session whose own cleanup could not be proved. `BrowserSessionService.stop()` drops the run
    // before it awaits the close and swallows the outcome, so the very next `start` for this session
    // arrives here with nothing to say a browser was ever in doubt. A retry that is handed the
    // retained lease opens a second Chrome over the quarantined profile AND overwrites the recorded
    // Chrome pid — which is the one fact a later daemon reads to refuse a reclaim.
    // Arrange
    const chrome = await fakeChrome();
    const root = await mkdtemp(join(tmpdir(), 'ferretry-session-profile-'));
    roots.push(root);
    const worker = {
      unexpectedExit: new Promise<number>(() => undefined),
      close: async () => {
        throw new BrowserTransportError('upstream_failed', 'browser worker could not be terminated', 504);
      },
    };
    const launcher = new NodeSessionBrowserLauncher(
      new BrowserProfileStore(root),
      '/worker.ts',
      process.execPath,
      environment(chrome),
      async () => worker as never,
    );
    const browser = await launcher.launch('s1', { width: 800, height: 600 });
    opened.push(browser);
    const first = await leasedChromePid(root);
    await browser.close();

    // Act — the same launcher, the same external session id, exactly as `ensure()` would retry it.
    const retry = launcher.launch('s1', { width: 800, height: 600 });
    // Registered BEFORE it is judged: a red run must not leak the Chrome an unexpected success starts.
    await retry.then(opened.push.bind(opened), () => undefined);

    // Assert — refused, and the retained record still names the ORIGINAL Chrome. A retry that got
    // through would report a different, live pid here even where the refusal assertion was loosened.
    await should(retry).be.rejectedWith(/leased by session s1/u);
    should(await leasedChromePid(root)).equal(first);
  });
});
