/**
 * THE BOARD ON A PHONE SCROLLS IN ONE PLACE, in a real browser: 390×844, a long board (72 cards across four
 * lanes) and a second machine that does not answer, so the one-line notice is drawn.
 *
 * The scene (`tests/integration/fixtures/board-scroll-scene.tsx`) is the real `BoardPage` inside the shell's own
 * frame — the clipping page region the real `PullToPaletteRegion` hosts, a 57px app bar above and a tab bar
 * below. It is built in a child process, never inside this runner, and served from loopback.
 *
 * What is proved:
 *   - exactly ONE element in the page scrolls vertically — the board itself — and the document does not;
 *   - the lane-tab strip is sticky: scrolled mid-list, it sits directly under the app bar and a finger on it
 *     meets the strip, while the view tabs, the filter row and the notice have all scrolled out;
 *   - the first card starts within a quarter of the viewport height, notice showing;
 *   - a pull from the top still opens the finder, and a pull from mid-list does not;
 *   - the notice is one line until tapped, and its X removes it;
 *   - a desktop keeps its title and its tools row, and also scrolls in one place.
 *
 * Set `FY_BOARD_SCROLL_SHOTS_DIR` to keep captures for review; every name in them is fake.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { sharedChromium } from '../support/chromium.ts';
import {
  pullDown,
  readBoardDensity,
  readBoardReadable,
  readBoardScroll,
  scrollBoardTo,
} from '../support/board-scroll.ts';

const packageRoot = resolve(import.meta.dir, '../../..');
const shotsDir = process.env.FY_BOARD_SCROLL_SHOTS_DIR ?? '';

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const APP_BAR = 57;
const VIEWPORT = 844;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-board-scroll-'));
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(packageRoot, 'scripts/build-composer-integration-fixture.ts'),
      '--out',
      directory,
      '--entry',
      'tests/integration/fixtures/board-scroll-scene.tsx',
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the board scroll scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

const open = async (
  scene: 'phone' | 'desktop',
  mode: 'light' | 'dark' = 'light',
  columns?: number,
): Promise<{ readonly context: BrowserContext; readonly tab: Page }> => {
  const phone = scene === 'phone';
  const context = await browser.newContext({
    viewport: phone ? { width: 390, height: VIEWPORT } : { width: 1_440, height: 900 },
    colorScheme: mode,
    reducedMotion: 'reduce',
    deviceScaleFactor: 2,
    ...(phone ? { isMobile: true, hasTouch: true, userAgent: ANDROID_UA } : {}),
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  await tab.goto(`${origin}/?scene=${scene}&theme=studio-${mode}${columns === undefined ? '' : `&cols=${columns}`}`);
  await tab.waitForSelector('.fy-board-card');
  if (phone) await tab.waitForSelector('.fy-board__notice');
  return { context, tab };
};

const shoot = async (tab: Page, name: string): Promise<void> => {
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, name) });
};

describe('the Board scrolls in one place on a phone', () => {
  beforeAll(async () => {
    browser = await sharedChromium();
    const { css, js } = await build();
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: request => {
        const path = new URL(request.url).pathname;
        if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
        if (path === '/app.css') return new Response(css, { headers: { 'content-type': 'text/css' } });
        if (path === '/') return new Response(html, { headers: { 'content-type': 'text/html' } });
        return new Response('not here', { status: 404 });
      },
    });
    if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
  }, 180_000);

  afterAll(async () => {
    server?.stop(true);
    if (directory !== '') await rm(directory, { force: true, recursive: true });
  });

  it('has exactly one vertical scroller, and it is the board', async () => {
    for (const mode of ['light', 'dark'] as const) {
      const { context, tab } = await open('phone', mode);
      try {
        expect((await tab.$$('.fy-board-card')).length).toBeGreaterThanOrEqual(36);
        const top = await readBoardScroll(tab);
        expect(top.verticalScrollers).toEqual(['fy-board']);
        expect(top.scrollingNow).toEqual(['fy-board']);
        expect(top.documentOverflow).toBe(0);
        await scrollBoardTo(tab, 1_100);
        const scrolled = await readBoardScroll(tab);
        expect(scrolled.boardScrollTop).toBeGreaterThan(500);
        expect(scrolled.verticalScrollers).toEqual(['fy-board']);
        expect(scrolled.documentOverflow).toBe(0);
        await shoot(tab, `board-b62-${mode}-phone-scrolled.png`);
      } finally {
        await context.close();
      }
    }
  }, 60_000);

  it('keeps only the lane tabs in view, under the app bar, while the rest of the chrome scrolls out', async () => {
    const { context, tab } = await open('phone');
    try {
      const top = await readBoardScroll(tab);
      expect(top.strip?.position).toBe('sticky');
      // At the top the strip is part of the flow, below the views, the filter row and the notice.
      for (const bottom of Object.values(top.chromeBottoms)) expect(bottom).toBeGreaterThan(top.boardTop);
      expect(top.strip?.top).toBeGreaterThan(top.boardTop + 60);

      await scrollBoardTo(tab, 1_100);
      const scrolled = await readBoardScroll(tab);
      expect(scrolled.boardTop).toBe(APP_BAR);
      expect(Math.abs((scrolled.strip?.top ?? Number.NaN) - scrolled.boardTop)).toBeLessThanOrEqual(1);
      expect(scrolled.stripOnTop).toBe(true);
      for (const bottom of Object.values(scrolled.chromeBottoms)) expect(bottom).toBeLessThanOrEqual(scrolled.boardTop);
    } finally {
      await context.close();
    }
  }, 60_000);

  it('starts the first card within a quarter of the viewport, notice showing', async () => {
    for (const mode of ['light', 'dark'] as const) {
      const { context, tab } = await open('phone', mode);
      try {
        const facts = await readBoardScroll(tab);
        expect(facts.viewport).toBe(VIEWPORT);
        expect(facts.firstCardTop).not.toBeNull();
        expect(facts.firstCardTop as number).toBeLessThanOrEqual(VIEWPORT * 0.25);
        await shoot(tab, `board-b62-${mode}-phone-top.png`);
      } finally {
        await context.close();
      }
    }
  }, 60_000);

  it('still opens the finder from a pull at the top, and not from mid-list', async () => {
    const { context, tab } = await open('phone');
    try {
      expect(await pullDown(tab, 400, 160)).toBe(1);
      await scrollBoardTo(tab, 1_100);
      expect(await pullDown(tab, 400, 160)).toBe(0);
    } finally {
      await context.close();
    }
  }, 60_000);

  it('fits ten or more whole cards under the sticky strip, with a menu a finger can still hit', async () => {
    for (const mode of ['light', 'dark'] as const) {
      const { context, tab } = await open('phone', mode);
      try {
        await scrollBoardTo(tab, 1_100);
        const dense = await readBoardDensity(tab);
        expect(dense.wholeCardsUnderStrip).toBeGreaterThanOrEqual(10);
        expect(dense.cardHeight).toBeLessThanOrEqual(64);
        expect(dense.cardStep - dense.cardHeight).toBeLessThanOrEqual(5);
        expect(dense.moreButton.height).toBeLessThan(40);
        expect(dense.moreHit.width).toBeGreaterThanOrEqual(40);
        expect(dense.moreHit.height).toBeGreaterThanOrEqual(40);
        expect(dense.moreReached).toBe(true);
        await shoot(tab, `board-b62-${mode}-phone-dense.png`);
      } finally {
        await context.close();
      }
    }
  }, 60_000);

  it('wraps a title to two lines and drops whole meta items, never cutting one mid-line', async () => {
    const cases = [
      { scene: 'phone', columns: undefined },
      { scene: 'desktop', columns: 200 },
      { scene: 'desktop', columns: 168 },
      { scene: 'desktop', columns: 270 },
    ] as const;
    for (const { scene, columns } of cases) {
      for (const mode of ['light', 'dark'] as const) {
        const { context, tab } = await open(scene, mode, columns);
        try {
          const facts = await readBoardReadable(tab);
          expect(facts.cards).toBeGreaterThan(30);
          expect(facts.titleMaxLines).toBeLessThanOrEqual(2);
          expect(facts.titlesCut).toBe(0);
          expect(facts.partialItems).toBe(0);
          expect(facts.cardsMissingId).toBe(0);
          expect(facts.tallestCard).toBeLessThanOrEqual(64);
          if (scene === 'desktop' && (columns ?? 999) <= 200) {
            expect(facts.titleMaxLines).toBe(2);
            expect(facts.titleWidth).toBeLessThan(200);
          }
          if (columns === 200 || columns === 270 || scene === 'phone') expect(facts.cardsMissingActivity).toBe(0);
          await shoot(tab, `board-readable-${mode}-${scene}.png`);
        } finally {
          await context.close();
        }
      }
    }
  }, 120_000);

  it('draws the notice on one line until tapped, and dismisses it', async () => {
    const { context, tab } = await open('phone');
    try {
      const text = tab.locator('.fy-board__notice-text');
      const folded = await text.boundingBox();
      expect((folded?.height ?? 99) < 44).toBe(true);
      expect(await text.getAttribute('aria-expanded')).toBe('false');
      expect(await text.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
      await text.tap();
      expect(await text.getAttribute('aria-expanded')).toBe('true');
      expect(await tab.locator('.fy-board__notice[data-open]').count()).toBe(1);
      await tab.locator('.fy-board__notice-x').tap();
      expect(await tab.locator('.fy-board__notice').count()).toBe(0);
    } finally {
      await context.close();
    }
  }, 60_000);

  it('keeps the desktop title and tools row, and scrolls in one place too', async () => {
    const { context, tab } = await open('desktop');
    try {
      expect(await tab.locator('h1.fy-board__title').count()).toBe(1);
      expect(await tab.locator('.fy-board__tools').count()).toBe(1);
      const facts = await readBoardScroll(tab);
      expect(facts.verticalScrollers.filter(name => name === 'fy-board')).toEqual(['fy-board']);
      expect(facts.documentOverflow).toBe(0);
      await shoot(tab, 'board-b62-light-desktop.png');
    } finally {
      await context.close();
    }
  }, 60_000);
});
