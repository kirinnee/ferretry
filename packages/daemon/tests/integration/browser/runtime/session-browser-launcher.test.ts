import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserScreencastFrame } from '@ferretry/protocol';
import should from 'should';
import { BrowserProfileStore } from '../../../../src/adapters/browser/control/profile-store.ts';
import {
  NodeSessionBrowserLauncher,
  type SessionBrowserModeOptions,
} from '../../../../src/adapters/browser/runtime/session-browser-launcher.ts';
import { BrowserWorkerClient } from '../../../../src/adapters/browser/transport/worker-client.ts';
import { BrowserControlError } from '../../../../src/lib/browser/control/index.ts';
import type { ResolvedBrowserProxy } from '../../../../src/lib/browser/proxy/index.ts';
import type { BrowserWorkerProgram } from '../../../../src/lib/browser/runtime/index.ts';
import { type BrowserAutomation, BrowserTransportError } from '../../../../src/lib/browser/transport/index.ts';

/** The same scriptable worker the transport tier drives, reached here through the launcher's OWN
 *  default wiring rather than an injected one. */
const WORKER_ENTRY: BrowserWorkerProgram = {
  kind: 'source',
  entry: join(import.meta.dir, '..', 'transport', 'fixtures', 'fake-worker.mjs'),
};
/** A worker the injected `connectWorker` stands in for, so its path is never spawned. */
const INJECTED_WORKER: BrowserWorkerProgram = { kind: 'source', entry: '/worker.ts' };

/** The shipped launcher gives a Chrome that ignores SIGTERM two seconds before SIGKILL; these cases only need the escalation. */
const SHORT_SHUTDOWN = { shutdownTimeoutMs: 250 };
/** The machine's DevTools transport, named outright where a case is about one of them. */
const PIPE = { transport: async () => 'pipe' as const };
const PORT = { transport: async () => 'port' as const };

