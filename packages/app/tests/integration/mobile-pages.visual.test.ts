/**
 * EVERY PAGE LOOKS RIGHT AT A PHONE'S WIDTH (owner point 8, 2026-11-17: "make sure all the mobile layout looks nice too"), in a
 * real browser over the REAL app: every shipped plugin's own app half and its own stylesheet (`fixtures/mobile-scene.tsx`),
 * on ONE fake machine (`fixtures/mobile-fake-daemon.ts`; no daemon, no network, every name and number made up). The scene is
 * served by `serve-scene.ts` over Vite, because the app loads its views with Vite's dynamic-import variables.
 *
 * At 390px (and 360px, the narrowest phone worth drawing), light and dark, on each page the app has:
 *
 *  - NO SIDEWAYS SCROLL: the page's `scrollWidth` is no wider than its `clientWidth` (a clipped or overflowing control is how a
 *    phone page usually goes wrong);
 *  - THE PHONE'S DRAWER holds every place at its foot (r11 S1; no bottom bar), in cells at least 44px tall;
 *  - THE COMPOSER'S STATUS LINE stays inside the screen however long the model's name is (the ring and the quota keep their size,
 *    the name is what is cut short);
 *  - A FERRET ROW's title ends before its pin and ⋯ buttons, never under them.
 *
 * Set `FY_MOBILE_SHOTS_DIR` to keep `<width>-<theme>-<page>.png` (2x).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneServer, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(60_000);

const shotsDir = process.env.FY_MOBILE_SHOTS_DIR ?? '';
const scene = new URL('./fixtures/mobile-scene.tsx', import.meta.url).pathname;

let browser: Browser;
let server: ReturnType<typeof Bun.spawn> | undefined;
let origin = '';

beforeAll(async () => {
  browser = await sharedChromium();
  server = Bun.spawn([process.execPath, sceneServer, '--entry', scene], { stderr: 'inherit', stdout: 'pipe' });
  // The server's one stdout line, once it listens.
  const reader = (server.stdout as ReadableStream<Uint8Array>).getReader();
  const first = await Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the scene server did not start')), 90_000)),
  ]);
  origin = (JSON.parse(new TextDecoder().decode(first.value).trim().split('\n')[0] as string) as { origin: string })
    .origin;
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 120_000);

afterAll(() => {
  server?.kill();
});

/** Every page a phone reaches: where it is, and what proves it has drawn (not the loading line, not an error). */
const PAGES = [
  { name: 'chat', path: '/d/ws/ferrets/zoe/chat', ready: '[data-composer-send]' },
  { name: 'ferrets', path: '/d/ws/ferrets', ready: '[data-sbar-session]' },
  { name: 'agenda', path: '/d/ws/agenda', ready: '.fy-main' },
  { name: 'board', path: '/d/ws/board', ready: '.fy-main' },
  { name: 'projects', path: '/d/ws/projects', ready: '.fy-main' },
  { name: 'insights', path: '/d/ws/insights', ready: '.fy-main' },
  { name: 'settings', path: '/d/ws/settings', ready: '.fy-page' },
  { name: 'this-device', path: '/settings', ready: '[data-palette-chips]' },
  { name: 'pair', path: '/pair', ready: '.fy-main' },
] as const;

const WIDTHS = [390, 360] as const;
const THEMES = ['light', 'dark'] as const;

