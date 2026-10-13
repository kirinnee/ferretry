/**
 * The built service worker, in real Chromium: the end-to-end proof of `docs/pwa-release-signing.md`.
 *
 * WHY A BROWSER. The worker's claims are about what it SERVES — verified bytes from its own cache, a
 * refused update leaving the running version in place, a page's tampering with the origin's storage
 * changing nothing — and only a real worker, real Cache Storage and real IndexedDB can show that. The
 * decisions themselves are proved in `tests/unit/release-*.ts`.
 *
 * THE FIXTURE is a tiny site, not the app: a page, a script, the real `sw.verified.js` built from
 * `src/worker/service-worker.ts` with the real `public/_headers` and `public/_redirects`, and lists
 * signed by the REAL CI signer (`scripts/ci/sign-pwa-release.sh`, openssl) with throwaway keys made
 * here. Each scene then changes what the server serves — or what a page writes into the origin's
 * storage — and asks the page what it sees. The build runs in a CHILD PROCESS, never in this one —
 * see `support/fy-render-integration-fixture.ts` for why a `Bun.build` inside the test runner wedges.
 *
 * THE SERVER IS HOSTILE ABOUT HEADERS: it sends no security policy and an `X-Edge` header of its own
 * with every file, so any header a page sees under the worker came from the signed worker's compiled
 * `_headers` rules, not from the edge.
 *
 * The server listens on `127.0.0.1`, which the worker treats as a developer machine — so an UNSIGNED
 * build is answered "unverified" here rather than refused. Every other scene is signed, so that
 * allowance never decides their outcome; one scene asserts the allowance itself.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { sharedChromium } from './support/chromium.ts';

const packageRoot = resolve(import.meta.dir, '../..');
const repositoryRoot = resolve(packageRoot, '../..');

const PAGE = `<!doctype html><meta charset="utf-8"><title>release</title>
<script src="/release.js"></script>`;
const SCRIPT = (label: string) => `window.releaseLabel = ${JSON.stringify(label)};`;
/** What a compromised deploy puts at a path the release does not list. */
const HOSTILE_PAGE = '<!doctype html><title>hostile</title><script>window.releaseLabel = "hostile";</script>';

let workDirectory = '';
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
/** What the server serves right now: path → bytes. Each scene rewrites it. */
let served = new Map<string, Uint8Array>();
/** Every request the server saw, as `<Sec-Fetch-Mode> <path>`: a page load is `navigate /…`. */
const requests: string[] = [];

