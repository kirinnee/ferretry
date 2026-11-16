/**
 * THE ALL QUEUES SCREEN, in a real browser: every ferret's queue in one place, on a phone and a desktop, in light and
 * dark. The scene (`fixtures/all-queues-scene.tsx`) is the real screen over fixed fake data: three ferrets, one with an
 * empty queue (it has no card). Set `FY_ALL_QUEUES_SHOTS_DIR` to keep `<width>-<scheme>.png`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_ALL_QUEUES_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-all-queues-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/all-queues-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the All queues scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      if (path === '/') return new Response(html, { headers: { 'content-type': 'text/html' } });
      return new Response('not here', { status: 404 });
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
  { name: '390', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 },
  { name: '1280', viewport: { width: 1_280, height: 800 }, deviceScaleFactor: 1 },
] as const;

describe('the All queues screen', () => {
  for (const { name, viewport, deviceScaleFactor } of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      it(`lists the ferrets that have messages waiting, whole, on ${name} wide in ${scheme}`, async () => {
        const context = await browser.newContext({ viewport, colorScheme: scheme, deviceScaleFactor });
        try {
          const origin = server?.url.origin ?? '';
          await context.route('**/*', async route =>
            new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
          );
          const tab = await context.newPage();
          const errors: string[] = [];
          tab.on('pageerror', error => errors.push(error.message));
          await tab.goto(`${origin}/?theme=studio-${scheme}`);
          await tab
            .locator('[data-queue-group]')
            .first()
            .waitFor({ timeout: 10_000 })
            .catch(() => undefined);
          expect(errors).toEqual([]);
          expect(await tab.locator('[data-queue-group]').count()).toBe(2);
          expect(await tab.locator('[data-queue-row]').count()).toBe(3);
          expect(await tab.locator('.fy-queue-ferret').allInnerTexts()).toEqual(['Mira', 'Casen']);
          // Nothing sticks out sideways.
          expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          if (shotsDir !== '') {
            await tab.waitForTimeout(150);
            await tab.screenshot({ path: join(shotsDir, `${name}-${scheme}.png`), fullPage: true });
          }
        } finally {
          await context.close();
        }
      }, 60_000);

  // One ferret's queue is refused while the others read: it says so, whole, and the rest still show.
  for (const scheme of ['light', 'dark'] as const)
    it(`says a refused queue could not be read, beside the readable ones, on 390 wide in ${scheme}`, async () => {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        colorScheme: scheme,
        deviceScaleFactor: 2,
      });
      try {
        const origin = server?.url.origin ?? '';
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
        );
        const tab = await context.newPage();
        const errors: string[] = [];
        tab.on('pageerror', error => errors.push(error.message));
        await tab.goto(`${origin}/?theme=studio-${scheme}&refused=casen`);
        await tab
          .locator('[data-queue-unread]')
          .first()
          .waitFor({ timeout: 10_000 })
          .catch(() => undefined);
        expect(errors).toEqual([]);
        expect(await tab.locator('[data-queue-unread]').allInnerTexts()).toEqual([
          'Couldn’t read this queue: This device is not allowed to use the fleet.',
        ]);
        expect(await tab.locator('[data-queue-row]').count()).toBe(1);
        expect(await tab.locator('[data-queue-empty]').count()).toBe(0);
        expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        if (shotsDir !== '') {
          await tab.waitForTimeout(150);
          await tab.screenshot({ path: join(shotsDir, `390-${scheme}-partly-failed.png`), fullPage: true });
        }
      } finally {
        await context.close();
      }
    }, 60_000);
});
