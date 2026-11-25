/**
 * THE FULL-PAGE "CANNOT USE THIS MACHINE" SCREENS, in a real browser, on a phone and a desktop, in light and dark, over fake
 * data (`fixtures/machine-stop-scene.tsx`): every end state is ONE page — a plain headline, a sentence of why, one main button,
 * quieter ways out — with none of the shell's chrome left behind. No daemon, no pairing code, no real path.
 *
 * Set `FY_MACHINE_STOP_SHOTS_DIR` to keep `<state>-<width>-<scheme>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(30_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_MACHINE_STOP_SHOTS_DIR ?? '';
/** The style the shots are taken in (the pages must read in every look); the proof runs in the default, `studio`. */
const style = process.env.FY_MACHINE_STOP_STYLE ?? 'studio';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-machine-stop-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/machine-stop-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the scene did not build (${code}):\n${stderr}\n${stdout}`);
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
  { name: '1440', width: 1_440, height: 900, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;

const STATES = [
  { state: 'refused', headline: "This browser isn't connected to pebox any more", main: 'Pair again', other: true },
  { state: 'turned-away', headline: 'This browser was turned away by pebox', main: 'Pair again', other: false },
  { state: 'no-key', headline: "This browser can't reach pebox", main: 'Pair again', other: false },
  { state: 'unreadable', headline: "Can't read what pebox offers right now", main: 'Reload', other: false },
  { state: 'needs-update', headline: 'Update pebox to keep using it', main: 'Reload', other: false },
  { state: 'needs-reload', headline: 'This app needs a reload to use pebox', main: 'Reload', other: false },
  {
    state: 'not-paired',
    headline: "This browser isn't paired with that machine",
    main: 'Pair a machine',
    other: false,
  },
] as const;

const open = async (viewport: (typeof VIEWPORTS)[number], scheme: 'light' | 'dark', state: string) => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: scheme,
    deviceScaleFactor: viewport.phone ? 2 : 1,
    hasTouch: viewport.phone,
    isMobile: viewport.phone,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab: Page = await context.newPage();
  await tab.goto(`${origin}/d/ws?theme=studio-${scheme}&style=${style}&state=${state}`);
  await tab.waitForSelector(`[data-machine-stop="${state}"]`, { timeout: 15_000 });
  await tab.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  return { tab, close: async () => await context.close() };
};

describe('every machine the browser cannot use at all is one full page', () => {
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      for (const { state, headline, main, other } of STATES)
        it(`${state}: one page, no chrome, focus on the headline (${viewport.name}, ${scheme})`, async () => {
          const { tab, close } = await open(viewport, scheme, state);
          try {
            expect(await tab.locator('h1').allTextContents()).toEqual([headline]);
            // The shell's chrome is gone: no drawer, find box, nav icons or title bar.
            expect(
              await tab
                .locator('.fy-drawer, [data-slot="bottom"], [data-slot="phone-title"], [data-drawer-find], nav')
                .count(),
            ).toBe(0);
            expect(await tab.evaluate(() => document.activeElement?.tagName)).toBe('H1');
            expect(await tab.locator('button.kt-btn').allTextContents()).toEqual([main]);
            expect(await tab.getByText('Use another machine').count()).toBe(other ? 1 : 0);
            expect(await tab.getByText('Connection settings').count()).toBe(1);
            // No sideways scroll, and the headline and the main button are fully on screen.
            expect(
              await tab.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
            ).toBeLessThanOrEqual(0);
            for (const selector of ['h1', 'button.kt-btn']) {
              const box = await tab.locator(selector).boundingBox();
              expect(box, selector).not.toBeNull();
              expect(
                (box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= viewport.width,
                `${selector} inside`,
              ).toBe(true);
              expect(
                (box?.y ?? -1) >= 0 && (box?.y ?? 0) + (box?.height ?? 0) <= viewport.height,
                `${selector} above the fold`,
              ).toBe(true);
            }
            if (shotsDir !== '')
              await tab.screenshot({
                path: join(shotsDir, `${state}-${viewport.name}-${scheme}${style === 'studio' ? '' : `-${style}`}.png`),
                fullPage: true,
              });
          } finally {
            await close();
          }
        });
});
