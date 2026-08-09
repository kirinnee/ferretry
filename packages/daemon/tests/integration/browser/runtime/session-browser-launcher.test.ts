import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserScreencastFrame } from '@ferretry/protocol';
import should from 'should';
import { BrowserProfileStore } from '../../../../src/adapters/browser/control/profile-store.ts';
import { NodeSessionBrowserLauncher } from '../../../../src/adapters/browser/runtime/session-browser-launcher.ts';
import type { BrowserAutomation } from '../../../../src/lib/browser/transport/index.ts';

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
 * outlives the whole test run. `exec` replaces the shell, so the pid the launcher kills — SIGTERM on
 * a clean close, SIGKILL on a failed launch — is the server itself.
 */
async function fakeChrome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ferretry-session-browser-'));
  roots.push(root);
  const file = join(root, 'chrome');
  await writeFile(
    file,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'Google Chrome 150.0'; exit 0; fi
port=$(printf '%s\\n' "$@" | sed -n 's/--remote-debugging-port=//p')
exec node -e "require('http').createServer((q,s)=>{s.writeHead(200,{'content-type':'application/json'});s.end('{}')}).listen(process.argv[1],'127.0.0.1')" "$port"
`,
  );
  await chmod(file, 0o700);
  return file;
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
});
