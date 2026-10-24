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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { sharedChromium } from './support/chromium.ts';
import { type ReleaseKey, releaseKey, signedRelease } from './support/signed-release.ts';

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

/** Builds and (optionally) signs one release of the fixture site; returns its files. */
const release = async (
  name: string,
  label: string,
  identity: { readonly commit: string; readonly sequence: number },
  key: ReleaseKey,
  sign = true,
): Promise<Map<string, Uint8Array>> =>
  await signedRelease({
    directory: workDirectory,
    name,
    files: new Map([
      ['index.html', PAGE],
      ['release.js', SCRIPT(label)],
    ]),
    identity,
    key,
    sign,
  });

let first: Map<string, Uint8Array>;
let second: Map<string, Uint8Array>;
let unsigned: Map<string, Uint8Array>;
let stranger: Map<string, Uint8Array>;

beforeAll(async () => {
  workDirectory = await mkdtemp(join(tmpdir(), 'ferretry-release-worker-'));
  const key = await releaseKey(workDirectory, 'key');
  first = await release('first', 'first', { commit: 'aaaaaaa', sequence: 1 }, key);
  second = await release('second', 'second', { commit: 'bbbbbbb', sequence: 2 }, key);
  unsigned = await release('unsigned', 'unsigned', { commit: 'ccccccc', sequence: 3 }, key, false);
  stranger = await release(
    'stranger',
    'stranger',
    { commit: 'ddddddd', sequence: 9 },
    await releaseKey(workDirectory, 'stranger'),
  );

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

/**
 * ONE PUSH WORKER PER MACHINE (docs/cross-daemon.md §4b, §4c), through the same built worker.
 *
 * Each machine is a registration of the SIGNED `sw.verified.js` at its own scope, labelled in the
 * script's query — exactly what `containerPushEnrolment` registers. A push is delivered straight to
 * one registration over the DevTools protocol (`ServiceWorker.deliverPushMessage`), which is the event
 * a push service would raise, so no real push service is needed. A real subscription per VAPID key
 * needs one, and is the part this cannot show.
 */
describe('per-machine push workers', () => {
  interface RegistrationSeen {
    readonly registrationId: string;
    readonly scopeURL: string;
    readonly isDeleted?: boolean;
  }

  const machines = async (context: BrowserContext, page: Page) => {
    await context.grantPermissions(['notifications'], { origin: origin() });
    const cdp = await context.newCDPSession(page);
    const seen = new Map<string, string>();
    cdp.on('ServiceWorker.workerRegistrationUpdated', (event: { registrations: RegistrationSeen[] }) => {
      for (const registration of event.registrations) {
        if (registration.isDeleted === true) seen.delete(registration.scopeURL);
        else seen.set(registration.scopeURL, registration.registrationId);
      }
    });
    await cdp.send('ServiceWorker.enable');
    await page.evaluate(async () => {
      // The page enforces Trusted Types (`public/_headers`): a registration takes only what the app's
      // `fy-worker` policy made, exactly as `lib/trusted-types.ts` makes it.
      const policy = (
        globalThis as unknown as {
          trustedTypes: { createPolicy(name: string, rules: object): { createScriptURL(url: string): string } };
        }
      ).trustedTypes.createPolicy('fy-worker', { createScriptURL: (url: string) => url });
      const activate = async (script: string, scope: string): Promise<void> => {
        const registration = await navigator.serviceWorker.register(policy.createScriptURL(script), { scope });
        const worker = registration.installing ?? registration.waiting ?? registration.active;
        if (worker === null || worker.state === 'activated') return;
        await new Promise<void>(resolveActive => {
          worker.addEventListener('statechange', () => {
            if (worker.state === 'activated') resolveActive();
          });
        });
      };
      await activate('/sw.verified.js?machine=Work%20laptop', '/push/work/');
      await activate('/sw.verified.js?machine=Home', '/push/home/');
    });
    // Deadlines, not attempt counts: the whole integration tier shares one machine, and a worker or a
    // notification that lands late under that load is still a pass.
    const idOf = async (path: string): Promise<string> => {
      const deadline = Date.now() + 15_000;
      while (!seen.has(`${origin()}${path}`) && Date.now() < deadline) {
        await new Promise(resolveTick => setTimeout(resolveTick, 50));
      }
      const id = seen.get(`${origin()}${path}`);
      if (id === undefined) throw new Error(`DevTools never reported the registration at ${path}`);
      return id;
    };
    const sent = new Map<string, Record<string, unknown>>();
    const push = async (path: string, payload: Record<string, unknown>): Promise<void> => {
      sent.set(path, payload);
      await cdp.send('ServiceWorker.deliverPushMessage', {
        origin: origin(),
        registrationId: await idOf(path),
        data: JSON.stringify({ version: 1, eventKey: `e-${Math.random()}`, body: 'b', count: 1, ...payload }),
      });
    };
    // A DevTools delivery is occasionally dropped (measured: 1 run in 9), so an unseen push is sent again.
    // It carries the same tag, so a late first copy REPLACES the second rather than adding to the list.
    const shown = async (path: string) => {
      const deadline = Date.now() + 15_000;
      let resendAt = Date.now() + 3_000;
      while (Date.now() < deadline) {
        const again = sent.get(path);
        if (Date.now() >= resendAt && again !== undefined) {
          resendAt = Date.now() + 3_000;
          await push(path, again);
        }
        const list = await page.evaluate(async scope => {
          const registration = await navigator.serviceWorker.getRegistration(scope);
          return (await registration?.getNotifications())?.map(notification => ({
            title: notification.title,
            tag: notification.tag,
            url: (notification.data as { url?: string } | null)?.url,
          }));
        }, path);
        if (list !== undefined && list.length > 0) return list;
        await new Promise(resolveTick => setTimeout(resolveTick, 50));
      }
      return [];
    };
    return { push, shown };
  };

  test('titles each machine’s push with the reader’s label, in its own namespace, opening only its pages', async () => {
    const { context, page } = await installed(first);
    const { push, shown } = await machines(context, page);

    await push('/push/work/', { title: 'A new device was paired', tag: 'pairing', url: 'https://evil.test/' });
    await push('/push/home/', { title: 'Needs you', tag: 'pairing', url: '/d/work/settings' });

    expect(await shown('/push/work/')).toEqual([
      { title: 'Work laptop · A new device was paired', tag: 'fy-push:work:pairing', url: `${origin()}/d/work` },
    ]);
    // Home reused Work's tag and pointed at Work's settings: it replaced nothing and opens only Home.
    expect(await shown('/push/home/')).toEqual([
      { title: 'Home · Needs you', tag: 'fy-push:home:pairing', url: `${origin()}/d/home` },
    ]);
    await context.close();
  }, 120_000);

  /**
   * THE FILTER, APPLIED IN THE REAL WORKER (lead's follow-up to #503: the gap was the main path).
   *
   * Every daemon now sends every event unconditionally; this device's own filter
   * (`lib/notification-filter.ts`) is what decides what is actually shown, and the worker cannot
   * read `localStorage` — only the mirror this test writes directly into IndexedDB, exactly the way
   * `DeviceNotificationFilterStore` would from the page. One category ("failed") is muted; a push of
   * that kind must show the quiet placeholder (`filteredPushNotification`), never its real content,
   * while a push of a kind that is still on reaches the reader exactly as before.
   */
  test('shows the quiet placeholder for a muted kind, and the real push for one that is not', async () => {
    const { context, page } = await installed(first);
    const { push, shown } = await machines(context, page);

    await page.evaluate(async () => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('ferretry-notification-filter', 1);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains('mirror')) request.result.createObjectStore('mirror');
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const value = JSON.stringify({
        version: 1,
        categories: { 'needs-you': true, finished: true, failed: false, 'new-device': true },
        quietHours: { enabled: false, startMinute: 0, endMinute: 0 },
        machines: {},
      });
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction('mirror', 'readwrite');
        transaction.objectStore('mirror').put(value, 'preferences');
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
    });

    // Muted: "failed" is off. Sent to Work.
    await push('/push/work/', {
      sessionId: 's1',
      kind: 'failed',
      title: 'Session failed',
      body: 'the real reason, which must not appear',
      tag: 'session-s1',
      url: '/',
    });
    // Still on: "completed" is untouched. Sent to Home, so each machine's own registration answers
    // for exactly one push and `shown()` cannot confuse one machine's result with the other's.
    await push('/push/home/', {
      sessionId: 's2',
      kind: 'completed',
      title: 'Session finished',
      body: 'all good',
      tag: 'session-s2',
      url: '/',
    });

    const muted = await shown('/push/work/');
    expect(muted).toHaveLength(1);
    expect(muted[0]?.title).toBe('Work laptop · Notifications muted');
    expect(muted[0]?.tag).toBe('fy-quiet:work');
    expect(JSON.stringify(muted)).not.toContain('Session failed');
    expect(JSON.stringify(muted)).not.toContain('the real reason');

    expect(await shown('/push/home/')).toEqual([
      // `url: '/'` names no page, so the tap opens the session the push is about, on its machine.
      { title: 'Home · Session finished', tag: 'fy-push:home:session-s2', url: `${origin()}/d/home/session/s2` },
    ]);
    await context.close();
  }, 120_000);

  test('turning one machine off leaves the others delivering', async () => {
    const { context, page } = await installed(first);
    const { push, shown } = await machines(context, page);

    const removed = await page.evaluate(
      async () => (await navigator.serviceWorker.getRegistration('/push/work/'))?.unregister() ?? false,
    );
    await push('/push/home/', { title: 'Still here', tag: 't', url: '/' });

    expect(removed).toBe(true);
    expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(2);
    expect((await shown('/push/home/')).map(notification => notification.title)).toEqual(['Home · Still here']);
    await context.close();
  }, 120_000);

  test('a push that reaches the app-wide registration is Unverified and opens only the app', async () => {
    const { context, page } = await installed(first);
    const { push, shown } = await machines(context, page);

    await push('/', { title: 'A new device was paired with Home', tag: 'pairing', url: '/d/home/settings' });

    expect(await shown('/')).toEqual([
      {
        title: 'Unverified · A new device was paired with Home',
        tag: 'fy-push-unverified:pairing',
        url: `${origin()}/app/`,
      },
    ]);
    await context.close();
  }, 120_000);

  test('a machine’s worker still answers navigations under its scope from the verified release', async () => {
    const { context, page } = await installed(first);
    await machines(context, page);
    served.set('push/work/x.html', encoded(HOSTILE_PAGE));
    requests.length = 0;

    await page.goto(`${origin()}/push/work/x.html`);

    expect(await label(page)).toBe('first');
    expect(requests).not.toContain('navigate /push/work/x.html');
    await context.close();
  }, 120_000);
});

