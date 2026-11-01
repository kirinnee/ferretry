/**
 * SNOOZE IS IN EVERY CARD'S ONE-ROW HEAD, in a real browser, on a phone and a desktop, in light and dark, in the house
 * look and the one with hard rules.
 *
 * The owner (2026-11-01, &F370): "snooze is a common operation, would prefer if you can fit it into the top bar (for
 * cards, tasks, both in inbox and in chat)".
 *
 *  - An agenda item (`AgendaItemView`), the Inbox's quick-answer card to test (`ToTestStep`) and a list of cards to
 *    test (`ToTestList`: the chat's task panel, the Board's Cards view) each draw ONE clock, in the head's row, after
 *    ⓘ and before ✕ where those exist: never in the ⓘ panel, never in the answer row.
 *  - The head stays ONE row, and on a 390px phone the title still has room for 16 characters before it scrolls.
 *  - The snooze menu opens inside the viewport and holds 1 hour / 4 hours / Tomorrow / Custom.
 *
 * Set `FY_SNOOZE_HEAD_SHOTS_DIR` to keep `<viewport>-<family>-<scheme>-<scene>-<case>.png`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sharedChromium } from './support/chromium.ts';

const packageRoot = resolve(import.meta.dir, '../..');
const shotsDir = process.env.FY_SNOOZE_HEAD_SHOTS_DIR ?? '';

const SCENE_CSS = 'html, body, #root { height: 100%; margin: 0; }';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-snooze-head-'));
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(packageRoot, 'scripts/build-composer-integration-fixture.ts'),
      '--out',
      directory,
      '--entry',
      'tests/integration/fixtures/snooze-head-scene.tsx',
    ],
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
  { scene: 'run', head: '.fy-totest__top', ready: '.fy-totest__top [data-to-test-title]' },
  { scene: 'list', head: '.fy-totest__top', ready: '.fy-totest__top [data-to-test-title]' },
] as const;

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
    for (const family of FAMILIES)
      for (const scheme of ['light', 'dark'] as const)
        for (const scene of SCENES) {
          const tag = `${family}-${scheme}`;
          const label = `${scene.scene}, ${name}, ${family}, ${scheme}`;

          it(`has ONE clock, in the one-row head, with room for the title (${label})`, async () => {
            const { tab, close } = await open(name, family, scheme, scene);
            try {
              const g = await headGeometry(tab, scene.head);
              expect(g.clock, 'the head has a clock').not.toBeNull();
              expect(g.clocksOutsideHead, 'no second snooze anywhere else on the card').toBe(0);
              if (scene.scene !== 'list') expect(g.clocksInCard, 'one clock on the screen').toBe(1);
              const clock = g.clock as Rect;
              expect(g.bar?.height, 'the head is one row tall').toBeLessThanOrEqual(ONE_ROW);
              expect(clock.top, 'the clock is on the title’s row').toBeGreaterThanOrEqual((g.bar?.top ?? 0) - 1);
              expect(clock.bottom, 'the clock is on the title’s row').toBeLessThanOrEqual((g.bar?.bottom ?? 0) + 1);
              expect(clock.width, 'a compact hit area').toBeGreaterThanOrEqual(28);
              expect(clock.width, 'a compact hit area').toBeLessThanOrEqual(32);
              expect(g.title?.right ?? 0, 'the title ends before the clock').toBeLessThanOrEqual(clock.left + 1);
              if (g.info !== null) expect(g.info.right, 'ⓘ comes before the clock').toBeLessThanOrEqual(clock.left + 1);
              if (g.close !== null)
                expect(clock.right, '✕ comes after the clock').toBeLessThanOrEqual(g.close.left + 1);
              expect(g.titleBox, 'the title shows 16 characters before it scrolls').toBeGreaterThanOrEqual(g.sixteen);
              await shot(tab, name, tag, `${scene.scene}-head`);
            } finally {
              await close();
            }
          });

          it(`opens the menu inside the viewport with 1h / 4h / tomorrow / custom (${label})`, async () => {
            const { tab, close } = await open(name, family, scheme, scene);
            try {
              await tab.locator('[data-agenda-snooze]').first().click();
              await tab.waitForSelector('.fy-snooze__popover');
              await tab.evaluate(
                () => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
              );
              const found = await tab.evaluate(() => {
                const menu = (document.querySelector('.fy-snooze__popover') as HTMLElement).getBoundingClientRect();
                return {
                  menu: { top: menu.top, bottom: menu.bottom, left: menu.left, right: menu.right },
                  width: document.documentElement.clientWidth,
                  height: window.innerHeight,
                  words: [...document.querySelectorAll('.fy-snooze__popover [role="menuitem"]')].map(
                    entry => entry.textContent?.trim() ?? '',
                  ),
                };
              });
              expect(found.menu.left, 'inside on the left').toBeGreaterThanOrEqual(0);
              expect(found.menu.right, 'inside on the right').toBeLessThanOrEqual(found.width);
              expect(found.menu.top, 'inside at the top').toBeGreaterThanOrEqual(0);
              expect(found.menu.bottom, 'inside at the bottom').toBeLessThanOrEqual(found.height);
              expect(found.words.length, 'four choices').toBe(4);
              expect(found.words[0]?.toLowerCase()).toContain('1 hour');
              expect(found.words[1]?.toLowerCase()).toContain('4 hours');
              expect(found.words[2]?.toLowerCase()).toContain('tomorrow');
              expect(found.words[3]?.toLowerCase()).toContain('custom');
              await shot(tab, name, tag, `${scene.scene}-menu`);
            } finally {
              await close();
            }
          });
        }

  for (const { name } of VIEWPORTS)
    it(`keeps the snooze out of ⓘ and out of the answer row (${name})`, async () => {
      const item = SCENES[0];
      const { tab, close } = await open(name, 'studio', 'light', item);
      try {
        await tab.locator('[data-agenda-info-toggle]').click();
        await tab.waitForSelector('[data-agenda-info-panel]:not([hidden])');
        const inPanel = await tab.evaluate(
          () => document.querySelectorAll('[data-agenda-info-panel] [data-agenda-snooze]').length,
        );
        expect(inPanel, 'ⓘ no longer holds a snooze').toBe(0);
        await shot(tab, name, 'studio-light', 'item-info-open');
      } finally {
        await close();
      }
      const run = await open(name, 'studio', 'light', SCENES[1]);
      try {
        const inActions = await run.tab.evaluate(
          () => document.querySelectorAll('.fy-totest__actions [data-agenda-snooze]').length,
        );
        expect(inActions, 'the answer row no longer holds a snooze').toBe(0);
      } finally {
        await run.close();
      }
    });
});
