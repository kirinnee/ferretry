/**
 * A SETTING ROW LAYS OUT BY ITS OWN WIDTH, not the window's: the same labelled row with a preview, drawn in boxes of 300, 480,
 * 700 and 1000px (`fixtures/setting-row-container-scene.tsx`), in windows of 390, 768, 1024 and 1440px. A narrow box keeps the
 * preview on its own line under the name and a wide one keeps it beside, in whichever window it is drawn.
 *
 * Set `FY_SETTING_ROW_CONTAINER_SHOTS_DIR` to keep `<window>-<scheme>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(120_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_SETTING_ROW_CONTAINER_SHOTS_DIR ?? '';
const WINDOWS = [390, 768, 1_024, 1_440] as const;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-setting-row-container-'));
  const child = Bun.spawn(
    [
      process.execPath,
      sceneBuilder,
      '--out',
      directory,
      '--entry',
      resolve(packageRoot, 'fixtures/setting-row-container-scene.tsx'),
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the setting row scene did not build (${code}):\n${stderr}\n${stdout}`);
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

describe('A setting row lays out by the width of its own box', () => {
  for (const width of WINDOWS)
    for (const mode of ['light', 'dark'] as const)
      it(`keeps the preview under a narrow row's name and beside a wide one's (${width}px window, ${mode})`, async () => {
        const context = await browser.newContext({
          viewport: { width, height: 1_200 },
          colorScheme: mode,
          deviceScaleFactor: width < 600 ? 2 : 1,
        });
        const origin = server?.url.origin ?? '';
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
        );
        const tab = await context.newPage();
        await tab.goto(`${origin}/?theme=studio-${mode}`);
        await tab.waitForSelector('[data-scene="ready"]');
        if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${width}-${mode}.png`), fullPage: true });
        const boxes = await tab.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>('[data-box]')].map(box => {
            const label = box.querySelector('[data-setting-hint]')?.parentElement?.getBoundingClientRect();
            const preview = box.querySelector('[data-setting-preview-slot]')?.getBoundingClientRect();
            const row = box.querySelector('[data-setting-row]')?.getBoundingClientRect();
            return {
              box: Number(box.dataset.box),
              rowWidth: row?.width ?? 0,
              labelWidth: label?.width ?? 0,
              labelBottom: label?.bottom ?? 0,
              previewTop: preview?.top ?? 0,
              previewRight: preview?.right ?? 0,
              rowRight: row?.right ?? 0,
            };
          }),
        );
        expect(boxes).toHaveLength(4);
        for (const box of boxes) {
          // The row is as wide as its box (or the window, when the box is wider).
          if (box.rowWidth >= 600) {
            expect(box.previewTop, `${box.rowWidth}px row: the preview sits beside the name`).toBeLessThan(
              box.labelBottom,
            );
            expect(box.labelWidth / box.rowWidth, `${box.rowWidth}px row: the name column is 40%`).toBeLessThan(0.45);
          } else {
            expect(box.previewTop, `${box.rowWidth}px row: the preview takes its own line`).toBeGreaterThanOrEqual(
              box.labelBottom - 1,
            );
          }
          expect(box.previewRight, 'the preview stays inside the row').toBeLessThanOrEqual(box.rowRight + 1);
        }
        await context.close();
      });
});
