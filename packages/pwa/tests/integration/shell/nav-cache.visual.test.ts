/**
 * BACK, RELOAD AND THE SESSION CACHE, in a real browser, through the REAL SHELL.
 *
 * The scene (`tests/integration/fixtures/nav-cache-scene.tsx`) mounts `RouterProvider > StoreProvider >
 * AppShell` — the app as `App` composes it — over one fake daemon, with Chromium's own IndexedDB (the
 * session cache) and `sessionStorage` (scroll memory and the router's trail) underneath. It is built in
 * a child process, never inside this runner, and served from loopback with the SAME document for every
 * app path, so a reload of `/d/<id>/…` is a real reload of that address. Every off-origin request is
 * aborted: nothing can leave the page.
 *
 * What is proved, on a 1440 desktop and a 390 Android phone:
 *   1. Back — the browser's and the in-app "← Sessions" — returns to the sessions list WITHOUT reloading
 *      the document (a page global survives, the navigation timeline holds one entry, the shell's root
 *      node is the same node) and without a skeleton row on the way back.
 *   2. A reload draws the cached session rows and the cached transcript at once, says "Updating…" while
 *      the daemon's first answer is held, and gives way to the live answer the moment it lands; after
 *      Settings › This device › Cached data is cleared, a held reload draws a skeleton, not old rows.
 *   3. Settings and the sessions list come back where they were scrolled after Back and after a reload;
 *      a chat scrolled up keeps its reading position, detached with "Jump to latest", the same way.
 *
 * Set `FY_NAV_CACHE_SHOTS_DIR` to keep the captures for review; every name in them is fake.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { sharedChromium } from '../support/chromium.ts';

const packageRoot = resolve(import.meta.dir, '../../..');
const shotsDir = process.env.FY_NAV_CACHE_SHOTS_DIR ?? '';

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

type Form = 'desktop' | 'phone';
const FORMS: Form[] = ['desktop', 'phone'];

const SCROLLER = '[data-density-region="dashboard-scroller"]';
const SKELETON = `${SCROLLER} .animate-pulse`;
const PILL = '[data-cache-updating]';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-nav-cache-'));
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

const origin = (): string => server?.url.origin ?? '';

/** One fresh browser profile — its own IndexedDB, storage and history — at one form factor. */
const open = async (
  form: Form,
  mode: 'light' | 'dark' = 'light',
): Promise<{ readonly context: BrowserContext; readonly tab: Page }> => {
  const phone = form === 'phone';
  const context = await browser.newContext({
    viewport: phone ? { width: 390, height: 844 } : { width: 1_440, height: 900 },
    colorScheme: mode,
    reducedMotion: 'reduce',
    deviceScaleFactor: phone ? 2 : 1,
    ...(phone ? { isMobile: true, hasTouch: true, userAgent: ANDROID_UA } : {}),
  });
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin() ? await route.continue() : await route.abort(),
  );
  return { context, tab: await context.newPage() };
};

const daemonOf = async (tab: Page): Promise<string> =>
  await tab.evaluate(() => (globalThis as unknown as { __navCache: { daemonId: string } }).__navCache.daemonId);

const sessionsPathOf = (daemon: string): string => `/d/${encodeURIComponent(daemon)}`;

/** The sessions list's link to one session, wherever the list draws it. */
const listRow = (sessionId: string): string => `${SCROLLER} a[href$="/session/${sessionId}"]`;

/** Opens the app at its front door and waits for the sessions list it lands on. */
const boot = async (tab: Page): Promise<string> => {
  await tab.goto(`${origin()}/`);
  await tab.waitForSelector(listRow('s-03'));
  return await daemonOf(tab);
};