const open = async (width: number, theme: 'light' | 'dark', path: string, ready: string) => {
  const context = await browser.newContext({
    viewport: { width, height: 844 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
    colorScheme: theme,
  });
  const tab = await context.newPage();
  tab.setDefaultTimeout(20_000);
  const problems: string[] = [];
  tab.on('pageerror', error => problems.push(error.message));
  const joiner = path.includes('?') ? '&' : '?';
  await tab.goto(`${origin}${path}${joiner}theme=studio-${theme}`);
  try {
    await tab.waitForSelector(ready, { timeout: 30_000 });
  } catch (error) {
    throw new Error(`${path} did not draw ${ready}: ${String(error)}\n${problems.join('\n')}`);
  }
  // Lazily loaded views and the first reads settle.
  await tab.waitForTimeout(1_500);
  return { tab, problems, close: async () => await context.close() };
};

const shot = async (tab: Page, width: number, theme: string, name: string): Promise<void> => {
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${width}-${theme}-${name}.png`) });
};

describe('no page scrolls sideways at a phone width', () => {
  // 360 is a spot check: one theme is enough to see a width go wrong.
  for (const width of WIDTHS)
    for (const theme of THEMES)
      for (const page of PAGES)
        if (!(width === 360 && theme === 'dark'))
          it(`${page.name} at ${width}, ${theme}`, async () => {
            const { tab, problems, close } = await open(width, theme, page.path, page.ready);
            try {
              await shot(tab, width, theme, page.name);
              const sizes = await tab.evaluate(() => ({
                page: [document.documentElement.scrollWidth, document.documentElement.clientWidth],
                body: [document.body.scrollWidth, document.body.clientWidth],
              }));
              expect(sizes.page[0], 'the page is no wider than the screen').toBeLessThanOrEqual(sizes.page[1] ?? 0);
              expect(sizes.body[0], 'the body is no wider than the screen').toBeLessThanOrEqual(sizes.body[1] ?? 0);
              expect(problems, 'the page threw').toEqual([]);
            } finally {
              await close();
            }
          });
});

describe('the places on a phone (r11 S1, owner C2: in the drawer at its foot, no bottom bar)', () => {
  for (const width of WIDTHS)
    it(`at ${width}: no bottom bar; the menu opens a drawer whose dock holds every place, each a finger tall, none over the next`, async () => {
      const { tab, close } = await open(width, 'light', '/d/ws/agenda', '.fy-main');
      try {
        expect(await tab.locator('.fy-nav--bottom, [data-slot="bottom"]').count(), 'no bottom bar').toBe(0);
        await tab.click('button[aria-label="Menu"]');
        await tab.waitForSelector('.fy-drawer--overlay');
        const seen = await tab.evaluate(() => {
          const drawer = document.querySelector('.fy-drawer')?.getBoundingClientRect();
          return {
            drawerRight: drawer?.right ?? 0,
            drawerBottom: drawer?.bottom ?? 0,
            cells: [...document.querySelectorAll('nav[data-nav="dock"] .fy-nav__item')].map(item => {
              const box = item.getBoundingClientRect();
              return {
                text: (item.querySelector('.sr-only, .fy-nav__label')?.textContent ?? '').trim(),
                left: box.left,
                right: box.right,
                bottom: box.bottom,
                height: box.height,
                width: box.width,
              };
            }),
          };
        });
        expect(seen.cells.map(cell => cell.text)).toEqual([
          'Ferrets',
          'Agenda',
          'Board',
          'Projects',
          'Insights',
          'Settings',
        ]);
        for (const cell of seen.cells) {
          expect(cell.height, `${cell.text} is a finger tall`).toBeGreaterThanOrEqual(44);
          expect(cell.width, `${cell.text} is a finger wide`).toBeGreaterThanOrEqual(40);
          expect(cell.left).toBeGreaterThanOrEqual(0);
          expect(cell.right, `${cell.text} is inside the drawer`).toBeLessThanOrEqual(seen.drawerRight + 1);
          expect(cell.bottom, `${cell.text} is inside the drawer foot`).toBeLessThanOrEqual(seen.drawerBottom + 1);
        }
      } finally {
        await close();
      }
    });
});

describe('the composer on a phone', () => {
  for (const width of WIDTHS)
    it(`at ${width}: the longest model readout is cut short, the thinking and speed readouts, the ring and quota stay on screen on one line`, async () => {
      const { tab, close } = await open(
        width,
        'light',
        '/d/ws/ferrets/zoe/chat?model=claude-opus-5-5-20261101[1m]&effort=xhigh&fast=1',
        '[data-composer-send]',
      );
      try {
        await shot(tab, width, 'light', 'chat-long-model');
        const line = await tab.evaluate(() => {
          const actions = document.querySelector('.fy-composer-actions')?.getBoundingClientRect();
          const quota = document.querySelector('.fy-composer-quota')?.getBoundingClientRect();
          const chip = [...document.querySelectorAll('[data-runtime-chip]')].at(-1)?.getBoundingClientRect();
          const tops = [...document.querySelectorAll('[data-runtime-chip]')].map(node =>
            Math.round(node.getBoundingClientRect().top),
          );
          return { actions, quota, chip, tops, wide: document.documentElement.clientWidth };
        });
        expect(line.quota?.right ?? Number.POSITIVE_INFINITY, 'the quota is on screen').toBeLessThanOrEqual(line.wide);
        expect(line.tops, 'model, thinking and speed: three readouts').toHaveLength(3);
        expect(new Set(line.tops).size, 'on one line').toBe(1);
        expect(line.chip?.right ?? 0, 'the last readout ends before the quota').toBeLessThanOrEqual(
          (line.quota?.left ?? 0) + 1,
        );
        expect(line.actions?.height ?? 0, 'the status line is one line').toBeLessThan(40);
      } finally {
        await close();
      }
    });
});

describe('a ferret row', () => {
  for (const width of WIDTHS)
    it(`at ${width}: the title ends before the pin and ⋯ buttons`, async () => {
      const { tab, close } = await open(width, 'light', '/d/ws/ferrets', '[data-sbar-session]');
      try {
        const rows = await tab.evaluate(() =>
          [...document.querySelectorAll('[data-sbar-row]')].map(row => {
            const title = row.querySelector('.fy-sbar__title')?.getBoundingClientRect();
            const buttons = [...row.querySelectorAll(':scope > button')].map(button => button.getBoundingClientRect());
            return { title: title?.right ?? 0, first: Math.min(...buttons.map(button => button.left)) };
          }),
        );
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows)
          expect(row.title, 'the title ends before the buttons').toBeLessThanOrEqual(row.first + 1);
      } finally {
        await close();
      }
    });
});

describe('where you are', () => {
  it('on a phone the dock in the drawer marks the page on screen as the current place', async () => {
    const { tab, close } = await open(390, 'light', '/d/ws/agenda', '.fy-main');
    try {
      await tab.click('button[aria-label="Menu"]');
      await tab.waitForSelector('.fy-drawer--overlay');
      const current = await tab.evaluate(() =>
        [...document.querySelectorAll('nav[data-nav="dock"] .fy-nav__item[aria-current="page"]')].map(item =>
          (item.querySelector('.sr-only, .fy-nav__label')?.textContent ?? '').trim(),
        ),
      );
      expect(current).toEqual(['Agenda']);
    } finally {
      await close();
    }
  });
});
