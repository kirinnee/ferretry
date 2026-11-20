/**
 * THE LANES PAGE, WHEN THE MACHINE'S PROJECTS CANNOT BE READ, in a real browser (e-retry): the failure line carries a real
 * labelled Try again button, and pressing it reads the projects again AS THE PERSON'S PRESS (`quiet: false`, so a passkey
 * prompt can open) and the editor loads. The page's own reads (on opening) carry no press.
 * Set `FY_LANE_READ_SHOTS_DIR` to keep `<viewport>-<scheme>-failed.png` and `-loaded.png`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_LANE_READ_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-lane-read-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/lane-read-failed-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the lane-read scene did not build (${code}):\n${stderr}\n${stdout}`);
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

const CASES = [
  { name: '390', width: 390, height: 844, scheme: 'dark', scale: 2 },
  { name: '768', width: 768, height: 900, scheme: 'dark', scale: 1 },
  { name: '1280', width: 1_280, height: 800, scheme: 'dark', scale: 1 },
  { name: '1280', width: 1_280, height: 800, scheme: 'light', scale: 1 },
] as const;

describe('the lanes page when the projects cannot be read', () => {
  for (const { name, width, height, scheme, scale } of CASES)
    it(`offers Try again, which reads as the person's press and loads the editor (${name}, ${scheme})`, async () => {
      const context = await browser.newContext({
        viewport: { width, height },
        colorScheme: scheme,
        deviceScaleFactor: scale,
      });
      try {
        const origin = server?.url.origin ?? '';
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
        );
        const tab = await context.newPage();
        await tab.goto(`${origin}/?theme=studio-${scheme}`);
        await tab.waitForSelector('[data-lane-read-failed]');
        const button = tab.getByRole('button', { name: 'Try again' });
        expect(await button.count()).toBe(1);
        // The button is on screen, inside the viewport, and big enough to press.
        const box = await button.boundingBox();
        expect(box).not.toBeNull();
        expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= width).toBe(true);
        if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}-${scheme}-failed.png`) });
        // Nothing the page read by itself was a press.
        expect(
          await tab.evaluate(() => (window as unknown as { __projectReads: unknown[] }).__projectReads),
        ).not.toContain(false);

        await button.click();
        await tab.waitForSelector('[data-lane-page] h1:has-text("Lanes · ferretry")');
        expect(await tab.locator('[data-lane-read-failed]').count()).toBe(0);
        expect(
          await tab.evaluate(() => (window as unknown as { __projectReads: unknown[] }).__projectReads.at(-1)),
        ).toBe(false);
        if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}-${scheme}-loaded.png`) });
      } finally {
        await context.close();
      }
    }, 60_000);
});
