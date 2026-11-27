import { afterAll, beforeAll, describe, it } from 'bun:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import type { BrowserScreencastFrame } from '../../../contract/wire/browser.ts';
import type { ResolvedBrowserProxy } from '../../../daemon/proxy/index.ts';
import { IdentityBrowsers } from '../../../daemon/pages/identities.ts';
import { BrowserSessionService } from '../../../daemon/pages/service.ts';
import { XvfbDisplay } from '../../../daemon/worker/control/adapters/login-runtime.ts';
import { BrowserProfileStore } from '../../../daemon/worker/control/adapters/profile-store.ts';
import { NodeSessionBrowserLauncher } from '../../../daemon/worker/launcher.ts';
import { unprovenListenerProver } from '../../support/listener-prover.ts';
import { launcherPorts, loginProcesses, REAL_WORKER } from '../../support/process-workers.ts';
import { waitFor } from '../../support/wait-for.ts';

/**
 * ONE CHROME PER IDENTITY, IN PARALLEL, AGAINST REAL CHROMES (G4 U2).
 *
 * Everything is production — the launcher, a worker process per Chrome, one service per identity behind the router the
 * daemon half builds — and Chrome is the real one the int tier already runs. The properties are the ones only real
 * browsers can show: that two identities hold two profiles (a cookie one sets the other never sees), that both are
 * driven at once without a click lost, that each screen streams its own frames, that one Chrome dying leaves the other's
 * pages live, that the proxy and its sign-in relay are each identity's own, and (on a real Xvfb) that a window identity
 * draws on a display of its own that goes with its Chrome. Every port is on loopback in 7480-7499.
 */

const chrome = Bun.which('google-chrome') ?? Bun.which('chromium');
const xvfb = Bun.which('Xvfb');
const WORKERS = REAL_WORKER();
const sessions = new Set(['s1', 's2', 's3']);

let nextTestPort = Math.floor(Math.random() * 20);
/** Probe different ports for concurrent launches in this file; retry occupied ports within the test range. */
async function inRange<T>(bind: (port: number) => Promise<T> | T): Promise<T> {
  for (let step = 0; step < 20; step += 1) {
    try {
      return await bind(7480 + (nextTestPort++ % 20));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' && !String(error).includes('EADDRINUSE')) throw error;
    }
  }
  throw new Error('no free port in 7480-7499');
}

const freeRangePort = async (): Promise<number> =>
  await inRange(
    port =>
      new Promise<number>((resolve, reject) => {
        const probe = createServer();
        probe.once('error', reject);
        probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(port)));
      }),
  );

/** A loopback HTTP proxy that answers every plain request itself, naming who answered and the sign-in it was shown. */
async function fakeProxy(name: string) {
  const seen: { readonly line: string; readonly authorization: string | undefined }[] = [];
  const server: Server = createServer(client => {
    client.once('data', head => {
      const text = head.toString('latin1');
      const lines = text.split('\r\n');
      const authorization = lines.find(line => /^proxy-authorization:/iu.test(line))?.split(': ')[1];
      seen.push({ line: lines[0] ?? '', authorization });
      const body = `<html><body><p id="c">answered-by:${name}</p></body></html>`;
      client.end(
        `HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: ${String(body.length)}\r\nconnection: close\r\n\r\n${body}`,
      );
    });
    client.on('error', () => undefined);
  });
  const port = await inRange(
    bound =>
      new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(bound, '127.0.0.1', () => resolve(bound));
      }),
  );
  return { port, seen, stop: () => server.close() };
}

