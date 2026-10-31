/**
 * THE SHARED-BROWSER PANE DOES NOT JUMP WHEN THE BROWSER STARTS AND STOPS WORKING, in a real browser.
 *
 * The scene (`tests/integration/fixtures/browser-pane-jumpy-scene.tsx`) is the real surface header, status
 * row and controls over a stand-in page view. The page toggles the busy and loading facts the way the daemon
 * does and samples the page view's and the toolbar's top edge on every animation frame: across a long run of
 * flips the edge must never move, a blip of work must never show a label, and sustained work must show one
 * and take it back only after a pause.
 *
 * Set `FY_BROWSER_JUMPY_SHOTS_DIR` to keep `browser-<state>-<viewport>.png` for review. Without it no file is
 * written.
 */
import { afterAll, beforeAll, describe, expect } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sharedChromium } from './support/chromium.ts';
import { laneTests } from './support/lanes.ts';

const packageRoot = resolve(import.meta.dir, '../..');
const shotsDir = process.env.FY_BROWSER_JUMPY_SHOTS_DIR ?? '';

const viewports = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1_440, height: 900 },
] as const;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-browser-jumpy-'));
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(packageRoot, 'scripts/build-composer-integration-fixture.ts'),
      '--out',
      directory,
      '--entry',
      'tests/integration/fixtures/browser-pane-jumpy-scene.tsx',
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the browser-pane scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

beforeAll(async () => {
  browser = await sharedChromium();
  const { css, js } = await build();
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html,body,#root{height:100%;margin:0}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
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

const ACTIVITY = '[data-browser-activity]';
const PROGRESS = '[data-browser-progress]';

const activityText = async (tab: Page): Promise<string> => (await tab.locator(ACTIVITY).textContent()) ?? '';
const pause = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms));

/** The distinct top edges the page view and the toolbar have had since the scene loaded. */
const edges = async (tab: Page): Promise<{ page: number[]; controls: number[] }> =>
  await tab.evaluate(() => ({
    page: [...new Set(window.__tops.page.map(top => Math.round(top * 100) / 100))],
    controls: [...new Set(window.__tops.controls.map(top => Math.round(top * 100) / 100))],
  }));

const shoot = async (tab: Page, state: string, viewport: string): Promise<void> => {
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `browser-${state}-${viewport}.png`) });
};

type Viewport = (typeof viewports)[number];

const check = async (viewport: Viewport): Promise<void> => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: 'light',
    deviceScaleFactor: 2,
  });
  try {
    const origin = server?.url.origin ?? '';
    await context.route('**/*', async route =>
      new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
    );
    const tab = await context.newPage();
    await tab.goto(`${origin}/?theme=studio-light`);
    await tab.waitForSelector('[data-page-view]');
    await tab.waitForSelector(ACTIVITY, { state: 'attached' });
    await tab.waitForSelector(PROGRESS, { state: 'attached' });
    await tab.evaluate(() => {
      window.__tops = { page: [], controls: [] };
    });
    await pause(100);
    await shoot(tab, 'idle', viewport.name);

    // A blip shorter than the show delay is never announced.
    await tab.evaluate(() => window.__setBusy(true));
    await pause(120);
    await tab.evaluate(() => window.__setBusy(false));
    await pause(500);
    expect(await activityText(tab)).toBe('');

    // Sustained work shows the label once the delay has passed...
    await tab.evaluate(() => window.__setBusy(true));
    await tab.waitForFunction(selector => document.querySelector(selector)?.textContent === 'Working…', ACTIVITY, {
      timeout: 2_000,
    });
    await pause(300);
    await shoot(tab, 'working', viewport.name);

    // ...and keeps it through a short pause (the hide delay), so work in bursts reads as one run.
    await tab.evaluate(() => window.__setBusy(false));
    await pause(300);
    expect(await activityText(tab)).toBe('Working…');
    await tab.waitForFunction(selector => document.querySelector(selector)?.textContent === '', ACTIVITY, {
      timeout: 3_000,
    });

    // A long flicker: busy and loading flipping faster than either delay, then a loading page.
    for (let flip = 0; flip < 12; flip += 1) {
      await tab.evaluate(
        on => {
          window.__setBusy(on);
          window.__setLoading(on);
        },
        flip % 2 === 0,
      );
      await pause(90);
    }
    await tab.evaluate(() => {
      window.__setBusy(false);
      window.__setLoading(true);
    });
    await tab.waitForFunction(selector => document.querySelector(selector)?.textContent === 'Loading page…', ACTIVITY, {
      timeout: 2_000,
    });
    await pause(300);
    await shoot(tab, 'loading', viewport.name);
    await tab.evaluate(() => window.__setLoading(false));
    await tab.waitForFunction(selector => document.querySelector(selector)?.textContent === '', ACTIVITY, {
      timeout: 3_000,
    });

    const seen = await edges(tab);
    expect(seen.page).toHaveLength(1);
    expect(seen.controls).toHaveLength(1);

    const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const rowFits = await tab.evaluate(() => {
      const row = document.querySelector<HTMLElement>('[data-browser-status-row]');
      return row !== null && row.scrollWidth <= row.clientWidth + 1;
    });
    expect(rowFits || viewport.name === 'phone').toBe(true);
  } finally {
    await context.close();
  }
};

const lane = laneTests();

describe('the browser pane holds still while the browser works', () => {
  for (const viewport of viewports)
    lane(`never moves the page view or the toolbar as busy and loading flip (${viewport.name})`, async () => {
      await check(viewport);
    });
});
