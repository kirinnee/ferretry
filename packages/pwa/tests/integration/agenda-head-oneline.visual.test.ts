/**
 * THE OPEN AGENDA ITEM'S HEAD IS ONE ROW, in a real browser, on a phone and a desktop, in light and dark.
 *
 * The owner (2026-11-01, &F329): "make the top bar single line for the card. it takes up too much space (follow the
 * old idea of (i) + marquee to keep it into a single line!)" and "the card form have similar problem, and the padding
 * and margins make them even smaller".
 *
 *  - The title, the status dot, ‹ n of N ›, the clock, ⓘ and ✕ share ONE row. A title too long for it scrolls (a
 *    marquee) — or, under `prefers-reduced-motion`, ends in an ellipsis and opens in full on a tap. The ask moves
 *    behind ⓘ, whose panel hangs under the row and sticks with it.
 *  - The card is one border level: no frame, no padding of its own inside the view, so a form's fields use the column,
 *    which keeps a 16px gutter on a phone.
 *
 * Set `FY_AGENDA_HEAD_SHOTS_DIR` to keep `<viewport>-<family>-<scheme>-<case>.png`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sharedChromium } from './support/chromium.ts';

const packageRoot = resolve(import.meta.dir, '../..');
const shotsDir = process.env.FY_AGENDA_HEAD_SHOTS_DIR ?? '';

const SCENE_CSS = `
  html, body, #root { height: 100%; margin: 0; }
  .scene-chat { box-sizing: border-box; display: flex; flex-direction: column; inset: 0; position: fixed; }
  .scene-chat .fy-chat-log { flex: 1 1 0; }
  .scene-composer { border: 1px solid var(--fy-border, #888); border-radius: 12px; box-sizing: border-box; height: 56px; padding: 16px; }
  .scene-form { display: flex; flex-direction: column; gap: 8px; }
  .scene-form label { display: flex; flex-direction: column; gap: 2px; }
  .scene-form [data-scene-field] { box-sizing: border-box; width: 100%; }
`;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-agenda-head-'));
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(packageRoot, 'scripts/build-composer-integration-fixture.ts'),
      '--out',
      directory,
      '--entry',
      'tests/integration/fixtures/agenda-head-scene.tsx',
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the head scene did not build (${code}):\n${stderr}\n${stdout}`);
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

const framesSettled = async (tab: Page): Promise<void> =>
  await tab.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

/** The house look, and the one with hard rules and offset shadows — where a doubled border shows most. */
const FAMILIES = ['studio', 'neo'] as const;

const VIEWPORTS = [
  { name: 'phone', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 },
  { name: 'desktop', viewport: { width: 1_440, height: 900 }, deviceScaleFactor: 1 },
] as const;

