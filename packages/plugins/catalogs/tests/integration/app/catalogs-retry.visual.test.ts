/**
 * SETTINGS › CATALOGS WHEN THE LIST CANNOT BE READ, in a real browser (e-retry): Try again reads the list again AS THE
 * PERSON'S PRESS (`quiet: false`, so a passkey prompt can open) and the catalogs load. The page's own read carries no press.
 * Set `FY_CATALOGS_RETRY_SHOTS_DIR` to keep `<viewport>-<scheme>-failed.png` and `-loaded.png`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_CATALOGS_RETRY_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-catalogs-retry-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/catalogs-retry-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the catalogs retry scene did not build (${code}):\n${stderr}\n${stdout}`);
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

const reads = (tab: { evaluate: <T>(fn: () => T) => Promise<T> }) =>
  tab.evaluate(() => (window as unknown as { __catalogReads: (false | null)[] }).__catalogReads);

describe('Settings › Catalogs when the list cannot be read', () => {
  for (const { name, width, height, scheme, scale } of CASES)
    it(`Try again reads it as the person's press and the catalogs load (${name}, ${scheme})`, async () => {
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
        await tab.waitForSelector('[data-catalog-failure]');
        const button = tab.getByRole('button', { name: 'Try again' });
        expect(await button.count()).toBe(1);
        if (width === 390)
          expect(
            (await button.boundingBox())?.height ?? 0,
            'the Try again is a 44px target at 390',
          ).toBeGreaterThanOrEqual(44);
        if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}-${scheme}-failed.png`) });
        expect(await reads(tab)).toEqual([null]);

        await button.click();
        await tab.waitForSelector('[data-catalogs-list]');
        expect(await tab.locator('[data-catalog-failure]').count()).toBe(0);
        expect(await reads(tab)).toEqual([null, false]);
        if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}-${scheme}-loaded.png`) });
      } finally {
        await context.close();
      }
    }, 60_000);
});
