/**
 * THE "THIS DEVICE" CONTROLS THAT DO SOMETHING, in a real browser over fake data (`fixtures/device-controls-scene.tsx`):
 * the real shell and the real app halves of Ferrets, Browsers and Agenda over one fake machine; no daemon.
 *
 *  - SETTINGS › THIS DEVICE carries the shell's "Cached data" row. (The plugins' own rows are drawn by their own visual tests.)
 *
 * Set `FY_DEVICE_CONTROLS_SHOTS_DIR` to keep `<viewport>-<theme>-<case>.png` (desktop 1280 and phone 390, light and dark).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(30_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_DEVICE_CONTROLS_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-device-controls-'));
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
  if (code !== 0) throw new Error(`the device controls scene did not build (${code}):\n${stderr}\n${stdout}`);
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

const shotOf = async (tab: Page, variant: (typeof VARIANTS)[number], name: string): Promise<void> => {
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${variant.name}-${name}.png`) });
};

describe('Settings › This device', () => {
  for (const variant of VARIANTS) {
    it(`${variant.name}: Cached data is a row of the page, with a Clear button`, async () => {
      const { tab, close } = await open(variant, '/settings', '[data-setting-row="Cached data"]');
      try {
        expect(
          await tab.locator('[data-setting-row="Cached data"] button[aria-label="Clear cached data"]').count(),
        ).toBe(1);
        // The page scrolls inside the app shell, so a "full page" shot of a phone is a tall window.
        if (variant.phone) await tab.setViewportSize({ width: variant.width, height: 2_300 });
        await shotOf(tab, variant, 'this-device');
        await tab.locator('[data-setting-row="Cached data"] button[aria-label="Clear cached data"]').click();
        expect(await tab.locator('[data-setting-row="Cached data"]').innerText()).toContain(
          'Clear this device’s cached data?',
        );
        await shotOf(tab, variant, 'this-device-cached-data-asking');
      } finally {
        await close();
      }
    });
  }
});
