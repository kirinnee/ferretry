/**
 * THE MAP STYLE in a real browser over fake data (`fixtures/map-style-scene.tsx`): the Settings row and a map in each
 * style, at 390 and 1440, light and dark, at the default rounding (Studio) and the highest (Neumorphism).
 *
 * A FAKE key only. The Google frame is stubbed (a plain page that says so) and OpenStreetMap tiles are answered locally:
 * no capture carries a real key and nothing here makes a real request. Set `FY_G7_SHOTS_DIR` to keep
 * `map-style-<width>-<mode>-<rounding>-<view>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { describeRoundMisses, roundSafeMisses, sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';
import { fakeTilePng } from '../../support/app/fake-tile.ts';

setDefaultTimeout(90_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_G7_SHOTS_DIR ?? '';
const FAKE_KEY = 'AIzaFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE0';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-map-style-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/map-style-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the map style scene did not build (${code}):\n${stderr}\n${stdout}`);
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
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 240_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const WIDTHS = [390, 1_440] as const;
const MODES = ['light', 'dark'] as const;
// Studio is the default rounding; Neumorphism has the highest radii of the shipped styles.
const ROUNDING = { default: 'studio', highest: 'neumorphism' } as const;
const VIEWS = ['setting', 'setting-key', 'needs-key', 'osm', 'google', 'fallback', 'blocked'] as const;

/** What a browser that blocks site data does: every touch of `localStorage` throws. */
const BLOCK_STORAGE = `Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('denied', 'SecurityError'); } });`;

describe('map style — Settings row and both styles of map', () => {
  for (const width of WIDTHS)
    for (const mode of MODES)
      for (const [rounding, style] of Object.entries(ROUNDING))
        it(`draws the setting and each map style, ${width}px, ${mode}, ${rounding} rounding`, async () => {
          const context = await browser.newContext({
            colorScheme: mode,
            deviceScaleFactor: 1,
            viewport: { height: 900, width },
          });
          const origin = server?.url.origin ?? '';
          const requested: string[] = [];
          await context.route('**/*', async route => {
            const url = new URL(route.request().url());
            if (url.origin === origin) return await route.continue();
            requested.push(`${url.origin}${url.pathname}`);
            if (url.origin === 'https://tile.openstreetmap.org')
              return await route.fulfill({ body: Buffer.from(fakeTilePng()), contentType: 'image/png' });
            if (url.origin === 'https://www.google.com' && url.pathname.startsWith('/maps/embed/v1/'))
              return await route.fulfill({
                body: '<!doctype html><body style="margin:0;display:grid;place-items:center;height:100vh;font:14px sans-serif;background:#e8eaed;color:#202124">Google Maps (stubbed embed)</body>',
                contentType: 'text/html',
              });
            return await route.abort();
          });
          try {
            for (const view of VIEWS) {
              const tab = await context.newPage();
              const problems: string[] = [];
              tab.on('pageerror', error => problems.push(error.message));
              const asked = requested.length;
              if (view === 'blocked') await tab.addInitScript(BLOCK_STORAGE);
              await tab.goto(`${origin}/?style=${style}&mode=${mode}&view=${view}`);
              if (view === 'osm' || view === 'fallback' || view === 'needs-key')
                await tab.waitForSelector('[data-fy-render-map="drawn"]');
              else if (view === 'google') await tab.waitForSelector('iframe');
              else await tab.waitForSelector('[data-map-style-row]');
              if (view === 'blocked') {
                // Choose Google and save a (fake) key in a browser that keeps nothing.
                await tab.waitForSelector('[data-fy-render-map="drawn"]');
                await tab.locator('input[type="radio"][value="google"]').check({ force: true });
                await tab.locator('[data-map-style-key="input"]').fill(FAKE_KEY);
                await tab.locator('[data-map-style-key="save"]').click();
                await tab.waitForSelector('[data-map-style-key="problem"]');
              }
              await tab.waitForTimeout(400);

              // No horizontal overflow at either width, in any view.
              const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
              expect(overflow).toBeLessThanOrEqual(0);

              if (view === 'google') {
                const frame = tab.locator('iframe');
                expect(await frame.getAttribute('sandbox')).not.toContain('allow-top-navigation');
                expect(await frame.getAttribute('referrerpolicy')).toBe('origin');
                expect(await tab.locator('.fy-render-map-canvas.fy-render-map-frame').count()).toBe(1);
                expect(await tab.locator('.leaflet-container').count()).toBe(0);
                expect(requested.some(item => item.startsWith('https://www.google.com/maps/embed/v1/place'))).toBe(
                  true,
                );
                expect(await tab.locator('.fy-render-map-note').textContent()).toContain('Big Ben');
              }
              if (view === 'osm') expect(await tab.locator('.fy-render-map-note').count()).toBe(0);
              if (view === 'fallback')
                expect(await tab.locator('.fy-render-map-note').textContent()).toContain("can't draw");
              if (view === 'needs-key')
                expect(await tab.locator('.fy-render-map-note').textContent()).toContain(
                  'needs its key on this device',
                );
              if (view === 'setting-key') {
                expect(await tab.locator('[data-map-style-key="stored"]').count()).toBe(1);
                // The page never shows the key it holds.
                expect(await tab.content()).not.toContain(FAKE_KEY);
              }
              if (view === 'setting') expect(await tab.locator('[data-map-style-key="input"]').count()).toBe(1);
              if (view === 'blocked') {
                // Blocked storage: OpenStreetMap stays, the map says the key is needed, and Google is never asked.
                expect(await tab.locator('iframe').count()).toBe(0);
                expect(await tab.locator('.leaflet-container').count()).toBe(1);
                expect(await tab.locator('.fy-render-map-note').textContent()).toContain(
                  'needs its key on this device',
                );
                expect(await tab.locator('[data-map-style-key="problem"]').textContent()).toContain(
                  'would not keep the key',
                );
                expect(await tab.locator('[data-map-style-key="stored"]').count()).toBe(0);
                expect(await tab.content()).not.toContain(FAKE_KEY);
                expect(requested.slice(asked).filter(item => item.startsWith('https://www.google.com'))).toEqual([]);
              }
              expect(problems).toEqual([]);
              // Round-safe: nothing crosses a rounded corner, at either rounding.
              const misses = await roundSafeMisses(tab);
              expect(describeRoundMisses(misses)).toBe(describeRoundMisses([]));

              if (shotsDir !== '')
                await tab.screenshot({
                  fullPage: true,
                  path: join(shotsDir, `map-style-${width}-${mode}-${rounding}-${view}.png`),
                });
              await tab.close();
            }
          } finally {
            await context.close();
          }
        });
});
