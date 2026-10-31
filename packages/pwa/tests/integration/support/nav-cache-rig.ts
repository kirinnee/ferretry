/**
 * THE NAV-CACHE RIG: the real shell, one fake daemon, Chromium's own IndexedDB and session storage.
 *
 * The scene (`tests/integration/fixtures/nav-cache-scene.tsx`) mounts `RouterProvider > StoreProvider >
 * AppShell` — the app as `App` composes it — over one fake daemon. It is built in a child process, never
 * inside this runner, and served from loopback with the SAME document for every app path, so a reload of
 * `/d/<id>/…` is a real reload of that address. Every off-origin request is aborted: nothing can leave the
 * page.
 *
 * Two files stand on it: `tests/integration/shell/nav-cache.test.ts` (the blocking tier: one desktop, the
 * journeys joined) and `tests/realworld/shell/nav-cache.visual.test.ts` (the whole matrix on a desktop and a
 * phone, with captures). A rig both need lives here; neither file closes the shared Chromium.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';
import { sharedChromium } from './chromium.ts';

const packageRoot = resolve(import.meta.dir, '../../..');

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

export type Form = 'desktop' | 'phone';

export const SCROLLER = '[data-density-region="dashboard-scroller"]';
export const SKELETON = `${SCROLLER} .animate-pulse`;
export const PILL = '[data-cache-updating]';

export interface NavCacheRig {
  readonly origin: string;
  /** One fresh browser profile — its own IndexedDB, storage and history — at one form factor. */
  readonly open: (
    form: Form,
    mode?: 'light' | 'dark',
  ) => Promise<{ readonly context: BrowserContext; readonly tab: Page }>;
  readonly stop: () => Promise<void>;
}

const build = async (directory: string): Promise<{ readonly css: string; readonly js: string }> => {
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(packageRoot, 'scripts/build-composer-integration-fixture.ts'),
      '--out',
      directory,
      '--entry',
      'tests/integration/fixtures/nav-cache-scene.tsx',
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the nav-cache scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

export const startNavCacheRig = async (): Promise<NavCacheRig> => {
  const browser = await sharedChromium();
  const directory = await mkdtemp(join(tmpdir(), 'ferretry-nav-cache-'));
  try {
    const { css, js } = await build(directory);
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: request => {
        const path = new URL(request.url).pathname;
        if (path === '/app.js')
          return new Response(js, { headers: { 'content-type': 'text/javascript', 'cache-control': 'max-age=3600' } });
        if (path === '/app.css')
          return new Response(css, { headers: { 'content-type': 'text/css', 'cache-control': 'max-age=3600' } });
        // A file the scene does not serve (the service worker, an icon) is absent, never the document.
        if (path.includes('.')) return new Response('not here', { status: 404 });
        // EVERY APP PATH IS THE SAME DOCUMENT, as the real host serves it: a reload of `/d/<id>/…` works.
        return new Response(html, { headers: { 'content-type': 'text/html' } });
      },
    });
    const origin = server.url.origin;
    return {
      origin,
      open: async (form, mode = 'light') => {
        const phone = form === 'phone';
        const context = await browser.newContext({
          viewport: phone ? { width: 390, height: 844 } : { width: 1_440, height: 900 },
          colorScheme: mode,
          reducedMotion: 'reduce',
          deviceScaleFactor: phone ? 2 : 1,
          ...(phone ? { isMobile: true, hasTouch: true, userAgent: ANDROID_UA } : {}),
        });
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
        );
        return { context, tab: await context.newPage() };
      },
      stop: async () => {
        server.stop(true);
        await rm(directory, { force: true, recursive: true });
      },
    };
  } catch (error) {
    await rm(directory, { force: true, recursive: true });
    throw error;
  }
};

const daemonOf = async (tab: Page): Promise<string> =>
  await tab.evaluate(() => (globalThis as unknown as { __navCache: { daemonId: string } }).__navCache.daemonId);