/** The page every case drives: sets a cookie on request, counts clicks into `#c`, and shows the cookie the server saw. */
const SITE = (request: Request): Response => {
  const url = new URL(request.url);
  const headers: Record<string, string> = { 'content-type': 'text/html' };
  if (url.pathname === '/mask') {
    const value = url.searchParams.get('v') === 'one' ? 'synthetic-native-one-3198' : 'synthetic-native-two-7526';
    return new Response(
      `<html><body><input type="password" value="${value}"><p id="c">${value} ordinary-readable</p></body></html>`,
      { headers },
    );
  }
  if (url.pathname === '/set') headers['set-cookie'] = `who=${url.searchParams.get('v') ?? ''}; Path=/`;
  if (url.pathname === '/count')
    return new Response(
      '<html><head><style>@keyframes pulse{to{background-color:#f0f0ff}}body{animation:pulse .2s infinite alternate}</style></head><body><button id="b" onclick="window.n=(window.n||0)+1;document.getElementById(\'c\').textContent=\'n:\'+window.n">tap</button><p id="c">n:0</p></body></html>',
      { headers },
    );
  return new Response(`<html><body><p id="c">cookie:${request.headers.get('cookie') ?? ''}</p></body></html>`, {
    headers,
  });
};

let root = '';
let site: ReturnType<typeof Bun.serve>;
let base = '';
let maxRunning = 4;
let mode: 'headless' | 'window' = 'headless';
const proxies = new Map<string, ResolvedBrowserProxy>();
const windowDisplays: { readonly identity: string; readonly display: XvfbDisplay }[] = [];
let pages: IdentityBrowsers;
let launcher: NodeSessionBrowserLauncher;

const textOf = async (sessionId: string, page: string): Promise<string> => {
  const read = await pages.actOnPage(sessionId, page, { action: 'read', selector: '#c' });
  return 'result' in read && 'text' in read.result ? String(read.result.text) : '';
};

/** Every process under `pid` (itself included), from `/proc`: the browser as the operating system counts it. */
async function tree(pid: number): Promise<readonly number[]> {
  const children = new Map<number, number[]>();
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/u.test(entry)) continue;
    const stat = await readFile(`/proc/${entry}/stat`, 'utf8').catch(() => '');
    const parent = Number(/^\d+ \(.*\) \S (\d+)/u.exec(stat)?.[1] ?? Number.NaN);
    if (!Number.isNaN(parent)) children.set(parent, [...(children.get(parent) ?? []), Number(entry)]);
  }
  const found: number[] = [];
  const walk = (current: number): void => {
    found.push(current);
    for (const child of children.get(current) ?? []) walk(child);
  };
  walk(pid);
  return found;
}

/** What a set of processes holds in RAM, in KiB: RSS (shared pages counted in every process) and PSS (shared pages split between their users, so the sum is what the machine really spends). */
async function memoryKiB(pids: readonly number[]): Promise<{ readonly rss: number; readonly pss: number }> {
  let rss = 0;
  let pss = 0;
  for (const pid of pids) {
    const status = await readFile(`/proc/${String(pid)}/status`, 'utf8').catch(() => '');
    rss += Number(/VmRSS:\s+(\d+) kB/u.exec(status)?.[1] ?? 0);
    const rollup = await readFile(`/proc/${String(pid)}/smaps_rollup`, 'utf8').catch(() => '');
    pss += Number(/Pss:\s+(\d+) kB/u.exec(rollup)?.[1] ?? 0);
  }
  return { rss, pss };
}

const mib = (kib: number): string => String(Math.round(kib / 1024));

/** One line for the PR: each identity's and the pair's memory, by both counts. */
function memoryLine(
  label: string,
  names: readonly string[],
  sizes: readonly { readonly rss: number; readonly pss: number }[],
): string {
  const rss = sizes.reduce((sum, each) => sum + each.rss, 0);
  const pss = sizes.reduce((sum, each) => sum + each.pss, 0);
  return `MEMORY ${label}, ${String(names.length)} identities: ${names.map((name, index) => `${name}=${mib(sizes[index]?.rss ?? 0)} MiB RSS / ${mib(sizes[index]?.pss ?? 0)} MiB PSS`).join(' ')} total=${mib(rss)} MiB RSS / ${mib(pss)} MiB PSS`;
}

