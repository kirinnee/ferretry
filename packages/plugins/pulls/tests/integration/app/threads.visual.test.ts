/**
 * THE REVIEW THREADS in a real browser over fake data (`fixtures/threads-scene.tsx`): an open thread under its row, a
 * resolved one collapsed, the outdated list, and no sideways scroll at phone width.
 *
 * Set `FY_THREADS_SHOTS_DIR` to keep `<viewport>-<theme>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(30_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_THREADS_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-threads-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', resolve(packageRoot, 'fixtures/threads-scene.tsx')],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the threads scene did not build (${code}):\n${stderr}\n${stdout}`);
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
  { name: '1280-light', width: 1_280, phone: false, scheme: 'light' },
  { name: '1280-dark', width: 1_280, phone: false, scheme: 'dark' },
  { name: '390-light', width: 390, phone: true, scheme: 'light' },
  { name: '390-dark', width: 390, phone: true, scheme: 'dark' },
] as const;

describe('the review threads', () => {
  for (const variant of VARIANTS) {
    it(`${variant.name}: a thread under its row, the resolved one collapsed, the outdated list, no sideways scroll`, async () => {
      const context = await browser.newContext({
        viewport: { width: variant.width, height: 900 },
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
      const problems: string[] = [];
      tab.on('pageerror', error => problems.push(error.message));
      try {
        await tab.goto(`${origin}/?theme=studio-${variant.scheme}`);
        await tab.waitForSelector('[data-scene-ready] [data-thread]');
        const open = tab.locator('[data-thread="T1"]');
        const done = tab.locator('[data-thread="T2"]');
        expect(await open.evaluate(element => (element as HTMLDetailsElement).open)).toBe(true);
        expect(await done.evaluate(element => (element as HTMLDetailsElement).open)).toBe(false);
        // The open thread sits inside the diff, under the `entries` row.
        expect(await tab.locator('[data-diff] [data-line-threads="src/a.ts:right:11"]').count()).toBe(1);
        expect(await tab.locator('[data-outdated-group="outdated"] [data-thread="T3"]').count()).toBe(1);
        const overflow = await tab.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, 'no sideways scroll').toBeLessThanOrEqual(0);
        if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${variant.name}.png`), fullPage: true });
        expect(problems).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }
});