export const sessionsPathOf = (daemon: string): string => `/d/${encodeURIComponent(daemon)}`;

/** The sessions list's link to one session, wherever the list draws it. */
export const listRow = (sessionId: string): string => `${SCROLLER} a[href$="/session/${sessionId}"]`;

/** Opens the app at its front door and waits for the sessions list it lands on. */
export const boot = async (rig: NavCacheRig, tab: Page): Promise<string> => {
  await tab.goto(`${rig.origin}/`);
  await tab.waitForSelector(listRow('s-03'));
  return await daemonOf(tab);
};

/** Waits until the browser's own IndexedDB holds the session list and the named transcripts. */
export const cacheSaved = async (tab: Page, transcripts: readonly string[]): Promise<void> => {
  await tab.waitForFunction(
    async (wanted: readonly string[]) => {
      const keys = await new Promise<readonly string[]>((done, fail) => {
        const request = indexedDB.open('ferretry-session-cache');
        request.onerror = () => fail(request.error);
        request.onsuccess = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains('records')) {
            database.close();
            done([]);
            return;
          }
          const all = database.transaction('records', 'readonly').objectStore('records').getAllKeys();
          all.onsuccess = () => {
            database.close();
            done(all.result.map(String));
          };
          all.onerror = () => fail(all.error);
        };
      });
      return (
        keys.some(key => key.startsWith('["sessions"')) &&
        wanted.every(id => keys.some(key => key.startsWith('["transcript"') && key.includes(id)))
      );
    },
    transcripts,
    { timeout: 15_000 },
  );
};

/** What the scene reads at its next boot: hold the first list/logs answer, and/or rename a session. */
export const nextBoot = async (
  tab: Page,
  flags: { readonly hold?: boolean; readonly renamed?: boolean },
): Promise<void> =>
  await tab.evaluate(
    ({ hold, renamed }) => {
      localStorage.setItem('fy-nav-cache:hold', hold === true ? '1' : '0');
      localStorage.setItem('fy-nav-cache:renamed', renamed === true ? '1' : '0');
    },
    { hold: flags.hold, renamed: flags.renamed },
  );

export const release = async (tab: Page): Promise<void> =>
  await tab.evaluate(() => (globalThis as unknown as { __navCache: { release(): void } }).__navCache.release());

/** From here on the daemon never answers a list again, so nothing can write the cache back in. */
export const stall = async (tab: Page): Promise<void> =>
  await tab.evaluate(() => (globalThis as unknown as { __navCache: { stall(): void } }).__navCache.stall());

/** Marks this document three ways, so a later check can tell a soft navigation from a reload. */
export const markDocument = async (tab: Page): Promise<void> =>
  await tab.evaluate(() => {
    const page = globalThis as unknown as { __marker?: string; __sawSkeleton?: boolean };
    page.__marker = 'same-document';
    page.__sawSkeleton = false;
    const root = document.getElementById('root') as (HTMLElement & { __navTag?: string }) | null;
    if (root?.firstElementChild) (root.firstElementChild as HTMLElement & { __navTag?: string }).__navTag = 'shell';
    new MutationObserver(() => {
      if (document.querySelector('[data-density-region="dashboard-scroller"] .animate-pulse') !== null)
        page.__sawSkeleton = true;
    }).observe(document.body, { childList: true, subtree: true });
  });

export interface DocumentFacts {
  readonly marker: string | undefined;
  readonly navigations: number;
  readonly shellConnected: boolean;
  readonly sawSkeleton: boolean | undefined;
  readonly index: number | undefined;
}

export const documentFacts = async (tab: Page): Promise<DocumentFacts> =>
  await tab.evaluate(() => {
    const page = globalThis as unknown as { __marker?: string; __sawSkeleton?: boolean };
    const tagged = [...document.querySelectorAll('#root > *')].find(
      node => (node as HTMLElement & { __navTag?: string }).__navTag === 'shell',
    );
    return {
      marker: page.__marker,
      navigations: performance.getEntriesByType('navigation').length,
      shellConnected: tagged?.isConnected === true,
      sawSkeleton: page.__sawSkeleton,
      index: (history.state as { fyIndex?: number } | null)?.fyIndex,
    };
  });

