/**
 * THE LAYOUT LISTS in a real browser over fake data (`fixtures/layout-previews-scene.tsx`): no list is a text box, a row
 * lifts under the pointer (the mid-drag frame), dropping it keeps the new order on screen, and nothing makes the page
 * scroll sideways.
 *
 * Set `FY_LAYOUT_LISTS_SHOTS_DIR` to keep `<viewport>-<case>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Locator } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(30_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_LAYOUT_LISTS_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-layout-lists-'));
  const child = Bun.spawn(
    [
      process.execPath,
      sceneBuilder,
      '--out',
      directory,
      '--entry',
      resolve(packageRoot, 'fixtures/layout-previews-scene.tsx'),
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the layout lists scene did not build (${code}):\n${stderr}\n${stdout}`);
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

const keysOf = (list: Locator): Promise<string[]> =>
  list
    .locator('li[data-sortable-key]')
    .evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.sortableKey ?? ''));

describe('the layout lists', () => {
  for (const variant of VARIANTS) {
    it(`${variant.name}: a row lifts under the pointer, drops in its new place, and no list is a text box`, async () => {
      const context = await browser.newContext({
        viewport: { width: variant.width, height: 900 },
        deviceScaleFactor: variant.phone ? 2 : 1,
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
      try {
        await tab.goto(`${origin}/?theme=studio-${variant.scheme}`);
        const list = tab.locator('[data-layout-list="nav.items"]');
        await list.waitFor();
        expect(await tab.locator('input[type="text"]').count(), 'only the layout name is typed').toBe(1);
        const before = await keysOf(list);
        const grip = list.locator('[data-chip-main][aria-label="Reorder Ferrets"]');
        await grip.scrollIntoViewIfNeeded();
        const box = await grip.boundingBox();
        const x = (box?.x ?? 0) + (box?.width ?? 0) / 2;
        const y = (box?.y ?? 0) + (box?.height ?? 0) / 2;
        await tab.mouse.move(x, y);
        await tab.mouse.down();
        for (let step = 1; step <= 6; step += 1) await tab.mouse.move(x, y + step * 18);
        expect(await list.locator('li[data-state="held"]').count(), 'one row is held').toBe(1);
        // The rows that made way slide for 150 ms: the frame is taken once they have arrived.
        await tab.waitForTimeout(350);
        if (shotsDir !== '') {
          // The held chip follows the pointer below the list, so the frame is the list and the room under it.
          const frame = await list.boundingBox();
          await tab.screenshot({
            path: join(shotsDir, `${variant.name}-mid-drag.png`),
            clip: {
              x: frame?.x ?? 0,
              y: frame?.y ?? 0,
              width: frame?.width ?? 300,
              height: (frame?.height ?? 300) + 120,
            },
          });
        }
        await tab.mouse.up();
        const after = await keysOf(list);
        expect(after).not.toEqual(before);
        expect([...after].sort()).toEqual([...before].sort());
        expect(await list.locator('li[data-state="held"]').count()).toBe(0);
        await tab.waitForTimeout(350);
        if (shotsDir !== '') await list.screenshot({ path: join(shotsDir, `${variant.name}-dropped.png`) });
        await tab.setViewportSize({ width: variant.width, height: 6_000 });
        await tab.evaluate(() => window.scrollTo(0, 0));
        if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${variant.name}-page.png`), fullPage: true });
        // The one switch: "Just this device" draws the same rows, now saved on this device alone.
        await tab.locator('label', { hasText: 'Just this device' }).click();
        await tab.locator('[data-layout-scope="device"]').waitFor();
        expect(await tab.locator('[role="radiogroup"][aria-label="Navigation side"]').count(), 'one set of rows').toBe(
          1,
        );
        if (shotsDir !== '')
          await tab.screenshot({ path: join(shotsDir, `${variant.name}-device.png`), fullPage: true });
        const overflow = await tab.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, 'no sideways scroll').toBeLessThanOrEqual(0);
        expect(problems).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }
});
