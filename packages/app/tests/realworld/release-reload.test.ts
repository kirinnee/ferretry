/**
 * HOW LONG A RELOAD WAITS FOR THE RELEASE CHECK — in real Chromium, through the REAL built worker, over a site whose
 * signed list is hung (answered slower than `RELEASE_CHECK_DEADLINE_MS`). The wall-clock claims live here, in the
 * realworld tier, because they depend on the machine; what is shown is proved in `tests/integration/release-reload.test.ts`.
 *
 *   - no check answered recently → the load waits for the deadline and not for the list (≤ 3 s);
 *   - a check answered just now → the load does not wait at all (< 300 ms), and the check still lands behind it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { releaseKey, sharedChromium, signedRelease } from '../support/browser/index.ts';
import { RELEASE_CHECK_DEADLINE_MS } from '../../src/release/keeper.ts';

const page = (name: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${name}</title><p id="release">${name}</p>`;

let workDirectory = '';
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let site = new Map<string, Uint8Array>();
let listDelayMs = 0;
let trusted: Awaited<ReturnType<typeof releaseKey>>;
let counter = 0;

const publish = async (name: string, sequence: number): Promise<void> => {
  counter += 1;
  site = await signedRelease({
    directory: workDirectory,
    name: `${name}-${counter}`,
    files: new Map<string, string | Uint8Array>([['index.html', page(name)]]),
    identity: { commit: `a${String(sequence).padStart(6, '0')}`, sequence },
    key: trusted,
  });
};

beforeAll(async () => {
  workDirectory = await mkdtemp(join(tmpdir(), 'ferretry-release-wait-'));
  trusted = await releaseKey(workDirectory, 'trusted');
  browser = await sharedChromium();
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async request => {
      const { pathname } = new URL(request.url);
      const path = pathname === '/' ? 'index.html' : pathname.slice(1);
      if (path === 'release-manifest.json' && listDelayMs > 0) await Bun.sleep(listDelayMs);
      const bytes = site.get(path);
      if (bytes === undefined) return new Response('not found', { status: 404 });
      const type = path.endsWith('.html') ? 'text/html' : path.endsWith('.js') ? 'text/javascript' : 'text/plain';
      return new Response(bytes as Uint8Array<ArrayBuffer>, {
        headers: { 'content-type': type, 'cache-control': 'no-store' },
      });
    },
  });
}, 240_000);

afterAll(async () => {
  await server?.stop(true);
  if (workDirectory !== '') await rm(workDirectory, { recursive: true, force: true });
});

/** Asks the worker for a check and waits for its answer (a check already running is shared). */
const check = async (tab: Page): Promise<void> => {
  await tab.evaluate(
    () =>
      new Promise<void>(done => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => done();
        navigator.serviceWorker.controller?.postMessage({ type: 'fy-release-check' }, [channel.port2]);
      }),
  );
};

/** Forgets that any check was answered: a reader who last opened the app a while ago. (The record is the origin's.) */
const makeCheckDue = async (tab: Page): Promise<void> => {
  await check(tab);
  await tab.evaluate(
    () =>
      new Promise<void>((done, fail) => {
        const open = indexedDB.open('fy-app', 1);
        open.onerror = () => fail(open.error);
        open.onsuccess = () => {
          const transaction = open.result.transaction('state', 'readwrite');
          const store = transaction.objectStore('state');
          const read = store.get('keeper');
          read.onsuccess = () => store.put({ ...(read.result as object), checkedAt: null }, 'keeper');
          transaction.oncomplete = () => done();
          transaction.onerror = () => fail(transaction.error);
        };
      }),
  );
};

/** Release 1 installed and controlling a tab, then release 2 published behind a hung list. */
const withHungList = async (run: (tab: Page) => Promise<void>): Promise<void> => {
  await publish('release-1', 1);
  listDelayMs = 0;
  const context = await browser.newContext();
  const tab = await context.newPage();
  try {
    await tab.goto(`http://127.0.0.1:${server.port}/`);
    await tab.evaluate(async () => {
      await navigator.serviceWorker.register('/sw.verified.js', { scope: '/' });
      await navigator.serviceWorker.ready;
    });
    await tab.reload();
    await tab.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await run(tab);
  } finally {
    await context.close();
  }
};

const reloadTime = async (tab: Page): Promise<number> => {
  const started = performance.now();
  await tab.reload();
  return performance.now() - started;
};

describe('how long a reload waits for a slow site', () => {
  test('no check answered recently: it waits for the deadline, not for the list', async () => {
    await withHungList(async tab => {
      await makeCheckDue(tab);
      await publish('release-2', 2);
      listDelayMs = RELEASE_CHECK_DEADLINE_MS + 2_000;
      const elapsed = await reloadTime(tab);
      expect(await tab.textContent('#release')).toBe('release-1');
      expect(elapsed).toBeGreaterThan(RELEASE_CHECK_DEADLINE_MS - 500);
      expect(elapsed).toBeLessThan(3_000);
    });
  }, 90_000);

  test('a check answered just now: it does not wait at all', async () => {
    await withHungList(async tab => {
      await check(tab);
      await publish('release-2', 2);
      listDelayMs = RELEASE_CHECK_DEADLINE_MS + 2_000;
      const elapsed = await reloadTime(tab);
      expect(await tab.textContent('#release')).toBe('release-1');
      expect(elapsed).toBeLessThan(300);
    });
  }, 90_000);
});