const run = (command: string[], cwd = packageRoot, input?: Uint8Array): void => {
  const result = spawnSync(command[0] ?? '', command.slice(1), { cwd, encoding: 'utf8', input });
  if (result.status !== 0) throw new Error(`${command.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
};

const listFiles = async (directory: string): Promise<string[]> =>
  (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile())
    .map(entry => relative(directory, join(entry.parentPath, entry.name)).split(sep).join('/'));

const keyPair = async (name: string): Promise<{ pem: string; pub: string }> => {
  const pem = join(workDirectory, `${name}.pem`);
  const pub = join(workDirectory, `${name}.pub`);
  run(['openssl', 'genpkey', '-algorithm', 'ed25519', '-out', pem], workDirectory);
  run(['openssl', 'pkey', '-in', pem, '-pubout', '-out', pub], workDirectory);
  return { pem, pub };
};

/** Builds and (optionally) signs one release of the fixture site; returns its files. */
const release = async (
  name: string,
  label: string,
  identity: { readonly commit: string; readonly sequence: number },
  key: { readonly pem: string; readonly pub: string },
  sign = true,
): Promise<Map<string, Uint8Array>> => {
  const dist = join(workDirectory, name);
  await mkdir(dist, { recursive: true });
  await writeFile(join(dist, 'index.html'), PAGE);
  // Pages configuration, as `vite build` copies it from `public/`; the signer checks it is the real one.
  for (const config of ['_headers', '_redirects'])
    await copyFile(join(packageRoot, 'public', config), join(dist, config));
  await writeFile(join(dist, 'release.js'), SCRIPT(label));
  run([
    'bun',
    'run',
    'scripts/build-release.ts',
    dist,
    '--public-key',
    key.pub,
    '--commit',
    identity.commit,
    '--sequence',
    String(identity.sequence),
    '--created-at',
    '2026-10-01T00:00:00Z',
  ]);
  if (sign) {
    run(
      [
        join(repositoryRoot, 'scripts/ci/sign-pwa-release.sh'),
        '--sequence',
        String(identity.sequence),
        '--commit',
        identity.commit,
        '--public-key',
        key.pub,
        dist,
      ],
      repositoryRoot,
      new Uint8Array(await readFile(key.pem)),
    );
  }
  const files = new Map<string, Uint8Array>();
  for (const path of await listFiles(dist)) files.set(path, new Uint8Array(await readFile(join(dist, path))));
  return files;
};

let first: Map<string, Uint8Array>;
let second: Map<string, Uint8Array>;
let unsigned: Map<string, Uint8Array>;
let stranger: Map<string, Uint8Array>;

beforeAll(async () => {
  workDirectory = await mkdtemp(join(tmpdir(), 'ferretry-release-worker-'));
  const key = await keyPair('key');
  first = await release('first', 'first', { commit: 'aaaaaaa', sequence: 1 }, key);
  second = await release('second', 'second', { commit: 'bbbbbbb', sequence: 2 }, key);
  unsigned = await release('unsigned', 'unsigned', { commit: 'ccccccc', sequence: 3 }, key, false);
  stranger = await release('stranger', 'stranger', { commit: 'ddddddd', sequence: 9 }, await keyPair('stranger'));

  browser = await sharedChromium();
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const { pathname } = new URL(request.url);
      requests.push(`${request.headers.get('sec-fetch-mode') ?? ''} ${pathname}`);
      const path = pathname === '/' ? 'index.html' : pathname.slice(1);
      const bytes = served.get(path);
      if (bytes === undefined) return new Response('not found', { status: 404 });
      const type =
        path.endsWith('.html') || path.startsWith('release-manifest')
          ? 'text/html'
          : path.endsWith('.js')
            ? 'text/javascript'
            : 'text/plain';
      return new Response(bytes as Uint8Array<ArrayBuffer>, {
        headers: { 'content-type': type, 'cache-control': 'no-store', 'x-edge': 'whatever the edge says' },
      });
    },
  });
}, 240_000);

afterAll(async () => {
  await server?.stop(true);
  if (workDirectory !== '') await rm(workDirectory, { recursive: true, force: true });
});

const origin = () => `http://127.0.0.1:${server.port}`;

/** A fresh browser profile with the worker installed and controlling the page. */
const installed = async (files: Map<string, Uint8Array>): Promise<{ context: BrowserContext; page: Page }> => {
  served = new Map(files);
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${origin()}/`);
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.verified.js', { scope: '/' });
    await navigator.serviceWorker.ready;
  });
  // The first load was not controlled; this one is.
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  // That load started the worker's own check of the site; let it finish so a scene starts quiet.
  await ask(page, { type: 'fy-release-check' });
  return { context, page };
};

/** Asks the active worker one question, the way `use-release-integrity.ts` does. */
const ask = (page: Page, message: Record<string, unknown>) =>
  page.evaluate(
    async request =>
      await new Promise(resolveReply => {
        const channel = new MessageChannel();
        channel.port1.onmessage = event => resolveReply(event.data);
        navigator.serviceWorker.controller?.postMessage(request, [channel.port2]);
      }),
    message,
  );

const label = (page: Page) => page.evaluate(() => (window as unknown as { releaseLabel?: string }).releaseLabel);
const encoded = (text: string) => new TextEncoder().encode(text);

describe('the signed-release service worker', () => {
  test('serves the verified release, even when the server goes away', async () => {
    const { context, page } = await installed(first);
    expect(await label(page)).toBe('first');

    served = new Map();
    await page.reload();

    expect(await label(page)).toBe('first');
    await context.close();
  }, 120_000);

  test('installs a newer signed release and serves it on the next load', async () => {
    const { context, page } = await installed(first);
    served = new Map(second);

    const reply = await ask(page, { type: 'fy-release-check' });
    await page.reload();

    expect(reply).toEqual({ type: 'fy-release-outcome', outcome: { status: 'updated' } });
    expect(await label(page)).toBe('second');
    await context.close();
  }, 120_000);

  test('refuses a release whose file was changed after signing, and keeps serving the old one', async () => {
    const { context, page } = await installed(first);
    served = new Map(second);
    served.set('release.js', encoded(SCRIPT('tampered')));

    const reply = await ask(page, { type: 'fy-release-check' });
    await page.reload();

    expect(reply).toEqual({
      type: 'fy-release-outcome',
      outcome: { status: 'refused', refusal: 'hash-mismatch', hadRelease: true },
    });
    expect(await label(page)).toBe('first');
    await context.close();
  }, 120_000);

  test('refuses a list whose signature does not match it', async () => {
    const { context, page } = await installed(first);
    served = new Map(second);
    served.set('release-manifest.sig', first.get('release-manifest.sig') ?? new Uint8Array());

    const reply = await ask(page, { type: 'fy-release-check' });

    expect(reply).toEqual({
      type: 'fy-release-outcome',
      outcome: { status: 'refused', refusal: 'bad-signature', hadRelease: true },
    });
    expect(await label(page)).toBe('first');
    await context.close();
  }, 120_000);

  test('refuses a replayed OLDER signed release, and keeps serving the newer one', async () => {
    const { context, page } = await installed(second);
    served = new Map(first);

    const reply = await ask(page, { type: 'fy-release-check' });
    await page.reload();

    expect(reply).toEqual({
      type: 'fy-release-outcome',
      outcome: { status: 'refused', refusal: 'older', hadRelease: true },
    });
    expect(await label(page)).toBe('second');
    await context.close();
  }, 120_000);

  test('refuses a release signed by a key the worker does not trust', async () => {
    const { context, page } = await installed(first);
    served = new Map(stranger);

    const reply = await ask(page, { type: 'fy-release-check' });
    await page.reload();

    expect(reply).toEqual({
      type: 'fy-release-outcome',
      outcome: { status: 'refused', refusal: 'unknown-key', hadRelease: true },
    });
    expect(await label(page)).toBe('first');
    await context.close();
  }, 120_000);

  test('accepts an unsigned build only as "unverified", on a developer machine', async () => {
    const { context, page } = await installed(first);
    served = new Map(unsigned);

    const reply = await ask(page, { type: 'fy-release-check' });
    await page.reload();

    expect(reply).toEqual({ type: 'fy-release-outcome', outcome: { status: 'unverified' } });
    expect(await label(page)).toBe('first');
    await context.close();
  }, 120_000);

  test('never serves a cache entry a page rewrote, online or offline', async () => {
    // An XSS writes a backdoor into the active release's cache, with no security policy on it.
    const { context, page } = await installed(first);
    await page.evaluate(async hostile => {
      for (const name of await caches.keys()) {
        if (!name.startsWith('fy-release-')) continue;
        const cache = await caches.open(name);
        await cache.put('/index.html', new Response(hostile, { headers: { 'content-type': 'text/html' } }));
        await cache.put('/release.js', new Response('window.releaseLabel = "backdoor";'));
      }
    }, HOSTILE_PAGE);

    await page.reload();
    const online = await label(page);
    served = new Map();
    await page.reload();
    const offline = await label(page);

    expect(online).toBe('first');
    expect(offline).toBe('first');
    await context.close();
  }, 120_000);

  test('ignores a release record a page forged, signed with its own key', async () => {
    // An XSS points the worker's record at a release IT signed, and fills the matching cache.
    const { context, page } = await installed(first);
    const forged = {
      manifest: [...(stranger.get('release-manifest.json') ?? [])],
      signature: new TextDecoder().decode(stranger.get('release-manifest.sig')),
      index: new TextDecoder().decode(stranger.get('index.html')),
      script: new TextDecoder().decode(stranger.get('release.js')),
    };
    await page.evaluate(async record => {
      const cache = await caches.open('fy-release-ddddddd-9');
      await cache.put('/index.html', new Response(record.index));
      await cache.put('/release.js', new Response(record.script));
      const database = await new Promise<IDBDatabase>((resolveOpen, rejectOpen) => {
        const request = indexedDB.open('ferretry-release', 1);
        request.onsuccess = () => resolveOpen(request.result);
        request.onerror = () => rejectOpen(request.error);
      });
      await new Promise<void>((resolveWrite, rejectWrite) => {
        const transaction = database.transaction('state', 'readwrite');
        transaction.objectStore('state').put(
          {
            active: { manifestBytes: Uint8Array.from(record.manifest), signatureText: record.signature },
            previous: null,
            endorsements: [],
            lastOutcome: { status: 'current' },
          },
          'keeper',
        );
        transaction.oncomplete = () => resolveWrite();
        transaction.onerror = () => rejectWrite(transaction.error);
      });
      database.close();
    }, forged);

    await page.reload();

    // Believed, the forged sequence 9 would make the real release read as OLDER; it is a first install.
    const reply = await ask(page, { type: 'fy-release-check' });

    expect(await label(page)).toBe('first');
    // (The reload's own check may already have installed it, so this one may find it current.)
    expect(['updated', 'current']).toContain((reply as { outcome: { status: string } }).outcome.status);
    await context.close();
  }, 120_000);

  test('does not serve an older release a page put back after the worker moved past it', async () => {
    // R2: an XSS in release 1 keeps its signed bytes and writes them back once release 2 installs.
    const { context, page } = await installed(first);
    served = new Map(second);
    await ask(page, { type: 'fy-release-check' });
    const restore = {
      manifest: [...(first.get('release-manifest.json') ?? [])],
      signature: new TextDecoder().decode(first.get('release-manifest.sig')),
    };
    await page.evaluate(async record => {
      const database = await new Promise<IDBDatabase>((resolveOpen, rejectOpen) => {
        const request = indexedDB.open('ferretry-release', 1);
        request.onsuccess = () => resolveOpen(request.result);
        request.onerror = () => rejectOpen(request.error);
      });
      await new Promise<void>((resolveWrite, rejectWrite) => {
        const transaction = database.transaction('state', 'readwrite');
        const store = transaction.objectStore('state');
        const read = store.get('keeper');
        read.onsuccess = () =>
          store.put(
            {
              ...read.result,
              active: { manifestBytes: Uint8Array.from(record.manifest), signatureText: record.signature },
            },
            'keeper',
          );
        transaction.oncomplete = () => resolveWrite();
        transaction.onerror = () => rejectWrite(transaction.error);
      });
      database.close();
    }, restore);

    await page.reload();

    expect(await label(page)).toBe('second');
    await context.close();
  }, 120_000);

  test.each([
    ['the signed list', '/release-manifest.json'],
    ['the signature', '/release-manifest.sig'],
    ['a page no release lists', '/hostile.html'],
  ])(
    'answers a navigation to %s with the verified shell, never the network',
    async (_name, pathname) => {
      // A compromised deploy serves its own HTML at the path and links the reader to it.
      const { context, page } = await installed(first);
      served.set(pathname.slice(1), encoded(HOSTILE_PAGE));
      requests.length = 0;

      await page.goto(`${origin()}${pathname}`);

      expect(await label(page)).toBe('first');
      expect(requests).not.toContain(`navigate ${pathname}`);
      await context.close();
    },
    120_000,
  );

  test('serves the headers the signed worker carries, never the ones the edge sent', async () => {
    const { context, page } = await installed(first);

    const response = await page.reload();
    const headers = (await response?.allHeaders()) ?? {};

    expect(headers['content-security-policy']).toStartWith("default-src 'self'");
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['content-type']).toBe('text/html; charset=utf-8');
    expect(headers['x-edge']).toBeUndefined();
    await context.close();
  }, 120_000);

  test('tells the page whether a worker script is the signed one', async () => {
    const { context, page } = await installed(first);

    const signed = await ask(page, { type: 'fy-release-audit-worker', scriptUrl: `${origin()}/sw.verified.js` });
    served.set('sw.verified.js', encoded('self.addEventListener("fetch", () => {});'));
    const replaced = await ask(page, { type: 'fy-release-audit-worker', scriptUrl: `${origin()}/sw.verified.js` });

    expect(signed).toEqual({ type: 'fy-release-worker-audit', signed: true });
    expect(replaced).toEqual({ type: 'fy-release-worker-audit', signed: false });
    await context.close();
  }, 120_000);

  test('reports a replaced worker the browser starts installing, when that worker waits its turn', async () => {
    // What `use-release-integrity.ts` does on `updatefound`, through the browser's own update.
    const { context, page } = await installed(first);
    served.set('sw.verified.js', encoded('self.addEventListener("fetch", () => {});'));

    const audit = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      const found = new Promise<string>(resolveFound => {
        registration.addEventListener('updatefound', () => resolveFound(registration.installing?.scriptURL ?? ''));
      });
      await registration.update();
      const scriptUrl = await found;
      return await new Promise(resolveReply => {
        const channel = new MessageChannel();
        channel.port1.onmessage = event => resolveReply(event.data);
        registration.active?.postMessage({ type: 'fy-release-audit-worker', scriptUrl }, [channel.port2]);
      });
    });

    expect(audit).toEqual({ type: 'fy-release-worker-audit', signed: false });
    await context.close();
  }, 120_000);

  test('DECLARED LIMIT: a replaced worker that skips waiting and claims the tab takes it over', async () => {
    // docs/pwa-release-signing.md: a deploy that ships its own worker is detected only if a verified
    // tab is open while it installs AND the worker does not take the tab first. This one does.
    const { context, page } = await installed(first);
    served.set(
      'sw.verified.js',
      encoded(
        'self.oninstall = () => self.skipWaiting();' +
          'self.onactivate = event => event.waitUntil(self.clients.claim());',
      ),
    );

    const takenOver = await page.evaluate(async () => {
      const changed = new Promise<boolean>(resolveChange => {
        navigator.serviceWorker.addEventListener('controllerchange', () => resolveChange(true));
      });
      await (await navigator.serviceWorker.ready).update();
      return await changed;
    });

    expect(takenOver).toBe(true);
    await context.close();
  }, 120_000);

  test('leaves a fetch of a file no release lists to the network, untouched', async () => {
    const { context, page } = await installed(first);
    requests.length = 0;

    const status = await page.evaluate(async () => (await fetch('/not-listed.txt')).status);

    expect(status).toBe(404);
    expect(requests.some(seen => seen.endsWith(' /not-listed.txt'))).toBe(true);
    await context.close();
  }, 120_000);
});
