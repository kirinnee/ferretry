/**
 * RESIZABLE PANELS in a real browser over fake data (r10 S3): the drawer and the settings list are dragged with a real mouse
 * (and the width is what the page measures), a reload keeps the width, a double-click puts it back, and a phone has no handles.
 *
 * Set `FY_PANEL_RESIZE_SHOTS_DIR` to keep `<viewport>-<case>.png` (1280 with the handle hovered, light and dark; 390).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(30_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_PANEL_RESIZE_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-panel-resize-'));
  const child = Bun.spawn(
    [
      process.execPath,
      sceneBuilder,
      '--out',
      directory,
      '--entry',
      resolve(packageRoot, 'fixtures/settings-shell-scene.tsx'),
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the panel resize scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      return new Response(page, { headers: { 'content-type': 'text/html' } });
    },
  });
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VARIANTS = [
  { name: '1280-light', width: 1_280, height: 800, phone: false, scheme: 'light' },
  { name: '1280-dark', width: 1_280, height: 800, phone: false, scheme: 'dark' },
  { name: '390-light', width: 390, height: 844, phone: true, scheme: 'light' },
  { name: '390-dark', width: 390, height: 844, phone: true, scheme: 'dark' },
] as const;

type Variant = { name: string; width: number; height: number; phone: boolean; scheme: 'light' | 'dark' };

const open = async (variant: Variant, path: string, ready: string) => {
  const context = await browser.newContext({
    viewport: { width: variant.width, height: variant.height },
    deviceScaleFactor: variant.phone ? 2 : 1,
    hasTouch: variant.phone,
    isMobile: variant.phone,
    colorScheme: variant.scheme,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  tab.setDefaultTimeout(8_000);
  const problems: string[] = [];
  tab.on('pageerror', error => problems.push(error.message));
  const theme = `studio-${variant.scheme}`;
  await tab.goto(`${origin}${path}${path.includes('?') ? '&' : '?'}theme=${theme}`);
  try {
    await tab.waitForSelector(ready, { timeout: 8_000 });
  } catch (error) {
    const seen = (
      await tab
        .locator('body')
        .innerText()
        .catch(() => '')
    ).slice(0, 600);
    throw new Error(`the scene did not draw ${ready}: ${String(error)}\n${problems.join('\n')}\nON SCREEN: ${seen}`);
  }
  return { tab, close: async () => await context.close() };
};

const shotOf = async (tab: Page, variant: Variant, name: string): Promise<void> => {
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${variant.name}-${name}.png`) });
};

const widthOf = async (tab: Page, selector: string): Promise<number> =>
  await tab
    .locator(selector)
    .first()
    .evaluate(node => node.getBoundingClientRect().width);

/** Drags a handle by `dx` pixels with a real mouse, from the middle of its strip. */
const drag = async (tab: Page, panel: string, dx: number): Promise<void> => {
  const strip = tab.locator(`[data-resize-handle="${panel}"]`);
  const box = await strip.evaluate(node => {
    const rect = node.getBoundingClientRect();
    return { x: rect.left, y: window.innerHeight / 2 };
  });
  await tab.mouse.move(box.x, box.y);
  await tab.mouse.down();
  await tab.mouse.move(box.x + dx / 2, box.y, { steps: 4 });
  await tab.mouse.move(box.x + dx, box.y, { steps: 4 });
  await tab.mouse.up();
};

/** Puts the real mouse on a strip (it is zero wide: its hit area is the pseudo-element around its edge). */
const hover = async (tab: Page, panel: string): Promise<void> => {
  const at = await tab.locator(`[data-resize-handle="${panel}"]`).evaluate(node => ({
    x: node.getBoundingClientRect().left,
    y: window.innerHeight / 2,
  }));
  await tab.mouse.move(at.x - 100, at.y);
  await tab.mouse.move(at.x, at.y);
  await tab.waitForTimeout(250); // the line fades in over 120ms
};

/** The strips whose visible line is painted right now. */
const lit = async (tab: Page): Promise<string[]> =>
  await tab
    .locator('[data-resize-handle]')
    .evaluateAll(nodes =>
      nodes
        .filter(node => getComputedStyle(node, '::after').backgroundColor !== 'rgba(0, 0, 0, 0)')
        .map(node => node.getAttribute('data-resize-handle') ?? ''),
    );

const WIDE = VARIANTS.filter(variant => !variant.phone);
const PHONE = VARIANTS.filter(variant => variant.phone);

describe('Resizable panels', () => {
  for (const variant of WIDE) {
    it(`${variant.name}: the drawer and the settings list drag, stay inside their range, survive a reload and reset`, async () => {
      const { tab, close } = await open(variant, '/d/ws/settings', '.fy-drawer');
      try {
        const drawer = await widthOf(tab, '.fy-drawer');
        await tab.waitForSelector('[data-resize-handle="drawer"]', { state: 'attached' });
        await drag(tab, 'drawer', 60);
        expect(Math.abs((await widthOf(tab, '.fy-drawer')) - (drawer + 60))).toBeLessThan(2);
        await drag(tab, 'drawer', 900);
        expect(await widthOf(tab, '.fy-drawer')).toBe(400);
        const nav = await widthOf(tab, '.fy-settings-nav');
        await drag(tab, 'settings-nav', -900);
        expect(await widthOf(tab, '.fy-settings-nav')).toBe(180);
        expect(nav).toBeGreaterThan(180);
        await drag(tab, 'settings-nav', 40);
        await tab.reload();
        await tab.waitForSelector('.fy-drawer');
        expect(await widthOf(tab, '.fy-drawer')).toBe(400);
        expect(Math.abs((await widthOf(tab, '.fy-settings-nav')) - 220)).toBeLessThan(2);
        // Hovering a strip lights ONLY that strip: one solid accent line.
        await hover(tab, 'settings-nav');
        expect(await lit(tab)).toEqual(['settings-nav']);
        await shotOf(tab, variant, 'settings-handle-hovered');
        await hover(tab, 'drawer');
        expect(await lit(tab)).toEqual(['drawer']);
        await shotOf(tab, variant, 'drawer-handle-hovered');
        await tab.locator('[data-resize-handle="drawer"]').dblclick({ force: true, position: { x: 0, y: 300 } });
        expect(Math.abs((await widthOf(tab, '.fy-drawer')) - drawer)).toBeLessThan(2);
      } finally {
        await close();
      }
    });
  }

  for (const variant of PHONE) {
    it(`${variant.name}: a phone has no handles`, async () => {
      const { tab, close } = await open(variant, '/d/ws/settings', 'nav[aria-label="Plugin settings"]');
      try {
        expect(await tab.locator('[data-resize-handle]').count()).toBe(0);
        await shotOf(tab, variant, 'no-handles');
      } finally {
        await close();
      }
    });
  }
});
