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
