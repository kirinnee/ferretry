/**
 * SETTINGS › THIS DEVICE AND THE COMMAND BAR, in a real browser over fake data (`fixtures/frame-scene.tsx`): the real shell
 * and the stylesheet that ships; no daemon. v4 parity rows 45 and K5:
 *
 *  - THIS DEVICE: Colour mode and Text size read as words, the theme is a grid of tiles each previewing its light and its
 *    dark theme (so the swatches have a real size), and Motion is there and stills the page.
 *  - COMMAND BAR: Ctrl+K opens on a short list of places, never on a blank panel, and the panel is no taller than its rows.
 *
 * Set `FY_APP_SMALL_SHOTS_DIR` to keep `<viewport>-<theme>-<case>.png` (desktop 1280 and phone 390, light and dark).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(30_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_APP_SMALL_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-app-small-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', resolve(packageRoot, 'fixtures/frame-scene.tsx')],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the frame scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

beforeAll(async () => {
  browser = await sharedChromium();
  const { css, js } = await build();
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

const open = async (variant: (typeof VARIANTS)[number], path: string, ready: string) => {
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
  await tab.goto(`${origin}${path}`);
  try {
    await tab.waitForSelector(ready, { timeout: 8_000 });
  } catch (error) {
    throw new Error(`the scene did not draw ${ready}: ${String(error)}\n${problems.join('\n')}`);
  }
  return { tab, close: async () => await context.close() };
};

const shotOf = async (tab: Page, variant: (typeof VARIANTS)[number], name: string): Promise<void> => {
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${variant.name}-${name}.png`) });
};

describe('Settings › This device', () => {
  for (const variant of VARIANTS) {
    it(`${variant.name}: words for Mode and Text size, a theme tile grid with live swatches, and a Motion control`, async () => {
      const { tab, close } = await open(variant, '/settings', '[data-theme-tiles]');
      try {
        const labels = async (group: string) =>
          await tab.locator(`[role="radiogroup"][aria-label="${group}"] label`).allTextContents();
        expect(await labels('Colour mode')).toEqual(['Auto', 'Light', 'Dark']);
        expect(await labels('Text size')).toEqual(['Default', 'Large', 'Larger']);
        expect(await labels('Motion')).toEqual(['Follow system', 'Reduced']);
        expect(await tab.locator('.fy-page select').count(), 'no bare select on the page').toBe(0);
        expect(await tab.locator('[data-theme-tiles] [data-family-card]').count()).toBe(11);
        const swatch = await tab.locator('[data-theme-tiles] [data-swatch]').first().boundingBox();
        expect(swatch?.width ?? 0, 'a swatch has a real size').toBeGreaterThan(20);
        // The three segmented controls share one width and one left edge at 1280, and fill the row at 390.
        const boxes = await tab.evaluate(() =>
          ['Colour mode', 'Text size', 'Motion'].map(name => {
            const box = document.querySelector(`[role="radiogroup"][aria-label="${name}"]`)?.getBoundingClientRect();
            return { width: Math.round(box?.width ?? -1), left: Math.round(box?.left ?? -1) };
          }),
        );
        expect(new Set(boxes.map(box => box.width)).size, 'one width for all three').toBe(1);
        expect(new Set(boxes.map(box => box.left)).size, 'one left edge for all three').toBe(1);
        if (variant.phone) expect(boxes[0]?.width ?? 0, 'full width on a phone').toBeGreaterThan(variant.width - 80);
        // A theme's own panel shadow never spills out of its swatch over the label.
        const shadows = await tab.evaluate(() =>
          [...document.querySelectorAll('[data-theme-tiles] .kt-swatch')].map(node => getComputedStyle(node).boxShadow),
        );
        expect(shadows.filter(shadow => shadow !== 'none')).toEqual([]);
        // The page scrolls inside the app shell, so a "full page" shot of a phone is a tall window: Text size and Motion show.
        if (variant.phone) await tab.setViewportSize({ width: variant.width, height: 1_900 });
        await shotOf(tab, variant, 'this-device');
        await tab.locator('[role="radiogroup"][aria-label="Motion"] label', { hasText: 'Reduced' }).click();
        expect(await tab.evaluate(() => document.documentElement.dataset.motion)).toBe('reduced');
      } finally {
        await close();
      }
    });
  }
});

describe('the command bar', () => {
  for (const variant of VARIANTS) {
    it(`${variant.name}: opens on a short list of places, not a blank panel`, async () => {
      const { tab, close } = await open(variant, '/settings', '[data-theme-tiles]');
      try {
        await tab.keyboard.press('Control+K');
        await tab.waitForSelector('[role="dialog"][aria-label="Command bar"]');
        const rows = await tab.locator('[role="dialog"][aria-label="Command bar"] [role="option"]').count();
        expect(rows, 'at rest the bar lists places').toBeGreaterThan(0);
        // The machine's name is said once, not as title and subtitle.
        const first = await tab
          .locator('[role="dialog"][aria-label="Command bar"] [role="option"]')
          .first()
          .innerText();
        expect(first.split('workshop-host').length - 1, 'the host name appears once').toBe(1);
        const panel = await tab.locator('[role="dialog"][aria-label="Command bar"]').boundingBox();
        // A phone's rows are taller and fill the panel to its cap; a desktop's list is shorter than the cap.
        if (!variant.phone) expect(panel?.height ?? 9_999, 'the panel is no taller than its rows').toBeLessThan(420);
        await shotOf(tab, variant, 'command-bar');
      } finally {
        await close();
      }
    });
  }
});