/** The pid of one identity's Chrome: the process that holds its profile folder and is no child process of Chrome's own. */
async function chromePid(identity: string, profileRoot = root): Promise<number> {
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/u.test(entry)) continue;
    const command = (await readFile(`/proc/${entry}/cmdline`, 'utf8').catch(() => '')).split('\0');
    if (
      command.includes(`--user-data-dir=${join(profileRoot, 'data', identity)}`) &&
      !command.some(arg => arg.startsWith('--type='))
    )
      return Number(entry);
  }
  throw new Error(`no Chrome is running for the ${identity} identity`);
}

describe.if(process.platform === 'linux')('one Chrome per identity, in parallel, in real Chromes', () => {
  beforeAll(async () => {
    if (chrome === null) throw new Error('this test needs a real Chrome on PATH (the dev shell has it)');
    root = await mkdtemp(join(tmpdir(), 'ferretry-identities-'));
    site = await inRange(port => Bun.serve({ port, hostname: '127.0.0.1', fetch: SITE }));
    base = `http://127.0.0.1:${String(site.port)}`;
    launcher = new NodeSessionBrowserLauncher(
      new BrowserProfileStore(root),
      WORKERS.start,
      launcherPorts(),
      {
        FY_CHROME_BIN: chrome,
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        FONTCONFIG_FILE: process.env.FONTCONFIG_FILE,
      },
      undefined,
      {
        stageDirectory: join(root, 'stage'),
        listenerProver: unprovenListenerProver(),
        mode: async () => mode,
        cdpPort: freeRangePort,
        proxy: async identity => proxies.get(identity),
        // A window identity draws on an X server of its own, taken with it and closed with its Chrome.
        identityDisplay: identity => {
          const display = new XvfbDisplay({
            executable: () => xvfb ?? undefined,
            authorityDirectory: join(root, 'display'),
            processes: loginProcesses(),
          });
          windowDisplays.push({ identity, display });
          return display;
        },
        display: new XvfbDisplay({
          executable: () => xvfb ?? undefined,
          authorityDirectory: join(root, 'display'),
          processes: loginProcesses(),
        }),
      },
    );
    pages = new IdentityBrowsers({
      maxRunning: () => maxRunning,
      make: (identity, quota) =>
        new BrowserSessionService(
          { get: async id => (sessions.has(id) ? {} : undefined) },
          launcher,
          () => Date.now(),
          undefined,
          undefined,
          undefined,
          identity,
          quota,
        ),
    });
  }, 60_000);

  afterAll(async () => {
    await pages?.closeAll();
    site?.stop(true);
    if (root !== '') await rm(root, { recursive: true, force: true });
  });

  it('should keep two identities’ cookies apart, drive both at once without losing a click, and stream each its own frames', async () => {
    // Arrange — two sessions, two identities, opened at the same moment.
    const [one, two] = await Promise.all([
      pages.openPage('s1', 'site', { identity: 'one', url: `${base}/set?v=one` }),
      pages.openPage('s2', 'site', { identity: 'two', url: `${base}/set?v=two` }),
    ]);

    // Act — each reads back the cookie its own server saw.
    await Promise.all([
      pages.actOnPage('s1', 'site', { action: 'navigate', url: `${base}/read` }),
      pages.actOnPage('s2', 'site', { action: 'navigate', url: `${base}/read` }),
    ]);
    const [seenByOne, seenByTwo] = await Promise.all([textOf('s1', 'site'), textOf('s2', 'site')]);

    // Assert — each identity holds only its own cookie.
    should(seenByOne).equal('cookie:who=one');
    should(seenByTwo).equal('cookie:who=two');
    should(one.id).not.equal(two.id);

    // Act — 100 clicks per identity, interleaved, all in flight together.
    await Promise.all([
      pages.actOnPage('s1', 'site', { action: 'navigate', url: `${base}/count` }),
      pages.actOnPage('s2', 'site', { action: 'navigate', url: `${base}/count` }),
    ]);
    const frames = new Map<string, BrowserScreencastFrame[]>([
      ['s1', []],
      ['s2', []],
    ]);
    const watching = await Promise.all(
      ['s1', 's2'].map(
        async id =>
          await pages.attachViewer(
            id,
            frame => frames.get(id)?.push(frame),
            () => undefined,
            'admin',
          ),
      ),
    );
    const clicks = Array.from({ length: 100 }, () => [
      pages.actOnPage('s1', 'site', { action: 'click', selector: '#b' }),
      pages.actOnPage('s2', 'site', { action: 'click', selector: '#b' }),
    ]).flat();
    await Promise.all(clicks);

    // Assert — none lost, and neither identity's clicks landed in the other's page.
    should(await textOf('s1', 'site')).equal('n:100');
    should(await textOf('s2', 'site')).equal('n:100');

    // Assert — each screen streamed frames of its own page and no other.
    await waitFor(
      () => (frames.get('s1')?.length ?? 0) > 0 && (frames.get('s2')?.length ?? 0) > 0,
      'a frame per screen',
    );
    should(new Set(frames.get('s1')?.map(frame => frame.pageId))).deepEqual(new Set([one.id]));
    should(new Set(frames.get('s2')?.map(frame => frame.pageId))).deepEqual(new Set([two.id]));
    for (const attachment of watching) attachment.detach();

    // Measure — what two live identities cost the machine, as the operating system counts it (written in the PR).
    const sizes = await Promise.all(
      ['one', 'two'].map(async identity => await memoryKiB(await tree(await chromePid(identity)))),
    );
    console.info(memoryLine('headless', ['one', 'two'], sizes));
  }, 120_000);

  it('should resolve a Chrome only inside the requested test profile root, even when another Chrome has the same identity', async () => {
    await pages.openPage('s1', 'pidcheck', { identity: 'one', url: `${base}/read` });
    const decoyRoot = await mkdtemp(join(tmpdir(), 'ferretry-identities-decoy-'));
    const decoy = new NodeSessionBrowserLauncher(
      new BrowserProfileStore(decoyRoot),
      WORKERS.start,
      launcherPorts(),
      {
        FY_CHROME_BIN: chrome ?? undefined,
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        FONTCONFIG_FILE: process.env.FONTCONFIG_FILE,
      },
      undefined,
      { listenerProver: unprovenListenerProver(), cdpPort: freeRangePort },
    );
    const browser = await decoy.launch({ width: 800, height: 600 }, 'one');
    try {
      const record = JSON.parse(await readFile(join(decoyRoot, 'profile.one.lock'), 'utf8')) as { chromePid: number };
      should(await chromePid('one', decoyRoot)).equal(record.chromePid);
      should(await chromePid('one')).not.equal(record.chromePid);
    } finally {
      await browser.close();
      await rm(decoyRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it('should attach only the Chrome that bound the port when two real launches are forced onto the same port', async () => {
    const collisionRoot = await mkdtemp(join(tmpdir(), 'ferretry-identities-collision-'));
    const port = await freeRangePort();
    const collision = new NodeSessionBrowserLauncher(
      new BrowserProfileStore(collisionRoot),
      WORKERS.start,
      launcherPorts(),
      {
        FY_CHROME_BIN: chrome ?? undefined,
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        FONTCONFIG_FILE: process.env.FONTCONFIG_FILE,
      },
      undefined,
      { listenerProver: unprovenListenerProver(), cdpPort: async () => port },
    );
    const results = await Promise.allSettled([
      collision.launch({ width: 800, height: 600 }, 'one'),
      collision.launch({ width: 800, height: 600 }, 'two'),
    ]);
    try {
      should(results.filter(result => result.status === 'fulfilled')).have.length(1);
    } finally {
      for (const result of results) if (result.status === 'fulfilled') await result.value.close();
      await rm(collisionRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it('should leave one identity’s pages live when the other identity’s Chrome is killed', async () => {
    // Act — identity one's Chrome is killed outright.
    process.kill(await chromePid('one'), 'SIGKILL');
    // Until the service learns its worker is gone, a read of that identity fails; the daemon half treats both as "gone".
    await waitFor(
      async () => (await pages.status('s1').catch(() => undefined))?.pages.length === 0,
      'identity one’s pages to be gone',
    );

    // Assert — identity two's page still answers and still counts.
    should(await textOf('s2', 'site')).equal('n:100');
    await pages.actOnPage('s2', 'site', { action: 'click', selector: '#b' });
    should(await textOf('s2', 'site')).equal('n:101');
    should((await pages.status('s2')).pages).have.length(1);
  }, 60_000);

  it('should refuse the identity past maxRunning with a sentence naming the running ones, and take it once one is gone', async () => {
    // Arrange — identity two is running; the cap is two.
    maxRunning = 2;
    await pages.openPage('s1', 'again', { identity: 'one', url: `${base}/read` });

    // Act
    const refused = await pages.openPage('s3', 'third', { identity: 'three', url: `${base}/read` }).then(
      () => undefined,
      (error: unknown) => error as Error,
    );

    // Assert
    should(refused?.message).match(/two, one|one, two/u);
    should(refused?.message).match(/at most 2/u);
    should([...pages.runningIdentities()].sort()).deepEqual(['one', 'two']);
    await pages.act('s1', { action: 'stop' });
    await pages.openPage('s3', 'third', { identity: 'three', url: `${base}/read` });
    should([...pages.runningIdentities()].sort()).deepEqual(['three', 'two']);
    maxRunning = 4;
  }, 90_000);

  it('should send each identity through its own proxy, and sign in only with its own credentials, through its own relay', async () => {
    // Arrange — one identity straight to the first fake proxy, the other to the second with a sign-in (so a relay).
    const first = await fakeProxy('alpha');
    const second = await fakeProxy('beta');
    proxies.set('plain', { setting: { url: `http://127.0.0.1:${String(first.port)}`, bypass: [] } });
    proxies.set('signed', {
      setting: {
        url: `http://127.0.0.1:${String(second.port)}`,
        bypass: [],
        username: '${secret:U}',
        password: '${secret:P}',
      },
      credentials: { username: 'beta-user', password: 'beta-pass' },
    });
    try {
      // Act — both open a site that only a proxy can answer.
      await Promise.all([
        pages.openPage('s1', 'viaplain', { identity: 'plain', url: 'http://one.upstream.test/' }),
        pages.openPage('s2', 'viasigned', { identity: 'signed', url: 'http://two.upstream.test/' }),
      ]);

      // Assert — each reached its own upstream, and only the relayed one carried a sign-in, which was its own.
      should(await textOf('s1', 'viaplain')).equal('answered-by:alpha');
      should(await textOf('s2', 'viasigned')).equal('answered-by:beta');
      should(first.seen.some(each => each.line.includes('one.upstream.test'))).be.true();
      should(first.seen.some(each => each.line.includes('two.upstream.test'))).be.false();
      should(second.seen.some(each => each.line.includes('two.upstream.test'))).be.true();
      should(second.seen.some(each => each.line.includes('one.upstream.test'))).be.false();
      should(first.seen.every(each => each.authorization === undefined)).be.true();
      should(second.seen.every(each => each.authorization === `Basic ${btoa('beta-user:beta-pass')}`)).be.true();
    } finally {
      first.stop();
      second.stop();
      await pages.closeAll();
    }
  }, 120_000);

  it.if(xvfb !== null)(
    'should draw a window identity on an X display of its own, and take the display away with its Chrome',
    async () => {
      // Arrange
      mode = 'window';
      const before = windowDisplays.length;

      // Act — two window identities at once.
      await Promise.all([
        pages.openPage('s1', 'w1', { identity: 'win1', url: `${base}/read` }),
        pages.openPage('s2', 'w2', { identity: 'win2', url: `${base}/read` }),
      ]);
      const displayOf = async (identity: string): Promise<string | undefined> =>
        (await readFile(`/proc/${String(await chromePid(identity))}/environ`, 'utf8'))
          .split('\0')
          .find(entry => entry.startsWith('DISPLAY='));
      const one = await displayOf('win1');
      const two = await displayOf('win2');
      const sizes = await Promise.all(
        ['win1', 'win2'].map(async identity => await memoryKiB(await tree(await chromePid(identity)))),
      );
      console.info(memoryLine('window (headful on Xvfb)', ['win1', 'win2'], sizes));

      // Assert — two displays, not one, and each belongs to one identity.
      should(windowDisplays.length - before).equal(2);
      should(one).not.be.undefined();
      should(two).not.be.undefined();
      should(one).not.equal(two);

      // Act — one identity stops.
      const taken = windowDisplays.slice(before).find(each => each.identity === 'win1');
      const xvfbPidsBefore = await xvfbPids();
      await pages.act('s1', { action: 'stop' });

      // Assert — its Xvfb went with its Chrome; the other identity's stays, and its page still answers.
      await waitFor(
        async () => (await xvfbPids()).length === xvfbPidsBefore.length - 1,
        'the stopped identity’s X server to exit',
      );
      should(taken).not.be.undefined();
      should(await textOf('s2', 'w2')).equal('cookie:');
      mode = 'headless';
    },
    120_000,
  );

  it.if(xvfb !== null)(
    'should finish shutdown during a real window launch with no Chrome or Xvfb left behind',
    async () => {
      await pages.closeAll();
      mode = 'window';
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const local = new IdentityBrowsers({
        maxRunning: () => 1,
        make: (identity, quota) =>
          new BrowserSessionService(
            { get: async () => ({}) },
            {
              launch: async viewport => {
                const browser = await launcher.launch(viewport, identity);
                started.resolve();
                await release.promise;
                return browser;
              },
            },
            Date.now,
            undefined,
            undefined,
            undefined,
            identity,
            quota,
          ),
      });
      const opening = local.openPage('s1', 'late', { identity: 'shutdown', url: `${base}/read` });
      await started.promise;
      const pid = await chromePid('shutdown');
      const displays = await xvfbPids();
      let settled = false;
      const closing = local.closeAll().then(() => {
        settled = true;
      });
      await Bun.sleep(50);
      const early = settled;
      release.resolve();
      await Promise.allSettled([opening, closing]);
      try {
        should(early).be.false();
        should(await readFile(`/proc/${String(pid)}/cmdline`, 'utf8').catch(() => '')).equal('');
        should((await xvfbPids()).filter(pid => displays.includes(pid))).deepEqual([]);
      } finally {
        await local.closeAll();
        mode = 'headless';
      }
    },
    90_000,
  );

  it('should preserve worker-local native secret masking in two identities and keep their page ids distinct', async () => {
    await pages.closeAll();
    const opened = await Promise.all([
      pages.openPage('s1', 'maskone', { identity: 'maskone', url: `${base}/mask?v=one` }),
      pages.openPage('s1', 'masktwo', { identity: 'masktwo', url: `${base}/mask?v=two` }),
    ]);
    try {
      should(opened[0]?.id).startWith('maskone-pg-');
      should(opened[1]?.id).startWith('masktwo-pg-');
      for (const name of ['maskone', 'masktwo']) {
        const read = await textOf('s1', name);
        should(read).containEql('[redacted]');
        should(read).containEql('ordinary-readable');
        should(read).not.match(/synthetic-native-(one|two)-/u);
        const evaluated = await pages.scriptOnPage('s1', name, {
          source: '() => document.querySelector("input").value',
        });
        should(evaluated.text).containEql('[redacted]');
        should(JSON.stringify(evaluated)).not.match(/synthetic-native-(one|two)-/u);
      }
    } finally {
      await pages.closeAll();
    }
  }, 90_000);
});

/** The Xvfb processes of this host whose Xauthority lives in this test's own directory. */
async function xvfbPids(): Promise<readonly number[]> {
  const found: number[] = [];
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/u.test(entry)) continue;
    const command = (await readFile(`/proc/${entry}/cmdline`, 'utf8').catch(() => '')).split('\0');
    if (command[0]?.endsWith('Xvfb') && command.some(arg => arg.includes(join(root, 'display'))))
      found.push(Number(entry));
  }
  return found;
}