const open = async (
  name: string,
  family: string,
  scheme: 'light' | 'dark',
  query: string,
  reducedMotion: 'reduce' | 'no-preference' = 'no-preference',
): Promise<{ tab: Page; close: () => Promise<void> }> => {
  const viewport = VIEWPORTS.find(entry => entry.name === name) ?? VIEWPORTS[0];
  const context = await browser.newContext({
    viewport: viewport.viewport,
    colorScheme: scheme,
    reducedMotion,
    deviceScaleFactor: viewport.deviceScaleFactor,
    hasTouch: name === 'phone',
    isMobile: name === 'phone',
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  await tab.goto(`${origin}/?theme=${family}-${scheme}${query}`);
  await tab.waitForSelector('.fy-item-view__head [data-agenda-title]');
  await framesSettled(tab);
  return { tab, close: async () => await context.close() };
};

const shot = async (tab: Page, name: string, scheme: string, label: string): Promise<void> => {
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}-${scheme}-${label}.png`) });
};

/** One row's tallest control is 44px on touch; the head's own padding is under 20px more. */
const ONE_ROW = 72;

const headBox = async (tab: Page) =>
  await tab.evaluate(() => {
    const rect = (query: string) => {
      const element = document.querySelector(query);
      if (element === null) throw new Error(`nothing matches ${query}`);
      const { top, bottom, left, right, height } = element.getBoundingClientRect();
      return { top, bottom, left, right, height };
    };
    return {
      head: rect('.fy-item-view__head'),
      title: rect('[data-agenda-title]'),
      pager: rect('.fy-item-view__pager'),
      scroller: rect('.fy-item-view__body'),
    };
  });

describe('the open item’s head', () => {
  for (const { name } of VIEWPORTS)
    for (const family of FAMILIES)
      for (const scheme of ['light', 'dark'] as const) {
        it(`is one row with a short title, the ask behind ⓘ (${name}, ${family}, ${scheme})`, async () => {
          const { tab, close } = await open(name, family, scheme, '&title=short');
          try {
            const { head, title, pager } = await headBox(tab);
            expect(head.height, 'the head is one row tall').toBeLessThanOrEqual(ONE_ROW);
            expect(title.bottom, 'the title is on the controls’ row').toBeLessThanOrEqual(pager.bottom + 1);
            expect(title.top, 'the title is on the controls’ row').toBeGreaterThanOrEqual(pager.top - 1);
            expect(title.right, 'the title ends before the controls').toBeLessThanOrEqual(pager.left + 1);
            const ask = await tab.evaluate(
              () => document.querySelector('[data-agenda-ask]')?.getClientRects().length ?? 0,
            );
            expect(ask, 'the ask is not drawn until ⓘ opens').toBe(0);
            await shot(tab, name, `${family}-${scheme}`, 'short-title');
          } finally {
            await close();
          }
        });

        it(`scrolls a long title in the same one row (${name}, ${family}, ${scheme})`, async () => {
          const { tab, close } = await open(name, family, scheme, '&title=long');
          try {
            const { head } = await headBox(tab);
            expect(head.height, 'a long title does not make the head taller').toBeLessThanOrEqual(ONE_ROW);
            const state = await tab.evaluate(() => {
              const title = document.querySelector('[data-agenda-title]') as HTMLElement;
              const text = title.querySelector('.fy-item-view__title-text') as HTMLElement;
              return {
                marquee: title.getAttribute('data-marquee') !== null,
                running: text.getAnimations().filter(a => a.playState === 'running').length,
                overflowing: text.getBoundingClientRect().width > (text.parentElement as HTMLElement).clientWidth,
              };
            });
            expect(state.overflowing, 'the title really is longer than its box').toBe(true);
            expect(state.marquee, 'it is marked as scrolling').toBe(true);
            expect(state.running, 'and it scrolls').toBe(1);
            const room = await tab.evaluate(() => {
              const title = document.querySelector('[data-agenda-title]') as HTMLElement;
              const context = document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D;
              const style = getComputedStyle(title);
              context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
              return { box: title.clientWidth, sixteenLetters: context.measureText('Which day works ').width };
            });
            expect(room.box, 'the title shows at least 16 characters before it scrolls').toBeGreaterThanOrEqual(
              room.sixteenLetters,
            );
            await shot(tab, name, `${family}-${scheme}`, 'long-title');
          } finally {
            await close();
          }
        });

        it(`ends a long title in an ellipsis under reduced motion, and a tap opens it whole (${name}, ${family}, ${scheme})`, async () => {
          const { tab, close } = await open(name, family, scheme, '&title=long', 'reduce');
          try {
            const rowHeight = (await headBox(tab)).head.height;
            expect(rowHeight).toBeLessThanOrEqual(ONE_ROW);
            const still = await tab.evaluate(() => {
              const text = document.querySelector('.fy-item-view__title-text') as HTMLElement;
              return {
                animations: text.getAnimations().filter(a => a instanceof CSSAnimation).length,
                ellipsis: getComputedStyle(text.parentElement as HTMLElement).textOverflow,
              };
            });
            expect(still.animations, 'nothing moves').toBe(0);
            expect(still.ellipsis).toBe('ellipsis');
            await shot(tab, name, `${family}-${scheme}`, 'long-title-reduced');
            await tab.locator('[data-agenda-title]').click();
            await framesSettled(tab);
            const open = await headBox(tab);
            expect(open.head.height, 'a tap shows the whole title').toBeGreaterThan(rowHeight + 20);
            await shot(tab, name, `${family}-${scheme}`, 'long-title-expanded');
            await tab.locator('[data-agenda-title]').click();
            await framesSettled(tab);
            expect((await headBox(tab)).head.height, 'a second tap folds it again').toBeLessThanOrEqual(rowHeight + 1);
          } finally {
            await close();
          }
        });

        it(`opens the ask under the row from ⓘ, and the head still sticks (${name}, ${family}, ${scheme})`, async () => {
          const { tab, close } = await open(name, family, scheme, '&title=short');
          try {
            const before = (await headBox(tab)).head.height;
            await tab.locator('[data-agenda-info-toggle]').click();
            await framesSettled(tab);
            const opened = await headBox(tab);
            expect(opened.head.height, 'the panel is inside the head').toBeGreaterThan(before + 16);
            const ask = await tab.locator('[data-agenda-ask]').boundingBox();
            expect(ask, 'the ask is drawn').not.toBeNull();
            expect((ask?.y ?? 0) + (ask?.height ?? 0)).toBeLessThanOrEqual(opened.head.bottom + 1);
            await shot(tab, name, `${family}-${scheme}`, 'info-open');
            await tab.evaluate(() => {
              const body = document.querySelector('.fy-item-view__body') as HTMLElement;
              body.scrollTop = body.scrollHeight;
            });
            await framesSettled(tab);
            const stuck = await headBox(tab);
            expect(Math.abs(stuck.head.top - stuck.scroller.top)).toBeLessThanOrEqual(1);
          } finally {
            await close();
          }
        });

        it(`gives a form the column: no frame or padding of the card’s own (${name}, ${family}, ${scheme})`, async () => {
          const { tab, close } = await open(name, family, scheme, '&title=short&card=form');
          try {
            await tab.waitForSelector('[data-scene-form]');
            const found = await tab.evaluate(() => {
              const card = document.querySelector('.fy-card') as HTMLElement;
              const style = getComputedStyle(card);
              const field = document.querySelector('[data-scene-field]') as HTMLElement;
              const rect = field.getBoundingClientRect();
              return {
                border: style.borderLeftWidth,
                padding: style.paddingLeft,
                left: rect.left,
                right: window.innerWidth - rect.right,
                width: rect.width,
              };
            });
            expect(found.border).toBe('0px');
            expect(found.padding).toBe('0px');
            if (name === 'phone') {
              expect(found.left, 'a 16px gutter at least').toBeGreaterThanOrEqual(16);
              expect(found.left, 'and no more than a little over it').toBeLessThanOrEqual(20);
              expect(found.right).toBeGreaterThanOrEqual(16);
              expect(found.right).toBeLessThanOrEqual(20);
            }
            await shot(tab, name, `${family}-${scheme}`, 'form');
          } finally {
            await close();
          }
        });
      }
});
