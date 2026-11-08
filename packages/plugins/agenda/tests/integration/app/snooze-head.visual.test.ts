/** The unified agenda item keeps Snooze in its one menu. */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

/** This file's folder: the scene paths below are relative to it, and the builder runs here. */
const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_SNOOZE_HEAD_SHOTS_DIR ?? '';

const SCENE_CSS = 'html, body, #root { height: 100%; margin: 0; }';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-snooze-head-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/snooze-head-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the snooze head scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

beforeAll(async () => {
  browser = await sharedChromium();
  const { css, js } = await build();
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${SCENE_CSS}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      if (path === '/') return new Response(page, { headers: { 'content-type': 'text/html' } });
      return new Response('not here', { status: 404 });
    },
  });
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const FAMILIES = ['studio', 'neo'] as const;
const VIEWPORTS = [
  { name: 'phone', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 },
  { name: 'desktop', viewport: { width: 1_440, height: 900 }, deviceScaleFactor: 1 },
] as const;
const SCENES = [
  { scene: 'item', head: '.fy-item-view__head [data-card-head]', ready: '.fy-item-view__head [data-agenda-title]' },
] as const;

/** The cards whose head draws the clock itself; the open agenda item's Snooze is behind its ⋯. */

/** One row's tallest control is 44px on touch; the head's own padding is under 20px more. */
const ONE_ROW = 72;

const open = async (
  name: string,
  family: string,
  scheme: 'light' | 'dark',
  scene: (typeof SCENES)[number],
  query = '',
): Promise<{ tab: Page; close: () => Promise<void> }> => {
  const viewport = VIEWPORTS.find(entry => entry.name === name) ?? VIEWPORTS[0];
  const context = await browser.newContext({
    viewport: viewport.viewport,
    colorScheme: scheme,
    deviceScaleFactor: viewport.deviceScaleFactor,
    hasTouch: name === 'phone',
    isMobile: name === 'phone',
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  await tab.goto(`${origin}/?theme=${family}-${scheme}&scene=${scene.scene}${query}`);
  await tab.waitForSelector(scene.ready);
  await tab.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  return { tab, close: async () => await context.close() };
};

const shot = async (tab: Page, name: string, tag: string, label: string): Promise<void> => {
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}-${tag}-${label}.png`) });
};

interface Rect {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly width: number;
  readonly height: number;
}

/** Every box is read in ONE evaluate, so they are one frame's layout. */
const headGeometry = async (tab: Page, head: string) =>
  await tab.evaluate((query: string) => {
    const rect = (element: Element | null): Rect | null => {
      if (element === null) return null;
      const { top, bottom, left, right, width, height } = element.getBoundingClientRect();
      return { top, bottom, left, right, width, height };
    };
    const bar = document.querySelector(query);
    if (bar === null) throw new Error(`nothing matches ${query}`);
    const title = bar.querySelector('[data-agenda-title]') as HTMLElement;
    const context = document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D;
    const style = getComputedStyle(title);
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    return {
      bar: rect(bar),
      title: rect(title),
      titleBox: title.clientWidth,
      sixteen: context.measureText('Which day works ').width,
      info: rect(bar.querySelector('[data-agenda-info-toggle]')),
      clock: rect(bar.querySelector('[data-agenda-snooze]')),
      close: rect(bar.querySelector('[data-agenda-close]')),
      clocksInCard: document.querySelectorAll('[data-agenda-snooze]').length,
      clocksOutsideHead: [...document.querySelectorAll('[data-agenda-snooze]')].filter(
        clock => clock.closest(query) === null,
      ).length,
    };
  }, head);

describe('snooze in the card’s head', () => {
  for (const { name } of VIEWPORTS)
    it(`keeps the open item’s Snooze behind ⋯ — no clock in the row, none in the answer row — on a sheet or popover inside the viewport (${name})`, async () => {
      const item = SCENES[0];
      const { tab, close } = await open(name, 'studio', 'light', item);
      try {
        const found = await tab.evaluate(() => ({
          info: document.querySelectorAll('[data-agenda-info-toggle], [data-agenda-info-panel]').length,
          clocks: document.querySelectorAll('[data-agenda-snooze]').length,
          menus: document.querySelectorAll('.fy-item-view__bar [data-agenda-menu-toggle]').length,
        }));
        expect(found.info, 'there is no ⓘ').toBe(0);
        expect(found.clocks, 'no clock anywhere on the item').toBe(0);
        expect(found.menus, 'ONE ⋯ in the head row').toBe(1);
        await tab.locator('[data-agenda-menu-toggle]').click();
        const where = name === 'phone' ? '[data-agenda-menu="sheet"]' : '[data-agenda-menu="popover"]';
        await tab.waitForSelector(`${where} [data-agenda-menu-group="snooze"]`);
        await tab.evaluate(() => new Promise<void>(done => setTimeout(() => requestAnimationFrame(() => done()), 300)));
        const menu = await tab.evaluate((query: string) => {
          const box = (document.querySelector(query) as HTMLElement).getBoundingClientRect();
          return {
            box: { top: box.top, bottom: box.bottom, left: box.left, right: box.right },
            width: document.documentElement.clientWidth,
            height: window.innerHeight,
            words: [...document.querySelectorAll(`${query} [data-agenda-menu-snooze]`)].map(
              entry => entry.textContent?.trim() ?? '',
            ),
          };
        }, where);
        expect(menu.box.left, 'inside on the left').toBeGreaterThanOrEqual(-1);
        expect(menu.box.right, 'inside on the right').toBeLessThanOrEqual(menu.width + 1);
        expect(menu.box.top, 'inside at the top').toBeGreaterThanOrEqual(-1);
        expect(menu.box.bottom, 'inside at the bottom').toBeLessThanOrEqual(menu.height + 1);
        expect(menu.words).toEqual(['1 hour', '4 hours', 'Tomorrow 9:00', 'Custom…']);
        await shot(tab, name, 'studio-light', 'item-menu');
      } finally {
        await close();
      }
    });
});
