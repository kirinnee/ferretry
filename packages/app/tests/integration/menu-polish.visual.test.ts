/**
 * THE SHARED MENU in a real browser (`fixtures/menu-polish-scene.tsx`): the real `ContextMenu` over fake data, in both
 * modes at a desktop and a phone. Owner (2026-11-17): "the dropdown is not well design, outlines unclear". Measured, not
 * eyeballed, against the WCAG floors the doctrine names:
 *
 *  - the popover's edge is a >=3:1 control edge against the page, and the menu is one step off a dark page;
 *  - a row's text is >=4.5:1 on the menu, hover is a visible wash, and the keyboard cursor row draws a >=3:1 focus ring.
 *
 * Set `FY_MENU_POLISH_SHOTS_DIR` to keep `<viewport>-<mode>-<state>.png` (2x).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(30_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_MENU_POLISH_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-menu-polish-'));
  const child = Bun.spawn(
    [
      process.execPath,
      sceneBuilder,
      '--out',
      directory,
      '--entry',
      resolve(packageRoot, 'fixtures/menu-polish-scene.tsx'),
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the menu scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  browser = await sharedChromium();
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request =>
      new URL(request.url).pathname === '/app.js'
        ? new Response(js, { headers: { 'content-type': 'text/javascript' } })
        : new Response(page, { headers: { 'content-type': 'text/html' } }),
  });
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const SIZES = [
  { name: '1280', width: 1_280, height: 640, phone: false },
  { name: '390', width: 390, height: 640, phone: true },
] as const;

/** Resolve any CSS colour (rgb, color-mix, color()) to sRGB bytes through a canvas, in the page's own engine. */
const channels = async (tab: Page, css: string): Promise<readonly [number, number, number]> =>
  await tab.evaluate(value => {
    const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    if (context === null) throw new Error('no canvas');
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return [r ?? 0, g ?? 0, b ?? 0] as const;
  }, css);

