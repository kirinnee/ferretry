/**
 * THE LAYOUT PAGE'S GROUPS SIT ONE GAP APART, in a real browser over fake data (`fixtures/layout-previews-scene.tsx`, drawn
 * inside `.fy-page` as the shell draws it): there is no empty band between "In use", "Navigation" and the groups after it.
 *
 * The owner (end list): "Settings > Layouts: an empty band of space in the panel". The shell's `.fy-page
 * [data-setting-group] { margin-bottom: 32px }` stacked on the page's own 32px `gap`, so groups were 64px apart.
 *
 * Set `FY_LAYOUT_GAPS_SHOTS_DIR` to keep `<viewport>-layout.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_LAYOUT_GAPS_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-layout-gaps-'));
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
  if (code !== 0) throw new Error(`the layout gaps scene did not build (${code}):\n${stderr}\n${stdout}`);
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
  { name: '390-dark', width: 390, phone: true, scheme: 'dark' },
  { name: '768-dark', width: 768, phone: false, scheme: 'dark' },
  { name: '1280-dark', width: 1_280, phone: false, scheme: 'dark' },
  { name: '1280-light', width: 1_280, phone: false, scheme: 'light' },
] as const;

describe('the layout page groups', () => {
  for (const variant of VARIANTS) {
    it(`${variant.name}: one 32px gap between groups, no empty band`, async () => {
      const context = await browser.newContext({
        viewport: { width: variant.width, height: 900 },
        deviceScaleFactor: variant.phone ? 2 : 1,
        colorScheme: variant.scheme,
      });
      const tab = await context.newPage();
      tab.setDefaultTimeout(8_000);
      try {
        await tab.goto(`${server?.url.origin}/?theme=studio-${variant.scheme}`);
        await tab.locator('[data-layout-settings]').waitFor();
        await tab.waitForTimeout(400);
        const gaps = await tab.evaluate(() => {
          const groups = [...document.querySelectorAll('.fy-lr-group')].map(group => group.getBoundingClientRect());
          return groups.slice(1).map((box, index) => Math.round(box.top - (groups[index]?.bottom ?? 0)));
        });
        expect(gaps.length, 'the page draws several groups').toBeGreaterThan(2);
        for (const gap of gaps) expect(gap, `gaps between groups: ${gaps.join(', ')}`).toBeLessThanOrEqual(32);
        if (shotsDir !== '') {
          await tab.setViewportSize({ width: variant.width, height: 1_100 });
          await tab.screenshot({ path: join(shotsDir, `${variant.name}-layout.png`) });
        }
      } finally {
        await context.close();
      }
    });
  }
});