const roots: string[] = [];
const opened: BrowserAutomation[] = [];
afterEach(async () => {
  // Never leave a child behind: these are real processes.
  await Promise.all(opened.splice(0).map(browser => browser.close().catch(() => undefined)));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

/**
 * What the Chrome stand-in runs, by transport. Given `--port=N` (the launcher asked for a debugging port) it
 * serves the endpoint the launcher polls. Otherwise it speaks the DevTools protocol on the pipe a real Chrome
 * gets with `--remote-debugging-pipe` — requests in on fd 3, replies out on fd 4, every message
 * NUL-terminated — and listens nowhere; a reply names the method it answers, so a worker can prove it reached
 * THIS Chrome. `--quit-on-pipe-end` is the real Chrome's behaviour when the last holder of the other end
 * goes; the default stays up, so a case whose injected worker holds no end is not racing a Chrome that quit.
 */
const FAKE_CHROME_PROGRAM = `const fs = require('fs');
if (process.argv.includes('--ignore-term')) process.on('SIGTERM', () => {});
const port = process.argv.find(argument => argument.startsWith('--port='));
if (port !== undefined) {
  require('http').createServer((q, s) => { s.writeHead(200, { 'content-type': 'application/json' }); s.end('{}'); })
    .listen(Number(port.slice('--port='.length)), '127.0.0.1');
  return;
}
const replies = fs.createWriteStream('', { fd: 4 });
replies.on('error', () => {});
let pending = '';
const requests = fs.createReadStream('', { fd: 3, encoding: 'utf8' });
requests.on('data', chunk => {
  pending += chunk;
  for (let end = pending.indexOf('\\0'); end !== -1; end = pending.indexOf('\\0')) {
    const { id, method } = JSON.parse(pending.slice(0, end));
    pending = pending.slice(end + 1);
    replies.write(JSON.stringify({ id, result: { product: 'FakeChrome/150.0', method } }) + '\\0');
  }
});
requests.on('error', () => {});
requests.on('end', () => {
  if (process.argv.includes('--quit-on-pipe-end')) process.exit(0);
});
setInterval(() => {}, 60_000);
`;

/**
 * A Chrome stand-in that answers `--version` and then speaks the DevTools protocol on its pipe.
 *
 * `exec` IS LOAD-BEARING. Without it the shell forks the stand-in and stays as the parent, so the pid
 * the launcher holds is the shell's: killing it reaps the shell and orphans a stand-in that outlives
 * the whole test run. `exec` replaces the shell, so the pid the launcher kills — SIGTERM then
 * SIGKILL on a clean close, SIGKILL first on a failed launch — is the stand-in itself, and the pid
 * these cases assert against is a process the kernel really did remove.
 *
 * `ignoreTerm` makes it survive SIGTERM the way a wedged browser does. That is what turns "the
 * profile is free" into a claim only a real escalation can satisfy: a launcher that merely SENDS a
 * signal and releases the lease is indistinguishable from one that waits, until the process refuses
 * the polite request.
 */
async function fakeChrome(
  options: {
    readonly ignoreTerm?: boolean;
    readonly recordArguments?: boolean;
    readonly version?: string;
    readonly quitsWhenPipeCloses?: boolean;
  } = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ferretry-session-browser-'));
  roots.push(root);
  const file = join(root, 'chrome');
  await writeFile(join(root, 'fake-chrome.cjs'), FAKE_CHROME_PROGRAM);
  const flags = [
    ...(options.ignoreTerm ? ['--ignore-term'] : []),
    ...(options.quitsWhenPipeCloses ? ['--quit-on-pipe-end'] : []),
  ].join(' ');
  await writeFile(
    file,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'Google Chrome ${options.version ?? '150.0'}'; exit 0; fi
${options.recordArguments ? `printf '%s\\n' "$@" > "${file}.args"\n` : ''}${options.recordArguments ? `printf '%s\\n' "\${DISPLAY-unset}" > "${file}.display"\nprintf '%s\\n' "\${XAUTHORITY-unset}" > "${file}.xauthority"\n` : ''}port=$(printf '%s\\n' "$@" | sed -n 's/--remote-debugging-port=//p')
exec node "${join(root, 'fake-chrome.cjs')}" ${flags} \${port:+--port=$port}
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
  it('should lease a profile, hand the worker the DevTools pipe, and release both worker and Chrome', async () => {
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
      INJECTED_WORKER,
      process.execPath,
      { FY_CHROME_BIN: chrome, DISPLAY: ':99', PATH: process.env.PATH, HOME: process.env.HOME },
      async options => {
        calls.push(`worker:${options.endpoint}`);
        should(options.cdpPipe?.toChrome).be.a.Number();
        should(options.cdpPipe?.fromChrome).be.a.Number();
        return worker as never;
      },
      PIPE,
    );
    const browser = await launcher.launch({ width: 800, height: 600 });
    // Registered before the first assertion: a case that fails here must still not leave Chrome up.
    opened.push(browser);
    should(calls[0]).equal('worker:pipe');
    await browser.close();
    should(calls).containEql('worker-close');
    should(await new BrowserProfileStore(root).acquire({ sessionId: 'again' })).have.property('sessionId', 'again');
  });

  it('should keep the port transport: wait for the private CDP endpoint, then hand the worker its URL', async () => {
    // The port is still a choice a machine can make (it keeps `navigator.webdriver` false), so it must
    // still work end to end: a loopback port Chrome answers on, and no pipe handed to anyone.
    const chrome = await fakeChrome({ recordArguments: true });
    const root = await mkdtemp(join(tmpdir(), 'ferretry-session-profile-'));
    roots.push(root);
    const calls: string[] = [];
    const worker = { unexpectedExit: new Promise<number>(() => undefined), close: async () => undefined };
    const launcher = new NodeSessionBrowserLauncher(
      new BrowserProfileStore(root),
      INJECTED_WORKER,
      process.execPath,
      environment(chrome),
      async options => {
        calls.push(`worker:${options.endpoint}`);
        should(options.cdpPipe).be.undefined();
        return worker as never;
      },
      PORT,
    );
    const browser = await launcher.launch({ width: 800, height: 600 });
    opened.push(browser);
    should(calls[0]).match(/^worker:http:\/\/127\.0\.0\.1:\d+$/u);
    const started = await readFile(`${chrome}.args`, 'utf8');
    should(started).containEql('--remote-debugging-address=127.0.0.1');
    should(started).match(/--remote-debugging-port=\d+/u);
    should(started).not.containEql('--remote-debugging-pipe');
    await browser.close();
    should(await new BrowserProfileStore(root).acquire({ sessionId: 'again' })).have.property('sessionId', 'again');
  });

  it.if(process.platform === 'linux')(
    'should refuse a debugging port another program took before Chrome could, and never ask it anything',
    async () => {
      // Arrange: the port handed to Chrome is already held — the squatter that used to win the freePort race.
      const asked: string[] = [];
      const squatter = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: request => {
          asked.push(new URL(request.url).pathname);
          return Response.json({});
        },
      });
      const port = squatter.port as number;
      const chrome = await fakeChrome();
      const root = await mkdtemp(join(tmpdir(), 'ferretry-session-profile-'));
      roots.push(root);
      const launcher = new NodeSessionBrowserLauncher(
        new BrowserProfileStore(root),
        INJECTED_WORKER,
        process.execPath,
        environment(chrome),
        async () => {
          throw new Error('the worker must not be reached');
        },
        { ...PORT, cdpPort: async () => port },
      );

      try {
        // Act + Assert
        await should(launcher.launch({ width: 800, height: 600 })).be.rejectedWith(
          `port ${String(port)} is held by another program (uid ${String(process.getuid?.())}), not this browser — someone may be squatting it; pick another port base or free it`,
        );
        should(asked).deepEqual([]);
        should(await new BrowserProfileStore(root).acquire({ sessionId: 'again' })).have.property('sessionId', 'again');
      } finally {
        await squatter.stop(true);
      }
    },
  );

  it("should use the port when the machine's transport cannot be read: the pipe is only ever chosen", async () => {
    const chrome = await fakeChrome({ recordArguments: true });
    const root = await mkdtemp(join(tmpdir(), 'ferretry-session-profile-'));
    roots.push(root);
    const worker = { unexpectedExit: new Promise<number>(() => undefined), close: async () => undefined };
    const launcher = new NodeSessionBrowserLauncher(
      new BrowserProfileStore(root),
      INJECTED_WORKER,
      process.execPath,
      environment(chrome),
      async () => worker as never,
      {
        platform: 'linux',
        transport: async () => {
          throw new Error('machine.yaml is mid-write');
        },
      },
    );
    const browser = await launcher.launch({ width: 800, height: 600 });
    opened.push(browser);
    const started = await readFile(`${chrome}.args`, 'utf8');
    should(started).match(/--remote-debugging-port=\d+/u);
    should(started).not.containEql('--remote-debugging-pipe');
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
    const browser = await launcher.launch({ width: 800, height: 600 });
    opened.push(browser);
    const snapshot = await browser.navigate('p1', 'https://example.test/');

    // Assert — the answer came back through the worker's own protocol, so the whole chain is live.
    should(snapshot).have.property('activePageId', 'p1');
  });

  describe('the DevTools pipe', () => {
    /** Starts the launcher's OWN worker client against a fake Chrome, keeping the worker so a case can kill it. */
    function pipeLauncher(
      root: string,
      chrome: string,
      workers: BrowserWorkerClient[] = [],
    ): NodeSessionBrowserLauncher {
      return new NodeSessionBrowserLauncher(
        new BrowserProfileStore(root),
        WORKER_ENTRY,
        process.execPath,
        environment(chrome),
        async options => {
          const worker = await BrowserWorkerClient.connect(options);
          workers.push(worker);
          return worker;
        },
        { ...SHORT_SHUTDOWN, ...PIPE },
      );
    }

    it('should drive Chrome over the pipe it wired, with no debugging port and no port probe', async () => {
      // Arrange — every fetch the launch makes is recorded: the old launch polled a loopback port for
      // `/json/version`, a probe another account on the host could have answered first.
      const chrome = await fakeChrome({ recordArguments: true });
      const root = await mkdtemp(join(tmpdir(), 'ferretry-session-profile-'));
      roots.push(root);
      const realFetch = globalThis.fetch;
      const probed: string[] = [];
      globalThis.fetch = (async (input: string | URL | Request) => {
        probed.push(String(input));
        throw new Error('no network in this case');
      }) as unknown as typeof fetch;

      // Act
      let browser: BrowserAutomation;
      try {
        browser = await pipeLauncher(root, chrome).launch({ width: 800, height: 600 });
      } finally {
        globalThis.fetch = realFetch;
      }
      opened.push(browser);
      const answered = await browser.navigate('p1', 'cdp-round-trip');

      // Assert — the worker's request reached Chrome and came back over the pipe, after the launch, so the
      // pipe runs from the worker to Chrome; and nothing was listening or probed on the way.
      should(decodeURIComponent(answered.url)).containEql('"chrome":"FakeChrome/150.0"');
      should(probed).deepEqual([]);
      const started = await readFile(`${chrome}.args`, 'utf8');
      should(started.split('\n')).containEql('--remote-debugging-pipe');
      should(started).not.match(/--remote-debugging-(?:port|address)/u);
    });

    it('should keep no end of the pipe itself, so Chrome sees it close when the worker holds none', async () => {
      // Arrange — an injected worker that never takes its ends, and a Chrome that quits on end-of-file the
      // way a real one does. Chrome can only read end-of-file if the DAEMON closed its own copies too: a
      // daemon that kept them would be a third holder of the protocol, and a Chrome that outlived its worker.
      const chrome = await fakeChrome({ quitsWhenPipeCloses: true });
      const root = await mkdtemp(join(tmpdir(), 'ferretry-session-profile-'));
      roots.push(root);
      const launcher = new NodeSessionBrowserLauncher(
        new BrowserProfileStore(root),
        INJECTED_WORKER,
        process.execPath,
        environment(chrome),
        async () => ({ unexpectedExit: new Promise<number>(() => undefined), close: async () => undefined }) as never,
        PIPE,
      );
      const browser = await launcher.launch({ width: 800, height: 600 });
      opened.push(browser);
      const chromePid = await leasedChromePid(root);

      // Act — nothing here signals Chrome: it is the closed pipe alone that ends it.
      const code = await browser.unexpectedExit;

      // Assert
      should(code).equal(0);
      should(alive(chromePid)).be.false();
      should(await new BrowserProfileStore(root).acquire({ sessionId: 'again' })).have.property('sessionId', 'again');
    });

    it('should restart the browser when its worker crashes — a fresh Chrome, never a reattach', async () => {
      // Arrange — a real worker over a real pipe, and a Chrome that quits when the pipe closes.
      const chrome = await fakeChrome({ quitsWhenPipeCloses: true });
      const root = await mkdtemp(join(tmpdir(), 'ferretry-session-profile-'));
      roots.push(root);
      const workers: BrowserWorkerClient[] = [];
      const launcher = pipeLauncher(root, chrome, workers);
      const first = await launcher.launch({ width: 800, height: 600 });
      opened.push(first);
      const firstChrome = await leasedChromePid(root);

      // Act — the worker dies without a word: the only end of the pipe besides Chrome's goes with it.
      process.kill((workers[0] as BrowserWorkerClient).pid, 'SIGKILL');
      await first.unexpectedExit;
      const second = await launcher.launch({ width: 800, height: 600 });
      opened.push(second);

      // Assert — the first pair is gone and the profile was freed for the second, which is a new Chrome
      // and a new worker that answer over a new pipe.
      should(alive(firstChrome)).be.false();
      should(alive((workers[0] as BrowserWorkerClient).pid)).be.false();
      const secondChrome = await leasedChromePid(root);
      should(secondChrome).not.equal(firstChrome);
      should(workers).have.length(2);
      const answered = await second.navigate('p1', 'cdp-round-trip');
      should(decodeURIComponent(answered.url)).containEql('"chrome":"FakeChrome/150.0"');
    });
  });

  it('should refuse a missing worker with its remedy before it leases the profile or starts Chrome', async () => {
    // Arrange — a compiled daemon with no worker beside it: the composition root resolves `missing`.
    const chrome = await fakeChrome();
    const root = await mkdtemp(join(tmpdir(), 'ferretry-session-profile-'));
    roots.push(root);
    const message = 'this install has no browser worker; reinstall Ferretry';
    const launcher = new NodeSessionBrowserLauncher(
      new BrowserProfileStore(root),
      { kind: 'missing', message },
      process.execPath,
      environment(chrome),
      async () => {
        throw new Error('no worker may be connected when none exists');
      },
    );

    // Act
    const launched = launcher.launch({ width: 800, height: 600 });

    // Assert — the refusal is the plain sentence, and nothing was leased on the way to it.
    await should(launched).be.rejectedWith(message);
    should(await new BrowserProfileStore(root).acquire({ sessionId: 'next' })).have.property('sessionId', 'next');
  });

  it('should run a compiled worker directly, and Chrome headless on every platform — even with a display', async () => {
    // Arrange — a Chrome stand-in that records the arguments it was started with.
    const chrome = await fakeChrome({ recordArguments: true });
    const root = await mkdtemp(join(tmpdir(), 'ferretry-session-profile-'));
    roots.push(root);
    const connected: { workerEntry: string; workerExecutable?: boolean }[] = [];
    const worker = { unexpectedExit: new Promise<number>(() => undefined), close: async () => undefined };
    const launcher = new NodeSessionBrowserLauncher(
      new BrowserProfileStore(root),
      { kind: 'executable', path: '/opt/ferretry/fyd-browser-worker' },
      process.execPath,
      // A display IS available: the agent browser is headless anyway, so every window keeps painting.
      { FY_CHROME_BIN: chrome, DISPLAY: ':99', PATH: process.env.PATH, HOME: process.env.HOME },
      async options => {
        connected.push({ workerEntry: options.workerEntry, workerExecutable: options.workerExecutable });
        return worker as never;
      },
    );

    // Act
    const browser = await launcher.launch({ width: 800, height: 600 });
    opened.push(browser);

    // Assert
    should(connected).deepEqual([{ workerEntry: '/opt/ferretry/fyd-browser-worker', workerExecutable: true }]);
    const started = await readFile(`${chrome}.args`, 'utf8');
    should(started).containEql('--headless=new');
    should(started).not.containEql('--ozone-platform=x11');
    // The debugging port takes no cross-origin WebSocket: only the worker, which sends no Origin.
    should(started).not.containEql('--remote-allow-origins');
  });

  describe('Browser ports', () => {
    /** A loopback port nobody holds right now, taken the way the launcher's own `freePort` does. */
    async function spare(): Promise<number> {
      const held = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: () => undefined } });
      const port = held.port;
      held.stop(true);
      return port;
    }

    async function launchWith(
      ports: SessionBrowserModeOptions['ports'],
      proxy?: ResolvedBrowserProxy,
    ): Promise<{ readonly root: string; readonly started: string }> {
      const chrome = await fakeChrome({ recordArguments: true });
      const root = await mkdtemp(join(tmpdir(), 'ferretry-session-profile-'));
      roots.push(root);
      const worker = { unexpectedExit: new Promise<number>(() => undefined), close: async () => undefined };
      const launcher = new NodeSessionBrowserLauncher(
        new BrowserProfileStore(root),
        INJECTED_WORKER,
        process.execPath,
        environment(chrome),
        async () => worker as never,
        { ...PORT, ports, proxy: async () => proxy },
      );
      const browser = await launcher.launch({ width: 800, height: 600 });
      opened.push(browser);
      return { root, started: await readFile(`${chrome}.args`, 'utf8') };
    }

    it('should start Chrome on the DevTools port the setting names', async () => {
      const cdp = await spare();
      const { started } = await launchWith(async () => ({
        kind: 'fixed',
        ports: { cdp, relay: cdp + 1, vnc: cdp + 2 },
      }));
      should(started).containEql(`--remote-debugging-port=${cdp}\n`);
    });

    it('should open the proxy sign-in relay on the relay port the setting names', async () => {
      const relay = await spare();
      const { started } = await launchWith(
        async () => ({ kind: 'fixed', ports: { cdp: await spare(), relay, vnc: relay + 1 } }),
        {
          setting: { url: 'http://proxy.example.test:8080', bypass: [], username: 'u', password: 'p' },
          credentials: { username: 'a-user', password: 'a-password' },
        },
      );
      should(started).containEql(`--proxy-server=http://127.0.0.1:${relay}\n`);
    });

    it('should pick free ports as it always did when the setting is random or unreadable here', async () => {
      const random = await launchWith(async () => ({ kind: 'random' }));
      const absent = await launchWith(undefined);
      should(random.started).match(/--remote-debugging-port=\d+\n/u);
      should(absent.started).match(/--remote-debugging-port=\d+\n/u);
    });

    it('should ask the firewall check before a start on fixed ports, and go ahead when it cannot answer', async () => {
      const cdp = await spare();
      let asked = 0;
      const fixed = async () => ({ kind: 'fixed' as const, ports: { cdp, relay: cdp + 1, vnc: cdp + 2 } });
      const started = async (checkFirewall: () => Promise<string | undefined>) => {
        const chrome = await fakeChrome();
        const root = await mkdtemp(join(tmpdir(), 'ferretry-session-profile-'));
        roots.push(root);
        const worker = { unexpectedExit: new Promise<number>(() => undefined), close: async () => undefined };
        const launcher = new NodeSessionBrowserLauncher(
          new BrowserProfileStore(root),
          INJECTED_WORKER,
          process.execPath,
          environment(chrome),
          async () => worker as never,
          { ...PORT, ports: fixed, checkFirewall },
        );
        opened.push(await launcher.launch({ width: 800, height: 600 }));
      };
      await started(async () => {
        asked += 1;
        return undefined;
      });
      should(asked).equal(1);
      await started(async () => {
        throw new Error('the marker is unreadable');
      });
    });

    it('should refuse a start on fixed ports with the sentence the firewall check gives, before taking the profile', async () => {
      const cdp = await spare();
      const root = await mkdtemp(join(tmpdir(), 'ferretry-session-profile-'));
      roots.push(root);
      const launcher = new NodeSessionBrowserLauncher(
        new BrowserProfileStore(root),
        INJECTED_WORKER,
        process.execPath,
        environment(await fakeChrome()),
        async () => {
          throw new Error('no worker should start');
        },
        {
          ...PORT,
          ports: async () => ({ kind: 'fixed', ports: { cdp, relay: cdp + 1, vnc: cdp + 2 } }),
          checkFirewall: async () => 'the browser was not started because the loopback firewall failed its check',
        },
      );
      const refused = await launcher.launch({ width: 800, height: 600 }).catch((error: unknown) => error);
      should(refused).instanceOf(BrowserControlError);
      should((refused as Error).message).equal(
        'the browser was not started because the loopback firewall failed its check',
      );
      should(await new BrowserProfileStore(root).acquire({ sessionId: 'after' })).have.property('sessionId', 'after');
    });

    it('should not ask the firewall check about a start on random ports', async () => {
      let asked = 0;
      const chrome = await fakeChrome();
      const root = await mkdtemp(join(tmpdir(), 'ferretry-session-profile-'));
      roots.push(root);
      const worker = { unexpectedExit: new Promise<number>(() => undefined), close: async () => undefined };
      const launcher = new NodeSessionBrowserLauncher(
        new BrowserProfileStore(root),
        INJECTED_WORKER,
        process.execPath,
        environment(chrome),
        async () => worker as never,
        {
          ...PORT,
          ports: async () => ({ kind: 'random' }),
          checkFirewall: async () => {
            asked += 1;
            return 'refused';
          },
        },
      );
      opened.push(await launcher.launch({ width: 800, height: 600 }));
      should(asked).equal(0);
    });

    it('should refuse the launch with the reason, rather than quietly falling back to a random port', async () => {
      const root = await mkdtemp(join(tmpdir(), 'ferretry-session-profile-'));
      roots.push(root);
      const launcher = new NodeSessionBrowserLauncher(
        new BrowserProfileStore(root),
        INJECTED_WORKER,
        process.execPath,
        environment(await fakeChrome()),
        async () => {
          throw new Error('no worker should start');
        },
        { ...PORT, ports: async () => ({ kind: 'refused', reason: 'uid 999 gets ports outside 1024–32767' }) },
      );
      const refused = await launcher.launch({ width: 800, height: 600 }).catch((error: unknown) => error);
      should(refused).instanceOf(BrowserControlError);
      should((refused as Error).message).equal('uid 999 gets ports outside 1024–32767');
      should(await new BrowserProfileStore(root).acquire({ sessionId: 'after' })).have.property('sessionId', 'after');
    });
  });

  describe('Browser proxy and user agent', () => {
    async function launchWith(
      proxy: ResolvedBrowserProxy | undefined,
    ): Promise<{ readonly browser: BrowserAutomation; readonly started: string }> {
      const chrome = await fakeChrome({ recordArguments: true, version: '150.0.7000.1' });
      const root = await mkdtemp(join(tmpdir(), 'ferretry-session-profile-'));
      roots.push(root);
      const worker = { unexpectedExit: new Promise<number>(() => undefined), close: async () => undefined };
      const launcher = new NodeSessionBrowserLauncher(
        new BrowserProfileStore(root),
        INJECTED_WORKER,
        process.execPath,
        environment(chrome),
        async () => worker as never,
        { platform: 'linux', proxy: async () => proxy },
      );
      const browser = await launcher.launch({ width: 800, height: 600 });
      opened.push(browser);
      return { browser, started: await readFile(`${chrome}.args`, 'utf8') };
    }

    it('should send the honest user agent and no proxy switches when no proxy is set', async () => {
      const { browser, started } = await launchWith(undefined);
      should(started).containEql('--user-agent=Mozilla/5.0 (');
      should(started).containEql('Chrome/150.0.0.0 Safari/537.36');
      should(started).not.containEql('HeadlessChrome');
      should(started).not.containEql('--proxy-server');
      should(browser.proxy).be.undefined();
    });

    it('should point Chrome straight at a proxy that needs no sign-in', async () => {
      const { browser, started } = await launchWith({
        setting: { url: 'socks5://proxy.example.test:1080', bypass: ['*.internal.example.test', '<local>'] },
      });
      should(started).containEql('--proxy-server=socks5://proxy.example.test:1080');
      should(started).containEql('--proxy-bypass-list=*.internal.example.test;<local>');
      should(started).containEql('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
      should(browser.proxy).eql({ url: 'socks5://proxy.example.test:1080', authenticated: false, bypassCount: 2 });
    });

    it('should point Chrome at the loopback sign-in relay, never at the proxy or its credentials', async () => {
      const { browser, started } = await launchWith({
        setting: {
          url: 'http://proxy.example.test:8080',
          bypass: [],
          username: '${secret:PROXY_USER}',
          password: '${secret:PROXY_PASSWORD}',
        },
        credentials: { username: 'a-user', password: 'a-password' },
      });
      should(started).match(/--proxy-server=http:\/\/127\.0\.0\.1:\d+\n/u);
      should(started).not.containEql('proxy.example.test');
      should(started).not.containEql('a-user');
      should(started).not.containEql('a-password');
      should(browser.proxy).eql({ url: 'http://proxy.example.test:8080', authenticated: true, bypassCount: 0 });
    });
  });

  describe('Browser mode', () => {
    /** A launcher over a recording fake Chrome, in the given mode, with an injected worker. */
    async function modeLauncher(modes: ConstructorParameters<typeof NodeSessionBrowserLauncher>[5]) {
      const chrome = await fakeChrome({ recordArguments: true });
      const root = await mkdtemp(join(tmpdir(), 'ferretry-session-profile-'));
      roots.push(root);
      const worker = { unexpectedExit: new Promise<number>(() => undefined), close: async () => undefined };
      const launcher = new NodeSessionBrowserLauncher(
        new BrowserProfileStore(root),
        INJECTED_WORKER,
        process.execPath,
        // The host's own DISPLAY is set, and must never be what a real window draws on.
        environment(chrome),
        async () => worker as never,
        modes,
      );
      return { chrome, root, launcher };
    }
    const keptPainting = ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'];
    const display = (name: string) => ({
      taken: 0,
      async display() {
        this.taken += 1;
        return name;
      },
      authority: () => '/state/x11/xauthority-test',
      close: async () => undefined,
    });

    it('should run a Linux real window headed, on its own private display, with no automation switch', async () => {
      // Arrange
      const xvfb = display(':42');
      const { chrome, launcher } = await modeLauncher({ mode: async () => 'window', display: xvfb, platform: 'linux' });

      // Act
      const browser = await launcher.launch({ width: 800, height: 600 });
      opened.push(browser);

      // Assert
      const started = await readFile(`${chrome}.args`, 'utf8');
      should(started).not.containEql('--headless');
      should(started).containEql('--ozone-platform=x11');
      for (const flag of keptPainting) should(started).containEql(flag);
      should(started).not.match(/automation/i);
      should(started).containEql('--remote-debugging-address=127.0.0.1');
      should((await readFile(`${chrome}.display`, 'utf8')).trim()).equal(':42');
      // The private display refuses a client without its cookie, so the window's Chrome carries the file.
      should((await readFile(`${chrome}.xauthority`, 'utf8')).trim()).equal('/state/x11/xauthority-test');
      should(xvfb.taken).equal(1);
    });

    it('should open a macOS real window on the desktop, taking no private display', async () => {
      // Arrange
      const xvfb = display(':42');
      const { chrome, launcher } = await modeLauncher({
        mode: async () => 'window',
        display: xvfb,
        platform: 'darwin',
      });

      // Act
      const browser = await launcher.launch({ width: 800, height: 600 });
      opened.push(browser);

      // Assert
      const started = await readFile(`${chrome}.args`, 'utf8');
      should(started).not.containEql('--headless');
      should(started).not.containEql('--ozone-platform=x11');
      for (const flag of keptPainting) should(started).containEql(flag);
      should((await readFile(`${chrome}.display`, 'utf8')).trim()).equal('unset');
      should((await readFile(`${chrome}.xauthority`, 'utf8')).trim()).equal('unset');
      should(xvfb.taken).equal(0);
    });

    it('should run headless, taking no display, when the mode says so or cannot be read', async () => {
      for (const mode of [async () => 'headless' as const, async () => Promise.reject(new Error('unreadable'))]) {
        // Arrange
        const xvfb = display(':42');
        const { chrome, launcher } = await modeLauncher({ mode, display: xvfb, platform: 'linux' });

        // Act
        const browser = await launcher.launch({ width: 800, height: 600 });
        opened.push(browser);

        // Assert
        const started = await readFile(`${chrome}.args`, 'utf8');
        should(started).containEql('--headless=new');
        should(started).not.containEql('--disable-renderer-backgrounding');
        should((await readFile(`${chrome}.display`, 'utf8')).trim()).equal('unset');
        should((await readFile(`${chrome}.xauthority`, 'utf8')).trim()).equal('unset');
        should(xvfb.taken).equal(0);
        await browser.close();
      }
    });

    it('should refuse a Linux real window with no display BEFORE leasing the profile', async () => {
      // Arrange
      const missing = {
        display: async (): Promise<string> => {
          throw new Error('Browser mode is Real window, which needs Xvfb on Linux and this host has none');
        },
        authority: () => undefined,
        close: async () => undefined,
      };
      const withoutXvfb = await modeLauncher({ mode: async () => 'window', display: missing, platform: 'linux' });
      const withoutDisplay = await modeLauncher({ mode: async () => 'window', platform: 'linux' });

      // Act + Assert — the refusal names the fix, and the profile is still free for the next launch.
      await should(withoutXvfb.launcher.launch({ width: 800, height: 600 })).be.rejectedWith(/needs Xvfb/);
      await should(withoutDisplay.launcher.launch({ width: 800, height: 600 })).be.rejectedWith(
        'this daemon has no private display for a real browser window',
      );
      for (const { root } of [withoutXvfb, withoutDisplay])
        should(await new BrowserProfileStore(root).acquire({ sessionId: 'next' })).have.property('sessionId', 'next');
    });
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
    const browser = await launcher.launch({ width: 800, height: 600 });
    opened.push(browser);
    const frames: BrowserScreencastFrame[] = [];

    // Act — `emit-frames` is the fixture's instruction to publish frames while replying.
    const listener = (frame: BrowserScreencastFrame): number => frames.push(frame);
    await browser.startScreencast('p1', { width: 800, height: 600 }, listener);
    await browser.navigate('p1', 'emit-frames');
    await browser.stopScreencast('p1', listener);

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
      SHORT_SHUTDOWN,
    );
    const browser = await launcher.launch({ width: 800, height: 600 });
    opened.push(browser);
    const chromePid = await leasedChromePid(root);
    should(alive(chromePid)).be.true();

    // Act — `crashes` is the fixture's instruction to exit mid-request. The worker dies with Chrome
    // still up: the case a race between the two children silently loses, because the worker settling
    // first was treated as the whole browser being gone.
    await browser.navigate('p1', 'crashes').catch(() => undefined);
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
    const browser = await launcher.launch({ width: 800, height: 600 });
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
      SHORT_SHUTDOWN,
    );
    const browser = await launcher.launch({ width: 800, height: 600 });
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
    await should(launcher.launch({ width: 800, height: 600 })).be.rejectedWith(/the worker refused to connect/u);

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
      INJECTED_WORKER,
      process.execPath,
      environment(chrome),
      async () => worker as never,
    );
    const browser = await launcher.launch({ width: 800, height: 600 });
    opened.push(browser);
    const chromePid = await leasedChromePid(root);

    // Act — close reports no failure: there is nobody to report it to, and the lease IS the report.
    await browser.close();

    // Assert — Chrome is still reaped, because an unkillable worker is no reason to leave a browser
    // up, and the profile stays leased to the session whose worker could not be accounted for.
    should(alive(chromePid)).be.false();
    await should(new BrowserProfileStore(root).acquire({ sessionId: 'again' })).be.rejectedWith(
      /leased by session agent-browser/u,
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
      INJECTED_WORKER,
      process.execPath,
      environment(chrome),
      async () => worker as never,
    );
    const browser = await launcher.launch({ width: 800, height: 600 });
    opened.push(browser);
    const first = await leasedChromePid(root);
    await browser.close();

    // Act — the same launcher, the same external session id, exactly as `ensure()` would retry it.
    const retry = launcher.launch({ width: 800, height: 600 });
    // Registered BEFORE it is judged: a red run must not leak the Chrome an unexpected success starts.
    await retry.then(opened.push.bind(opened), () => undefined);

    // Assert — refused, and the retained record still names the ORIGINAL Chrome. A retry that got
    // through would report a different, live pid here even where the refusal assertion was loosened.
    await should(retry).be.rejectedWith(/leased by session agent-browser/u);
    should(await leasedChromePid(root)).equal(first);
  });

  it('should say why Chrome did not start when it exits before its worker attaches', async () => {
    // Arrange — a Chrome that answers --version, then dies saying why on stderr.
    const root = await mkdtemp(join(tmpdir(), 'ferretry-session-profile-'));
    roots.push(root);
    const chromeDir = await mkdtemp(join(tmpdir(), 'ferretry-session-browser-'));
    roots.push(chromeDir);
    const chrome = join(chromeDir, 'chrome');
    await writeFile(
      chrome,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'Google Chrome 150.0'; exit 0; fi
echo 'Failed to move to new namespace' >&2
exit 7
`,
    );
    await chmod(chrome, 0o700);
    const launcher = new NodeSessionBrowserLauncher(
      new BrowserProfileStore(root),
      INJECTED_WORKER,
      process.execPath,
      environment(chrome),
      // What a real worker reports when the Chrome it was handed closed the pipe under it.
      async () => {
        throw new BrowserTransportError('launch_failed', 'browser worker failed: Chrome closed its DevTools pipe', 503);
      },
      PIPE,
    );

    // Act + Assert — Chrome's own words, not the worker's echo of them.
    await should(launcher.launch({ width: 800, height: 600 })).be.rejectedWith(
      /^Chrome exited with code 7 before its worker could attach: Failed to move to new namespace$/u,
    );
    should(await new BrowserProfileStore(root).acquire({ sessionId: 'again' })).have.property('sessionId', 'again');
  });

  it('should say why Chrome did not start when it exits before exposing its debugging port', async () => {
    // Arrange — a Chrome that answers --version, then dies saying why on stderr.
    const root = await mkdtemp(join(tmpdir(), 'ferretry-session-profile-'));
    roots.push(root);
    const chromeDir = await mkdtemp(join(tmpdir(), 'ferretry-session-browser-'));
    roots.push(chromeDir);
    const chrome = join(chromeDir, 'chrome');
    await writeFile(
      chrome,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'Google Chrome 150.0'; exit 0; fi
echo 'Failed to move to new namespace' >&2
exit 7
`,
    );
    await chmod(chrome, 0o700);
    const launcher = new NodeSessionBrowserLauncher(
      new BrowserProfileStore(root),
      INJECTED_WORKER,
      process.execPath,
      environment(chrome),
      async () => {
        throw new Error('the worker must not be reached');
      },
      PORT,
    );

    // Act + Assert
    await should(launcher.launch({ width: 800, height: 600 })).be.rejectedWith(
      /debugging endpoint \(Chrome exited with code 7\): Failed to move to new namespace/u,
    );
  });

  describe('when the OS misreports the Chrome it started', () => {
    const realSpawn = Bun.spawn;
    afterEach(() => {
      Bun.spawn = realSpawn;
    });

    /** Wraps only the Chrome the launcher starts (never its `--version` probe) so one of its handles misbehaves. */
    function misbehavingChrome(chrome: string, misbehave: (process: ReturnType<typeof Bun.spawn>) => object): void {
      Bun.spawn = ((options: { cmd: string[] }) => {
        const started = (realSpawn as (options: unknown) => ReturnType<typeof Bun.spawn>)(options);
        if (options.cmd[0] !== chrome || options.cmd.includes('--version')) return started;
        const overrides = misbehave(started) as Record<PropertyKey, unknown>;
        return new Proxy(started, {
          get: (target, property) => {
            if (property in overrides) return overrides[property];
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      }) as typeof Bun.spawn;
    }

    it('should still reap Chrome and free the profile when signalling it throws', async () => {
      // Arrange: the signal lands, then the call throws — the way a kill racing the child's exit can.
      const chrome = await fakeChrome();
      const root = await mkdtemp(join(tmpdir(), 'ferretry-session-profile-'));
      roots.push(root);
      misbehavingChrome(chrome, started => ({
        kill: (signal?: NodeJS.Signals) => {
          started.kill(signal);
          throw new Error('kill raced the exit');
        },
      }));
      let chromePid = 0;
      const launcher = new NodeSessionBrowserLauncher(
        new BrowserProfileStore(root),
        INJECTED_WORKER,
        process.execPath,
        environment(chrome),
        async () => {
          chromePid = await leasedChromePid(root);
          throw new Error('the worker refused to connect');
        },
      );

      // Act
      await should(launcher.launch({ width: 800, height: 600 })).be.rejectedWith(/the worker refused to connect/u);

      // Assert: the launch failure is the one reported, and the throwing signal did not keep the lease.
      should(alive(chromePid)).be.false();
      should(await new BrowserProfileStore(root).acquire({ sessionId: 'again' })).have.property('sessionId', 'again');
    });

    it('should launch and close normally when the Chrome stderr pipe breaks', async () => {
      // Arrange: the diagnostics drain is best effort, so a pipe that errors must not cost the launch.
      const chrome = await fakeChrome();
      const root = await mkdtemp(join(tmpdir(), 'ferretry-session-profile-'));
      roots.push(root);
      misbehavingChrome(chrome, () => ({
        stderr: new ReadableStream<Uint8Array>({ start: controller => controller.error(new Error('pipe broke')) }),
      }));
      const launcher = new NodeSessionBrowserLauncher(
        new BrowserProfileStore(root),
        INJECTED_WORKER,
        process.execPath,
        environment(chrome),
        async () => ({ unexpectedExit: new Promise<number>(() => undefined), close: async () => undefined }) as never,
      );

      // Act
      const browser = await launcher.launch({ width: 800, height: 600 });
      opened.push(browser);
      await browser.close();

      // Assert
      should(await new BrowserProfileStore(root).acquire({ sessionId: 'again' })).have.property('sessionId', 'again');
    });
  });
});