const luminance = ([r, g, b]: readonly [number, number, number]): number => {
  const lin = (v: number) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const contrast = (a: readonly [number, number, number], b: readonly [number, number, number]): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

const open = async (size: (typeof SIZES)[number], mode: 'light' | 'dark') => {
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    colorScheme: mode,
    deviceScaleFactor: 2,
    hasTouch: size.phone,
    isMobile: size.phone,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  await tab.goto(`${origin}/?theme=studio-${mode}${size.phone ? '&touch=1' : ''}`);
  await tab.waitForSelector('[role="menu"] [role="menuitem"]');
  return { tab, close: async () => await context.close() };
};

const colours = async (tab: Page, selector: string, property: string): Promise<string> =>
  await tab.evaluate(
    ({ query, name }) => getComputedStyle(document.querySelector(query) as Element).getPropertyValue(name),
    { query: selector, name: property },
  );

for (const size of SIZES)
  for (const mode of ['light', 'dark'] as const)
    describe(`the shared menu at ${size.name} in ${mode}`, () => {
      it('has a >=3:1 edge against the page and readable rows; hover is a wash; the keyboard cursor draws a >=3:1 ring', async () => {
        const { tab, close } = await open(size, mode);
        try {
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${size.name}-${mode}-menu.png`) });
          const page = await channels(tab, await colours(tab, 'body', 'background-color'));
          const menu = await tab.evaluate(() => {
            const element = document.querySelector('[role="menu"]') as HTMLElement;
            const style = getComputedStyle(element);
            return { edge: style.borderTopColor, bg: style.backgroundColor, width: style.borderTopWidth };
          });
          expect(Number.parseFloat(menu.width), 'the edge is drawn').toBeGreaterThanOrEqual(1);
          const edge = await channels(tab, menu.edge);
          expect(contrast(edge, page), 'the popover edge against the page (WCAG 1.4.11)').toBeGreaterThanOrEqual(3);
          const surface = await channels(tab, menu.bg);
          if (mode === 'dark')
            expect(luminance(surface), 'a dark menu is raised off its page').toBeGreaterThan(luminance(page));

          const row = tab.locator('[role="menuitem"]').nth(1);
          const ink = await channels(tab, await row.evaluate(node => getComputedStyle(node).color));
          expect(contrast(ink, surface), 'row text on the menu').toBeGreaterThanOrEqual(4.5);

          // Hover: a pointer over a row changes its fill (and is not the cursor's accent fill).
          await row.hover();
          const hovered = await channels(tab, await row.evaluate(node => getComputedStyle(node).backgroundColor));
          expect(contrast(hovered, surface), 'a hovered row is distinguishable from the menu').toBeGreaterThan(1.05);
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${size.name}-${mode}-menu-hover.png`) });

          // Keyboard: the cursor row draws the shared focus ring, in the focus colour, >=3:1 against the row.
          await tab.keyboard.press('ArrowDown');
          await tab.keyboard.press('ArrowDown');
          const ring = await tab.evaluate(() => {
            const focused = document.activeElement as HTMLElement;
            const style = getComputedStyle(focused);
            return {
              role: focused.getAttribute('role'),
              style: style.outlineStyle,
              width: style.outlineWidth,
              color: style.outlineColor,
              bg: style.backgroundColor,
              ownColor: getComputedStyle(document.documentElement).getPropertyValue('--focus-color'),
            };
          });
          expect(ring.role).toBe('menuitem');
          expect(ring.style, 'a ring is drawn on the cursor row').toBe('solid');
          expect(Number.parseFloat(ring.width), 'at least the 2px focus width').toBeGreaterThanOrEqual(2);
          const ringColour = await channels(tab, ring.color);
          expect(
            contrast(ringColour, await channels(tab, ring.bg === 'rgba(0, 0, 0, 0)' ? menu.bg : ring.bg)),
            'the ring against its row',
          ).toBeGreaterThanOrEqual(3);
          // ONE highlight: the pointer still rests on the other row, but only the keyboard row reads as active.
          expect(
            await row.evaluate(node => getComputedStyle(node).backgroundColor),
            'a row the pointer rests on is not a second highlight while the ring is elsewhere',
          ).toBe('rgba(0, 0, 0, 0)');
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${size.name}-${mode}-menu-focus.png`) });
        } finally {
          await close();
        }
      });
    });

/**
 * EVERY theme, light and dark (the list is the families' `data-theme` ids; a family without a light palette of its own wears
 * the baseline's). The first pass only looked at Studio, and the families that restate their palette (Phosphor, Blueprint,
 * Broadsheet, Wayfinding, Ledger, Ma) inherited Studio LIGHT's focus ring and edge: a 1.3:1 ring on their dark menus and a
 * 2.7:1 edge on three light pages. Measured per theme: the edge against the page, row text on the menu, the keyboard ring
 * against the menu AND against a checked row, and a danger row that keeps its red under hover and under the keyboard's ring.
 */
const FAMILIES = [
  'studio',
  'mission',
  'neo',
  'geist',
  'contrast',
  'phosphor',
  'blueprint',
  'broadsheet',
  'wayfinding',
  'ledger',
  'ma',
] as const;
const THEMES = FAMILIES.flatMap(family => [`${family}-light`, `${family}-dark`] as const);

const phoneless = { name: '1280', width: 1_280, height: 640, phone: false } as const;

const openTheme = async (theme: string, query = '') => {
  const context = await browser.newContext({
    viewport: { width: phoneless.width, height: phoneless.height },
    colorScheme: theme.endsWith('-dark') ? 'dark' : 'light',
    deviceScaleFactor: 2,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  await tab.goto(`${origin}/?theme=${theme}${query}`);
  return { tab, close: async () => await context.close() };
};

describe('the shared menu in every theme', () => {
  for (const theme of THEMES)
    it(`${theme}: >=3:1 edge, readable rows, a >=3:1 ring on the menu and on a checked row, a danger row that stays red`, async () => {
      const { tab, close } = await openTheme(theme);
      try {
        await tab.waitForSelector('[role="menu"] [role="menuitem"]');
        const page = await channels(tab, await colours(tab, 'body', 'background-color'));
        const menu = await tab.evaluate(() => {
          const style = getComputedStyle(document.querySelector('[role="menu"]') as HTMLElement);
          return { edge: style.borderTopColor, bg: style.backgroundColor };
        });
        const surface = await channels(tab, menu.bg);
        expect(
          contrast(await channels(tab, menu.edge), page),
          `${theme}: the edge against the page`,
        ).toBeGreaterThanOrEqual(3);

        const rename = tab.locator('[role="menuitem"]').nth(1);
        expect(
          contrast(await channels(tab, await rename.evaluate(node => getComputedStyle(node).color)), surface),
          `${theme}: row text on the menu`,
        ).toBeGreaterThanOrEqual(4.5);

        // The keyboard ring, on the plain menu and then on a CHECKED row (the accent fill the ring sits on).
        await tab.keyboard.press('ArrowDown');
        await tab.keyboard.press('ArrowDown');
        const ring = await tab.evaluate(() => {
          const focused = document.activeElement as HTMLElement;
          const style = getComputedStyle(focused);
          return { colour: style.outlineColor, width: style.outlineWidth, line: style.outlineStyle };
        });
        expect(ring.line, `${theme}: a ring is drawn`).toBe('solid');
        expect(Number.parseFloat(ring.width)).toBeGreaterThanOrEqual(2);
        const ringColour = await channels(tab, ring.colour);
        expect(contrast(ringColour, surface), `${theme}: the ring against the menu`).toBeGreaterThanOrEqual(3);
        const checked = await tab.evaluate(() => {
          const focused = document.activeElement as HTMLElement;
          focused.setAttribute('aria-checked', 'true');
          return getComputedStyle(focused).backgroundColor;
        });
        expect(
          contrast(ringColour, await channels(tab, checked)),
          `${theme}: the ring against a checked row`,
        ).toBeGreaterThanOrEqual(3);
        await tab.evaluate(() => document.activeElement?.removeAttribute('aria-checked'));

        // A danger row keeps its red: at rest, hovered, and hovered while the ring is on another row.
        const stop = tab.locator('[role="menuitem"]').nth(4);
        const ink = (): Promise<string> => stop.evaluate(node => getComputedStyle(node).color);
        const err = await channels(tab, await colours(tab, 'html', '--err'));
        expect(await channels(tab, await ink()), `${theme}: danger at rest`).toEqual(err);
        await stop.hover();
        expect(await channels(tab, await ink()), `${theme}: danger hovered`).toEqual(err);
        await tab.keyboard.press('ArrowUp');
        await tab.keyboard.press('ArrowUp');
        await stop.hover();
        expect(await channels(tab, await ink()), `${theme}: danger hovered while the ring is on another row`).toEqual(
          err,
        );
        if (shotsDir !== '' && (theme === 'phosphor-dark' || theme === 'ledger-dark'))
          await tab.screenshot({ path: join(shotsDir, `1280-${theme}-menu-focus-danger-hover.png`) });
      } finally {
        await close();
      }
    });
});

describe('the picker option list keeps the row sizes the picker asked for', () => {
  for (const theme of ['studio-light', 'studio-dark', 'phosphor-dark'])
    it(`${theme}: 44px rows, top-aligned, in the full ink, a disabled row muted`, async () => {
      const { tab, close } = await openTheme(theme, '&picker=1');
      try {
        await tab.locator('input[role="combobox"]').focus();
        await tab.waitForSelector('[role="option"]');
        const rows = await tab.evaluate(() =>
          [...document.querySelectorAll('[role="option"]')].map(node => {
            const style = getComputedStyle(node);
            return { height: node.getBoundingClientRect().height, align: style.alignItems, ink: style.color };
          }),
        );
        const fg = await channels(tab, await colours(tab, 'body', 'color'));
        const muted = await channels(tab, await colours(tab, 'html', '--muted'));
        for (const row of rows) {
          expect(row.height, 'the picker asked for 44px rows').toBeGreaterThanOrEqual(44);
          expect(row.align, 'a multi-line row keeps its label at the top').toBe('flex-start');
        }
        expect(await channels(tab, rows[1]?.ink ?? ''), 'an enabled row is in the full ink, not the soft one').toEqual(
          fg,
        );
        expect(await channels(tab, rows[2]?.ink ?? ''), 'a disabled row is muted').toEqual(muted);
        if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `1280-${theme}-picker.png`) });
      } finally {
        await close();
      }
    });
});