/**
 * TRUSTED TYPES (docs/cross-daemon.md §2b), as an installed page gets them: the policy is the one the
 * signed worker compiled from `public/_headers`, so this is the shipped rule, not a copy of it.
 */
describe('Trusted Types on the installed app', () => {
  test('refuses plain markup and plain worker URLs, and every policy but the two the app names', async () => {
    const { context, page } = await installed(first);

    const outcome = await page.evaluate(async () => {
      const factory = (
        globalThis as unknown as {
          trustedTypes: {
            createPolicy(
              name: string,
              rules: object,
            ): { createHTML(html: string): string; createScriptURL(url: string): string };
          };
        }
      ).trustedTypes;
      const attempt = async (act: () => unknown): Promise<string> => {
        try {
          await act();
          return 'allowed';
        } catch (error) {
          return (error as Error).name;
        }
      };
      const target = document.createElement('div');
      const plainMarkup = await attempt(() => {
        target.innerHTML = '<img src=x onerror=alert(1)>';
      });
      const plainWorker = await attempt(() =>
        navigator.serviceWorker.register('/sw.verified.js', { scope: '/push/x/' }),
      );
      const strangerPolicy = await attempt(() =>
        factory.createPolicy('stranger', { createHTML: (html: string) => html }),
      );
      const highlight = factory.createPolicy('fy-highlight', { createHTML: (html: string) => html });
      const viaPolicy = await attempt(() => {
        target.innerHTML = highlight.createHTML('<span class="hljs-keyword">const</span>');
      });
      const twice = await attempt(() => factory.createPolicy('fy-highlight', { createHTML: (html: string) => html }));
      return { plainMarkup, plainWorker, strangerPolicy, viaPolicy, twice, rendered: target.innerHTML };
    });

    expect(outcome).toEqual({
      plainMarkup: 'TypeError',
      plainWorker: 'TypeError',
      strangerPolicy: 'TypeError',
      viaPolicy: 'allowed',
      twice: 'TypeError',
      rendered: '<span class="hljs-keyword">const</span>',
    });
    await context.close();
  }, 120_000);
});
