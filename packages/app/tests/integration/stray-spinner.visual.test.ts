/**
 * r11 T3 — STRAY SPINNERS ONTO THE SHARED ONE, in a real browser over real app sites that used to draw a lucide
 * `animate-spin` icon (`fixtures/stray-spinner-scene.tsx`): the action-form foot and the "Finding your location" line.
 * Each must render the shared mark (`.fy-spinner`), none may leave an `animate-spin` icon, and a wait must keep to the
 * owner's 300 ms threshold, MEASURED FROM THE MOUNT: not one painted frame through 250 ms, and the mark painted for the
 * first time near the 300 ms boundary (the scene's frame loop records the first painted frame per site). The third
 * migrated site, the running CI mark, is held in a real browser by pulls' `ci-run.visual.test.ts`; the other plugin
 * sites by their own unit tests (an app test may not import another package's source) and by `no-stray-spinner.sh`.
 *
 * Set `FY_STRAY_SPINNER_SHOTS_DIR` to keep `<viewport>-<mode>-<waiting|shown>.png` (1280 and 390, light and dark).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_STRAY_SPINNER_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-stray-spinner-'));
  const child = Bun.spawn(
    [
      process.execPath,
      sceneBuilder,
      '--out',
      directory,
      '--entry',
      resolve(packageRoot, 'fixtures/stray-spinner-scene.tsx'),
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the stray spinner scene did not build (${code}):\n${stderr}\n${stdout}`);
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
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

/** Nothing may paint before this, measured from the mount: the owner's 300 ms less a frame loop's and a timer's slack. */
const QUIET_UNTIL_MS = 250;
/** The first painted frame lands by this, or the mark is not "near the 300 ms boundary" (a loaded host may be frames late). */
const SHOWN_BY_MS = 500;

interface Site {
  readonly site: 'form' | 'locate';
  readonly present: boolean;
  readonly painted: boolean;
  readonly width: number;
  readonly height: number;
}
interface Seen {
  readonly spinners: number;
  readonly strays: number;
  readonly sites: readonly Site[];
}

describe('the stray spinner sites draw the shared spinner', () => {
  for (const [width, phone] of [
    [1_280, false],
    [390, true],
  ] as const) {
    for (const mode of ['light', 'dark'] as const) {
      it(`${width} ${mode}: shared mark on every site, no animate-spin, a wait held for 300 ms`, async () => {
        const context = await browser.newContext({
          viewport: { width, height: 600 },
          colorScheme: mode,
          deviceScaleFactor: phone ? 2 : 1,
          hasTouch: phone,
          isMobile: phone,
        });
        const origin = server?.url.origin ?? '';
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
        );
        const tab = await context.newPage();
        try {
          await tab.goto(`${origin}/?theme=studio-${mode}`);
          await tab.waitForSelector('[data-site="locate"]');
          const read = async (): Promise<Seen> =>
            await tab.evaluate(() => (window as unknown as { __strays: () => Seen }).__strays());
          const firstPaints = async (): Promise<Record<string, number | null>> =>
            await tab.evaluate(() =>
              (window as unknown as { __firstPaint: () => Record<string, number | null> }).__firstPaint(),
            );
          // A frame loop has been timing the waits since the mount: let it see both painted, then read when.
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${width}-${mode}-waiting.png`) });
          await tab.waitForFunction(
            () =>
              Object.values(
                (window as unknown as { __firstPaint: () => Record<string, unknown> }).__firstPaint(),
              ).every(at => at !== null),
            undefined,
            { timeout: 5_000 },
          );
          const first = await firstPaints();
          const late = await read();
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${width}-${mode}-shown.png`) });

          // The owner line: the shared spinner, and no icon of its own.
          expect(late.strays).toBe(0);
          expect(late.spinners).toBe(2);
          for (const site of late.sites) {
            expect(site.present).toBe(true);
            expect(site.width).toBeGreaterThan(8);
            expect(site.height).toBeGreaterThan(8);
            expect(site.painted).toBe(true);
          }
          // The 300 ms threshold, from the mount: no painted frame through 250 ms, then painted near the boundary.
          for (const site of ['form', 'locate']) {
            const at = first[site] ?? -1;
            expect(at, `${site}: first painted frame (ms from the mount)`).toBeGreaterThanOrEqual(QUIET_UNTIL_MS);
            expect(at, `${site}: first painted frame (ms from the mount)`).toBeLessThanOrEqual(SHOWN_BY_MS);
          }
          if (process.env.FY_STRAY_SPINNER_LOG === '1')
            console.log(`${width} ${mode} first painted: ${JSON.stringify(first)}`);
        } finally {
          await context.close();
        }
      });
    }
  }
});