export const scrollTopOf = async (tab: Page, selector: string): Promise<number> =>
  await tab.$eval(selector, node => node.scrollTop);

/** Waits until the scroll memory in this tab's session storage holds a place with this offset for a page. */
const pageOffsetRemembered = async (tab: Page, top: number): Promise<void> => {
  await tab.waitForFunction(offset => {
    const raw = sessionStorage.getItem('fy-scroll-memory:v1');
    if (raw === null) return false;
    const places = (JSON.parse(raw) as { places?: Record<string, Record<string, number>> }).places ?? {};
    return Object.entries(places).some(
      ([key, place]) => key.startsWith('page:') && Object.values(place).some(value => Math.abs(value - offset) <= 1),
    );
  }, top);
};

/** Waits until the chat's reading position has been filed (it settles 150 ms after the last scroll). */
export const chatPositionRemembered = async (tab: Page, selector: string): Promise<void> => {
  await tab.waitForFunction(scroller => {
    const raw = sessionStorage.getItem('fy-scroll-memory:v1');
    const node = document.querySelector(scroller);
    if (raw === null || node === null) return false;
    const places = (JSON.parse(raw) as { places?: Record<string, { top?: number; atLatest?: boolean }> }).places ?? {};
    return Object.entries(places).some(
      ([key, place]) =>
        key.startsWith('chat:') && place.atLatest === false && Math.abs((place.top ?? -9) - node.scrollTop) <= 1,
    );
  }, selector);
};

/** Puts a scroller at an offset the way a reader's scroll lands, then lets the memory record it. */
export const scrollTo = async (tab: Page, selector: string, top: number): Promise<number> => {
  const landed = await tab.$eval(
    selector,
    (node, offset) => {
      node.scrollTop = offset;
      return node.scrollTop;
    },
    top,
  );
  await pageOffsetRemembered(tab, landed);
  return landed;
};

/**
 * The session a reader can see in the list where it sits now — the row nearest the middle, wholly on
 * screen. A click on a row off screen makes Playwright scroll it into view first, and that scroll is
 * the reader's last position as far as the memory can tell: whether it is filed before the click
 * navigates is a race between the next frame and the click, and a test that lost it asked for the
 * wrong offset back (desktop, offset 1234: `s-20` is 850px below the fold and centred at 2523).
 */
export const rowOnScreen = async (tab: Page): Promise<string> =>
  await tab.$eval(SCROLLER, node => {
    const box = node.getBoundingClientRect();
    const middle = (box.top + box.bottom) / 2;
    const [nearest] = [...node.querySelectorAll('a[href*="/session/"]')]
      .map(row => {
        const rect = row.getBoundingClientRect();
        const onScreen = rect.top >= box.top && rect.bottom <= box.bottom;
        return { href: row.getAttribute('href') ?? '', onScreen, off: Math.abs((rect.top + rect.bottom) / 2 - middle) };
      })
      .filter(row => row.onScreen)
      .sort((a, b) => a.off - b.off);
    if (nearest === undefined) throw new Error('no session row is wholly on screen in the list');
    return nearest.href.slice(nearest.href.lastIndexOf('/') + 1);
  });

/** Waits for a scroller to sit at `top` (±1), and answers where it settled. */
export const settlesAt = async (tab: Page, selector: string, top: number): Promise<number> => {
  await tab
    .waitForFunction(
      ({ selector, top }) => {
        const node = document.querySelector(selector);
        return node !== null && Math.abs(node.scrollTop - top) <= 1;
      },
      { selector, top },
      { timeout: 8_000 },
    )
    .catch(() => undefined);
  return await scrollTopOf(tab, selector);
};
