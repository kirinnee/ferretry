/**
 * THE OPEN AGENDA ITEM'S HEAD IS ONE ROW, in a real browser, on a phone and a desktop, in light and dark.
 *
 * The owner (2026-11-01, &F329): "make the top bar single line for the card. it takes up too much space (follow the
 * old idea of (i) + marquee to keep it into a single line!)" and "the card form have similar problem, and the padding
 * and margins make them even smaller".
 *
 *  - The title, the status dot, ‹ n of N ›, ⋯ and ✕ share ONE row. The title is ONE line (&F920, the owner: "make sure
 *    title is marquee instead of wrap"): a marquee when too long, and where motion is reduced it is cut at a word with
 *    the whole title a tap away; it is never drawn a second time. The summary is drawn on the card under the title
 *    (F909), outside the sticky head; the quiet controls are behind ⋯.
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
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

/** This file's folder: the scene paths below are relative to it, and the builder runs here. */
const packageRoot = import.meta.dir;
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
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/agenda-head-scene.tsx'],
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
        it(`is one row with a short title, the summary on the card under it (${name}, ${family}, ${scheme})`, async () => {
          const { tab, close } = await open(name, family, scheme, '&title=short');
          try {
            const { head, title, pager } = await headBox(tab);
            expect(head.height, 'the head is one row tall').toBeLessThanOrEqual(ONE_ROW);
            expect(title.bottom, 'the title is on the controls’ row').toBeLessThanOrEqual(pager.bottom + 1);
            expect(title.top, 'the title is on the controls’ row').toBeGreaterThanOrEqual(pager.top - 1);
            expect(title.right, 'the title ends before the controls').toBeLessThanOrEqual(pager.left + 1);
            const summary = await tab.evaluate(
              () => document.querySelector('[data-agenda-description]')?.getClientRects().length ?? 0,
            );
            expect(summary, 'the summary is drawn on the card, not behind ⓘ').toBeGreaterThan(0);
            await shot(tab, name, `${family}-${scheme}`, 'short-title');
          } finally {
            await close();
          }
        });

        for (const motion of ['no-preference', 'reduce'] as const)
          it(`keeps a long title on ONE line in the same row — a marquee, or cut at a word with the rest a tap away where motion is reduced — and never draws it twice (${name}, ${family}, ${scheme}, motion ${motion})`, async () => {
            const { tab, close } = await open(name, family, scheme, '&title=long', motion);
            try {
              await tab.waitForSelector(
                motion === 'reduce' ? '[data-agenda-title][data-cut]' : '[data-agenda-title][data-marquee]',
              );
              const { head, title, pager } = await headBox(tab);
              expect(head.height, 'a long title does not make the head more than one row').toBeLessThanOrEqual(ONE_ROW);
              expect(title.right, 'the title ends before the controls').toBeLessThanOrEqual(pager.left + 1);
              const state = await tab.evaluate(() => {
                const box = document.querySelector('[data-agenda-title]') as HTMLElement;
                const text = box.querySelector('.fy-item-view__title-text') as HTMLElement;
                const lineHeight = Number.parseFloat(getComputedStyle(box).lineHeight);
                return {
                  wrap: box.getAttribute('data-wrap') !== null,
                  // A CSS animation (the marquee): a theme's colour transition is not the title moving.
                  moving: text.getAnimations().filter(each => each instanceof CSSAnimation).length,
                  shownLines: Math.round(box.clientHeight / lineHeight),
                  cut: box.querySelector('.fy-item-view__title-cut')?.textContent ?? '',
                  title: text.textContent ?? '',
                  whole: document.querySelectorAll('[data-agenda-full-title]').length,
                  controlsRight: (document.querySelector('.fy-item-view__pager') as HTMLElement).getBoundingClientRect()
                    .right,
                  width: document.documentElement.clientWidth,
                };
              });
              expect(state.wrap, 'the head never wraps the title').toBe(false);
              expect(state.shownLines, 'one line in the head').toBe(1);
              expect(state.whole, 'never a second copy in the body').toBe(0);
              expect(state.controlsRight, '‹ n/N ›, ⋯ and ✕ fit the screen').toBeLessThanOrEqual(state.width + 1);
              if (motion === 'reduce') {
                expect(state.moving, 'nothing moves').toBe(0);
                expect(state.cut.endsWith('…'), 'cut at a word, with an ellipsis').toBe(true);
                expect(state.title.startsWith(state.cut.slice(0, -1).trimEnd()), 'the cut is the title’s start').toBe(
                  true,
                );
                await shot(tab, name, `${family}-${scheme}`, 'long-title-reduced');
                await tab.locator('[data-agenda-title]').click();
                await framesSettled(tab);
                expect(
                  await tab.locator('[data-agenda-title][data-expanded]').count(),
                  'a tap shows the whole title',
                ).toBe(1);
              } else {
                expect(state.moving, 'the title scrolls to its end and back').toBeGreaterThan(0);
                await shot(tab, name, `${family}-${scheme}`, 'long-title');
              }
            } finally {
              await close();
            }
          });

        it(`draws a short title once, in the head (${name}, ${family}, ${scheme})`, async () => {
          const { tab, close } = await open(name, family, scheme, '&title=short');
          try {
            expect(await tab.locator('[data-agenda-full-title]').count()).toBe(0);
          } finally {
            await close();
          }
        });

        it(`draws the summary under the title, on the card and outside the sticky head, and the head still sticks (${name}, ${family}, ${scheme})`, async () => {
          const { tab, close } = await open(name, family, scheme, '&title=short');
          try {
            const { head } = await headBox(tab);
            const description = await tab.locator('[data-agenda-description]').boundingBox();
            expect(description, 'the summary is drawn').not.toBeNull();
            expect(description?.y ?? 0, 'under the head, not inside it').toBeGreaterThanOrEqual(head.bottom - 1);
            expect(
              await tab.locator('[data-agenda-info-toggle]').count(),
              'there is no ⓘ: the quiet controls are ⋯',
            ).toBe(0);
            await shot(tab, name, `${family}-${scheme}`, 'description');
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
