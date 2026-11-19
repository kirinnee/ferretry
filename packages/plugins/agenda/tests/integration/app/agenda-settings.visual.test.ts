/**
 * THE AGENDA SETTINGS TAB's own layout in a real browser over fake data (the in-shell cases, which prove the columns follow
 * the panel, are in `packages/app/tests/integration/settings-shell.visual.test.ts`), at 1280 and 390 wide, light and dark (r10 S8):
 *
 *  - the five kinds are a grid of compact tiles (three across wide, one on a phone), one line each;
 *  - quiet hours is one row, and turning it on puts From / To on that row without moving anything above it;
 *  - nothing scrolls sideways.
 *
 * Set `FY_AGENDA_SETTINGS_SHOTS_DIR` to keep `<viewport>-<scheme>-<off|on>.png`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm as removeTree } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';
import type { Browser } from 'playwright-core';

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_AGENDA_SETTINGS_SHOTS_DIR ?? '';

let browser: Browser;
let built = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  built = await mkdtemp(join(tmpdir(), 'ferretry-agenda-settings-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', built, '--entry', 'fixtures/agenda-settings-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the agenda settings scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request =>
      new URL(request.url).pathname === '/app.js'
        ? new Response(js, { headers: { 'content-type': 'text/javascript' } })
        : new Response(page, { headers: { 'content-type': 'text/html' } }),
  });
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 240_000);

afterAll(async () => {
  server?.stop(true);
  if (built !== '') await removeTree(built, { force: true, recursive: true });
});

const VARIANTS = [
  { name: '1280', width: 1_280, height: 640, phone: false, columns: 3 },
  { name: '390', width: 390, height: 844, phone: true, columns: 1 },
] as const;

describe('The Agenda settings tab', () => {
  for (const variant of VARIANTS)
    for (const scheme of ['light', 'dark'] as const)
      it(`tiles the kinds and keeps quiet hours on one row (${variant.name}, ${scheme})`, async () => {
        const context = await browser.newContext({
          viewport: { width: variant.width, height: variant.height },
          colorScheme: scheme,
          deviceScaleFactor: variant.phone ? 2 : 1,
          hasTouch: variant.phone,
          isMobile: variant.phone,
        });
        const origin = server?.url.origin ?? '';
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
        );
        const page = await context.newPage();
        try {
          await page.goto(`${origin}/?theme=studio-${scheme}`);
          await page.waitForSelector('[role="switch"]');
          const tiles = await page.$$eval('fieldset [role="switch"]', nodes =>
            nodes.map(node => {
              const box = node.getBoundingClientRect();
              return { top: Math.round(box.top), width: box.width, height: box.height };
            }),
          );
          expect(tiles).toHaveLength(5);
          expect(new Set(tiles.map(tile => tile.top)).size).toBe(Math.ceil(5 / variant.columns));
          for (const tile of tiles) expect(tile.height, 'a tile is a compact pair of lines').toBeLessThan(80);
          if (!variant.phone) for (const tile of tiles) expect(tile.width, 'not full width').toBeLessThan(420);

          const rowTop = async (): Promise<number> =>
            await page.$eval('[data-quiet-hours-row]', node => node.getBoundingClientRect().top);
          const rowHeight = async (): Promise<number> =>
            await page.$eval('[data-quiet-hours-row]', node => node.getBoundingClientRect().height);
          const before = { top: await rowTop(), height: await rowHeight() };
          if (shotsDir !== '') await page.screenshot({ path: join(shotsDir, `${variant.name}-${scheme}-off.png`) });

          await page.click('[data-quiet-hours-row] [role="switch"]');
          await page.waitForSelector('[data-quiet-hours-row] input[type="time"]');
          expect(await page.$$('[data-quiet-hours-row] input[type="time"]')).toHaveLength(2);
          await page.evaluate(async () => {
            await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => undefined)));
          });
          expect(await rowTop(), 'nothing above moves').toBe(before.top);
          if (!variant.phone) expect(await rowHeight(), 'one row, the same height on wide').toBe(before.height);
          if (shotsDir !== '') await page.screenshot({ path: join(shotsDir, `${variant.name}-${scheme}-on.png`) });

          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(overflow, 'nothing scrolls sideways').toBeLessThanOrEqual(0);
        } finally {
          await context.close();
        }
      }, 60_000);
});
