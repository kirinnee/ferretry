/**
 * THE OPEN AGENDA ITEM, in a real browser (A-29): the item's ask and the task ask come before the why, the steps and the
 * impact, and the answered ask is on the History fold. Set `FY_G5_SHOTS_DIR` to keep `agenda-<width>-<mode>-<rounding>.png`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_G5_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-open-asks-first-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/open-asks-first-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the agenda scene did not build (${code}):\n${stderr}\n${stdout}`);
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

// Studio is the default rounding; Neumorphism has the highest radii of the shipped styles.
const ROUNDING = { default: 'studio', highest: 'neumorphism' } as const;
const SIZES = [
  { name: '390', width: 390, height: 844, scale: 2 },
  { name: '1440', width: 1_440, height: 900, scale: 1 },
] as const;

describe('the open agenda item', () => {
  for (const { name, width, height, scale } of SIZES)
    for (const mode of ['light', 'dark'] as const)
      for (const [rounding, style] of Object.entries(ROUNDING))
        it(`draws every open ask before the why and the impact (${name}, ${mode}, ${rounding} rounding)`, async () => {
          const context = await browser.newContext({
            viewport: { width, height },
            colorScheme: mode,
            deviceScaleFactor: scale,
          });
          try {
            const origin = server?.url.origin ?? '';
            await context.route('**/*', async route =>
              new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
            );
            const tab = await context.newPage();
            await tab.goto(`${origin}/?style=${style}&mode=${mode}`);
            await tab.waitForSelector('[data-agenda-card-asks]');
            const order = await tab.evaluate(() => {
              const at = (selector: string) => document.querySelector(selector)?.getBoundingClientRect().top ?? -1;
              return [
                at('[data-agenda-question-line], [data-agenda-option]'),
                at('[data-agenda-card-asks]'),
                at('[data-agenda-section="recommendation"]'),
                at('[data-agenda-section="impact"]'),
              ];
            });
            expect(order.every(top => top >= 0)).toBe(true);
            expect(order).toEqual([...order].sort((a, b) => a - b));
            const history = tab.locator('[data-agenda-fold="conversation"]');
            expect(await history.textContent()).toContain('History1 answered');
            await history.click();
            // Nothing runs off the page sideways.
            expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
            // Every control is a real, big-enough target on a phone.
            if (width === 390)
              for (const control of await tab.locator('.fy-board-project__toggle, .fy-board-project__focus').all())
                expect((await control.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(28);
            if (shotsDir !== '')
              await tab.screenshot({ path: join(shotsDir, `agenda-${name}-${mode}-${rounding}.png`) });
          } finally {
            await context.close();
          }
        }, 60_000);
});