/** Waits until the browser's own IndexedDB holds the session list and the named transcripts. */
const cacheSaved = async (tab: Page, transcripts: readonly string[]): Promise<void> => {
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
const nextBoot = async (tab: Page, flags: { readonly hold?: boolean; readonly renamed?: boolean }): Promise<void> =>
  await tab.evaluate(
    ({ hold, renamed }) => {
      localStorage.setItem('fy-nav-cache:hold', hold === true ? '1' : '0');
      localStorage.setItem('fy-nav-cache:renamed', renamed === true ? '1' : '0');
    },
    { hold: flags.hold, renamed: flags.renamed },
  );

const release = async (tab: Page): Promise<void> =>
  await tab.evaluate(() => (globalThis as unknown as { __navCache: { release(): void } }).__navCache.release());

/** Marks this document three ways, so a later check can tell a soft navigation from a reload. */
const markDocument = async (tab: Page): Promise<void> =>
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

interface DocumentFacts {
  readonly marker: string | undefined;
  readonly navigations: number;
  readonly shellConnected: boolean;
  readonly sawSkeleton: boolean | undefined;
  readonly index: number | undefined;
}

const documentFacts = async (tab: Page): Promise<DocumentFacts> =>
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

const scrollTopOf = async (tab: Page, selector: string): Promise<number> =>
  await tab.$eval(selector, node => node.scrollTop);

/**
 * Runs one journey at both form factors AT ONCE, each in its own browser profile, and fails with the
 * form named. The two never share a context, IndexedDB, storage or history, so running them side by side
 * proves exactly what running them one after the other did, in the time of the slower one.
 */
const eachForm = async (journey: (form: Form) => Promise<void>): Promise<void> => {
  const outcomes = await Promise.allSettled(
    FORMS.map(async form => {
      try {
        await journey(form);
      } catch (error) {
        if (error instanceof Error) error.message = `[${form}] ${error.message}`;
        throw error;
      }
    }),
  );
  for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
};

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
const chatPositionRemembered = async (tab: Page, selector: string): Promise<void> => {
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
const scrollTo = async (tab: Page, selector: string, top: number): Promise<number> => {
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
const rowOnScreen = async (tab: Page): Promise<string> =>
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
const settlesAt = async (tab: Page, selector: string, top: number): Promise<number> => {
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

const capture = async (tab: Page, name: string): Promise<void> => {
  if (shotsDir === '') return;
  await writeFile(join(shotsDir, `${name}.png`), await tab.screenshot({ animations: 'disabled' }));
};

describe('navigation without reloads, and the session cache, in the real shell', () => {
  beforeAll(async () => {
    browser = await sharedChromium();
    const { css, js } = await build();
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
    server = Bun.serve({
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
    if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
  }, 180_000);

  afterAll(async () => {
    server?.stop(true);
    if (directory !== '') await rm(directory, { force: true, recursive: true });
  });

  it(
    'draws the cached rows and transcript on reload, then the live answer, on a desktop and a phone',
    async () =>
      await eachForm(async form => {
        // Arrange: one live visit saves the list and s-03's transcript into this profile's IndexedDB.
        const { context, tab } = await open(form);
        try {
          const daemon = await boot(tab);
          await tab.click(listRow('s-03'));
          await tab.waitForSelector('.fy-transcript :text("Live tail of s-03.")');
          await cacheSaved(tab, ['s-03']);
          await nextBoot(tab, { hold: true, renamed: true });

          // Act: a reload of the sessions list with the daemon's first answer held.
          await tab.goto(`${origin()}${sessionsPathOf(daemon)}`);
          await tab.waitForSelector(listRow('s-00'));
          // The list as drawn: a desktop table puts the task in its own cell, beside the row's link.
          const cachedList = await tab.$eval(SCROLLER, node => (node as HTMLElement).innerText);
          const pillWhileHeld = await tab.$$eval(PILL, nodes => nodes.length);
          const skeletonWhileHeld = await tab.$$eval(SKELETON, nodes => nodes.length);
          await tab.emulateMedia({ colorScheme: 'dark' });
          await capture(tab, `sessions-updating-${form}-dark`);
          await tab.emulateMedia({ colorScheme: 'light' });
          await release(tab);
          await tab.waitForSelector(`${SCROLLER} :text("Renamed by the live read")`);
          await tab.waitForSelector(PILL, { state: 'detached' });

          // Act: a reload of the chat, held the same way.
          await nextBoot(tab, { hold: true, renamed: true });
          await tab.goto(`${origin()}${sessionsPathOf(daemon)}/session/s-03`);
          await tab.waitForSelector('.fy-transcript :text("Live tail of s-03.")');
          const chatPillWhileHeld = await tab.$$eval(PILL, nodes => nodes.length);
          await release(tab);
          await tab.waitForSelector('.fy-transcript :text("Fresh tail of s-03.")');
          await tab.waitForSelector(PILL, { state: 'detached' });

          // Assert
          expect(cachedList).toContain('Cached relay bench');
          expect(cachedList).not.toContain('Renamed by the live read');
          expect(pillWhileHeld).toBe(1);
          expect(skeletonWhileHeld).toBe(0);
          expect(chatPillWhileHeld).toBe(1);
          expect(await tab.$$eval('.fy-transcript :text("Live tail of s-03.")', nodes => nodes.length)).toBe(0);
        } finally {
          await context.close();
        }
      }),
    120_000,
  );

  it(
    'shows This device › Cached data, light and dark, and forgets the cache when it is cleared: a held reload draws a skeleton, on a desktop and a phone',
    async () =>
      await eachForm(async form => {
        // Arrange
        const { context, tab } = await open(form);
        try {
          const daemon = await boot(tab);
          await cacheSaved(tab, []);
          await nextBoot(tab, {});
          await tab.goto(`${origin()}${sessionsPathOf(daemon)}/settings#device`);
          await tab.waitForSelector('[data-clear-cached-data="idle"]');
          // The section as drawn in light and in dark: the theme follows the OS answer live, so the same
          // profile shows both without a second boot.
          const sectionFacts: { readonly mode: string; readonly text: string; readonly wide: number }[] = [];
          for (const mode of ['light', 'dark'] as const) {
            await tab.emulateMedia({ colorScheme: mode });
            await tab.$eval('[data-clear-cached-data]', node => node.scrollIntoView({ block: 'center' }));
            sectionFacts.push({
              mode,
              text: await tab.$eval('[data-settings-section="device"]', node => (node as HTMLElement).innerText),
              wide: await tab.evaluate(() => document.documentElement.scrollWidth - innerWidth),
            });
            await capture(tab, `settings-cached-data-${form}-${mode}`);
          }
          await tab.emulateMedia({ colorScheme: 'light' });
          // From here on the daemon never answers a list again, so nothing can write the cache back in.
          await tab.evaluate(() => (globalThis as unknown as { __navCache: { stall(): void } }).__navCache.stall());

          // Act
          await tab.click('[data-clear-cached-data] button:has-text("Clear cached data")');
          await tab.click('[data-clear-cached-data="confirming"] button:has-text("Clear")');
          await tab.waitForSelector('[data-clear-cached-data="cleared"]');
          await nextBoot(tab, { hold: true });
          await tab.goto(`${origin()}${sessionsPathOf(daemon)}`);
          await tab.waitForSelector(SKELETON);
          const rowsWhileHeld = await tab.$$eval(`${SCROLLER} a[href*="/session/"]`, nodes => nodes.length);
          const pillWhileHeld = await tab.$$eval(PILL, nodes => nodes.length);
          await release(tab);
          await tab.waitForSelector(listRow('s-03'));

          // Assert
          for (const { mode, text, wide } of sectionFacts) {
            expect(text, `${mode} Cached data section text`).toContain('Cached data');
            expect(wide, `${mode} horizontal overflow`).toBeLessThanOrEqual(0);
          }
          expect(rowsWhileHeld).toBe(0);
          expect(pillWhileHeld).toBe(0);
          expect(await tab.$$eval(SKELETON, nodes => nodes.length)).toBe(0);
        } finally {
          await context.close();
        }
      }),
    120_000,
  );

  it(
    'goes Back to the list without reloading the document, and puts Settings and the list back where they were scrolled, on a desktop and a phone',
    async () =>
      await eachForm(async form => {
        // Arrange
        const { context, tab } = await open(form);
        const settings = '[data-settings-scroller]';
        try {
          const daemon = await boot(tab);
          const listIndex = (await documentFacts(tab)).index;
          await markDocument(tab);
          const listTop = await scrollTo(tab, SCROLLER, 1_234);

          // Act: the list, out to a session on screen and Back, then reloaded.
          await tab.click(listRow(await rowOnScreen(tab)));
          await tab.waitForSelector('.fy-transcript');
          await tab.goBack();
          await tab.waitForSelector(listRow('s-03'));
          const afterBrowserBack = await documentFacts(tab);
          const listAfterBack = await settlesAt(tab, SCROLLER, listTop);
          await tab.reload();
          await tab.waitForSelector(listRow('s-03'));
          const listAfterReload = await settlesAt(tab, SCROLLER, listTop);

          // Act: the in-app "← Sessions", from New session opened off the reloaded list.
          const reloadedIndex = (await documentFacts(tab)).index;
          await markDocument(tab);
          await tab.click(`a[href="${sessionsPathOf(daemon)}/new"]`);
          await tab.waitForSelector('#new-session-heading');
          await tab.click('button:has-text("← Sessions")');
          await tab.waitForSelector(listRow('s-03'));
          const afterInAppBack = await documentFacts(tab);
          const pathAfterInAppBack = new URL(tab.url()).pathname;

          // Act: Settings, out to the sessions list and Back, then reloaded.
          // Settings is under More on a phone and in the sidebar on a desktop.
          if (form === 'phone') await tab.click('[data-app-tab="more"]');
          await tab.click(`a[href="${sessionsPathOf(daemon)}/settings"]:visible`);
          await tab.waitForSelector(settings);
          // Behaviour is the longest section at either width.
          await tab.click('[data-settings-section-choice="behaviour"]:visible');
          await tab.waitForFunction(selector => {
            const node = document.querySelector(selector);
            return node !== null && node.scrollHeight > node.clientHeight + 600;
          }, settings);
          const settingsTop = await scrollTo(tab, settings, 500);
          await tab.click(
            form === 'phone' ? `a[href="${sessionsPathOf(daemon)}"]:visible` : '[data-sbar-session="s-05"]',
          );
          await tab.waitForSelector(form === 'phone' ? listRow('s-03') : '.fy-transcript');
          await tab.goBack();
          await tab.waitForSelector(settings);
          const settingsAfterBack = await settlesAt(tab, settings, settingsTop);
          await tab.reload();
          await tab.waitForSelector(settings);
          const settingsAfterReload = await settlesAt(tab, settings, settingsTop);

          // Assert: Back is a step in the same document — nothing reloaded, no skeleton on the way, the trail
          // where it was — and the in-app "← Sessions" is a real step back, not a push of the list.
          const sameDocument: Omit<DocumentFacts, 'index'> = {
            marker: 'same-document',
            navigations: 1,
            shellConnected: true,
            sawSkeleton: false,
          };
          expect(afterBrowserBack).toEqual({ ...sameDocument, index: listIndex });
          expect(afterInAppBack).toEqual({ ...sameDocument, index: reloadedIndex });
          expect(pathAfterInAppBack).toBe(sessionsPathOf(daemon));
          expect(listTop).toBe(1_234);
          expect(Math.abs(listAfterBack - listTop)).toBeLessThanOrEqual(1);
          expect(Math.abs(listAfterReload - listTop)).toBeLessThanOrEqual(1);
          expect(settingsTop).toBe(500);
          expect(Math.abs(settingsAfterBack - settingsTop)).toBeLessThanOrEqual(1);
          expect(Math.abs(settingsAfterReload - settingsTop)).toBeLessThanOrEqual(1);
        } finally {
          await context.close();
        }
      }),
    120_000,
  );

  it(
    'keeps a chat’s reading position, detached, across Back, Forward and a reload, on a desktop and a phone',
    async () =>
      await eachForm(async form => {
        // Arrange: a chat opened at its latest message, then scrolled up by the reader's wheel.
        const { context, tab } = await open(form);
        const transcript = '.fy-transcript';
        try {
          await boot(tab);
          await tab.click(listRow('s-03'));
          await tab.waitForSelector(`${transcript} :text("Live tail of s-03.")`);
          const box = await tab.$eval(transcript, node => {
            const rect = node.getBoundingClientRect();
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          });
          await tab.mouse.move(box.x, box.y);
          for (let step = 0; step < 6; step += 1) await tab.mouse.wheel(0, -400);
          await tab.waitForSelector('.fy-jump-latest');
          await chatPositionRemembered(tab, transcript);
          const reading = await scrollTopOf(tab, transcript);

          // Act: Back to the list, Forward into the chat again.
          await tab.goBack();
          await tab.waitForSelector(listRow('s-03'));
          await tab.goForward();
          await tab.waitForSelector(transcript);
          const afterForward = await settlesAt(tab, transcript, reading);
          const jumpAfterForward = await tab.$$eval('.fy-jump-latest', nodes => nodes.length);

          // Act: and reopened by clicking it, and reloaded.
          await tab.goBack();
          await tab.waitForSelector(listRow('s-03'));
          await tab.click(listRow('s-03'));
          await tab.waitForSelector(transcript);
          const afterClick = await settlesAt(tab, transcript, reading);
          await tab.reload();
          await tab.waitForSelector(`${transcript} :text("Live tail of s-03.")`, { state: 'attached' });
          const afterReload = await settlesAt(tab, transcript, reading);
          const jumpAfterReload = await tab.$$eval('.fy-jump-latest', nodes => nodes.length);

          // Assert: well away from the latest message, and the same place every time.
          const latest = await tab.$eval(transcript, node => node.scrollHeight - node.clientHeight);
          expect(latest - reading).toBeGreaterThan(1_000);
          expect(Math.abs(afterForward - reading)).toBeLessThanOrEqual(1);
          expect(Math.abs(afterClick - reading)).toBeLessThanOrEqual(1);
          expect(Math.abs(afterReload - reading)).toBeLessThanOrEqual(1);
          expect([jumpAfterForward, jumpAfterReload]).toEqual([1, 1]);
        } finally {
          await context.close();
        }
      }),
    120_000,
  );
});
