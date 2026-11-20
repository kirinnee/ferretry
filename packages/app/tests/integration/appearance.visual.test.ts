/**
 * SETTINGS › THIS DEVICE › LOOK in a real browser over fake data (`fixtures/device-controls-scene.tsx`, no daemon): Style
 * as cards drawn in their own style, Palette as two-colour chips, Colour mode, and ONE specimen. Every one of the 5
 * styles x 2 palettes x light/dark renders at 1280 and 390 without sideways overflow, with the specimen's focus ring
 * drawn (>= 2px) and every card and chip showing its own look.
 *
 * Set `FY_APPEARANCE_SHOTS_DIR` to keep `<viewport>-<style>-<palette>-<mode>.png` (the Look group) and one contact sheet
 * per viewport, `<viewport>-sheet.png`, with all 20 frames.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(120_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_APPEARANCE_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-appearance-'));
  const child = Bun.spawn(
    [
      process.execPath,
      sceneBuilder,
      '--out',
      directory,
      '--entry',
      resolve(packageRoot, 'fixtures/device-controls-scene.tsx'),
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the appearance scene did not build (${code}):\n${stderr}\n${stdout}`);
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

const VIEWPORTS = [
  { name: '1280', width: 1_280, height: 3_200, phone: false },
  { name: '390', width: 390, height: 3_200, phone: true },
] as const;
const STYLES = ['studio', 'mission', 'neo', 'geist', 'hud'] as const;
const PALETTES = ['neo', 'hacker'] as const;
const MODES = ['Light', 'Dark'] as const;

const open = async (viewport: (typeof VIEWPORTS)[number]) => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    hasTouch: viewport.phone,
    isMobile: viewport.phone,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  tab.setDefaultTimeout(10_000);
  const problems: string[] = [];
  tab.on('pageerror', error => problems.push(error.message));
  await tab.goto(`${origin}/settings`);
  await tab.waitForSelector('[data-specimen]');
  return { tab, problems, close: async () => await context.close() };
};

const choose = async (tab: Page, style: string, palette: string, mode: string): Promise<void> => {
  await tab.locator(`[data-choice="${style}"]`).click();
  await tab.locator(`[data-palette-chip="${palette}"]`).click();
  await tab.locator('[role="radiogroup"][aria-label="Colour mode"] label', { hasText: mode }).click();
  // Let the one replay finish so every frame is its resting state.
  await tab.waitForTimeout(1_500);
};

describe('Settings › This device › Look', () => {
  for (const viewport of VIEWPORTS) {
    it(`${viewport.name}: 5 styles x 2 palettes x light/dark each draw the cards, chips and one specimen without overflow`, async () => {
      const { tab, problems, close } = await open(viewport);
      const frames: { readonly name: string; readonly png: Buffer }[] = [];
      try {
        for (const style of STYLES) {
          for (const palette of PALETTES) {
            for (const mode of MODES) {
              await choose(tab, style, palette, mode);
              const name = `${viewport.name}-${style}-${palette}-${mode.toLowerCase()}`;
              const root = await tab.evaluate(() => ({
                style: document.documentElement.dataset.style,
                palette: document.documentElement.dataset.palette,
                mode: document.documentElement.dataset.mode,
                wide: document.documentElement.scrollWidth > window.innerWidth,
              }));
              expect(root, name).toEqual({ style, palette, mode: mode.toLowerCase(), wide: false });
              // One specimen, and its focused input draws a real ring (>= 2px).
              expect(await tab.locator('[data-specimen]').count(), name).toBe(1);
              const ring = await tab.locator('.fy-spec__input').evaluate(node => {
                const css = getComputedStyle(node);
                return { width: parseFloat(css.outlineWidth), style: css.outlineStyle };
              });
              expect(ring.style, name).toBe('solid');
              expect(ring.width, name).toBeGreaterThanOrEqual(2);
              // The specimen never spills out of its container.
              expect(
                await tab.locator('[data-specimen]').evaluate(node => node.scrollWidth <= node.clientWidth + 1),
                `${name}: the specimen fits`,
              ).toBe(true);
              const group = tab.locator('[data-setting-group="Look"]');
              frames.push({ name, png: await group.screenshot() });
            }
          }
        }
        expect(problems).toEqual([]);
        if (shotsDir !== '') {
          for (const frame of frames) await Bun.write(join(shotsDir, `${frame.name}.png`), frame.png);
          const cells = frames
            .map(
              frame =>
                `<figure><img src="data:image/png;base64,${frame.png.toString('base64')}"><figcaption>${frame.name}</figcaption></figure>`,
            )
            .join('');
          const sheet = await tab.context().newPage();
          await sheet.setContent(
            `<!doctype html><body style="margin:0;background:#888;font:12px sans-serif"><div style="display:grid;grid-template-columns:repeat(${viewport.phone ? 5 : 2},1fr);gap:8px;padding:8px">${cells}</div><style>figure{margin:0}img{width:100%;display:block}</style>`,
          );
          await sheet.screenshot({ path: join(shotsDir, `${viewport.name}-sheet.png`), fullPage: true });
        }
      } finally {
        await close();
      }
    });
  }
});
