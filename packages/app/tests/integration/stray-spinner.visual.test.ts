/**
 * r11 T3 — STRAY SPINNERS ONTO THE SHARED ONE, in a real browser over real app sites that used to draw a lucide
 * `animate-spin` icon (`fixtures/stray-spinner-scene.tsx`): the action-form foot and the "Finding your location" line,
 * beside a running-activity mark. Each must render the shared mark (`.fy-spinner`), none may leave an `animate-spin`
 * icon, a wait must be held back for the 300 ms threshold (invisible at 100 ms, painted by 700 ms) and a running
 * activity must be there at once. The plugin-owned sites are held by their own unit tests (an app test may not import
 * another package's source) and by the `no-stray-spinner.sh` guard.
 *
 * Set `FY_STRAY_SPINNER_SHOTS_DIR` to keep `<viewport>-<mode>-<100ms|700ms>.png` (1280 and 390, light and dark).
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

interface Site {
  readonly site: 'form' | 'locate' | 'run';
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
          await tab.waitForSelector('[data-site="run"]');
          const read = async (): Promise<Seen> =>
            await tab.evaluate(() => (window as unknown as { __strays: () => Seen }).__strays());
          const early = await read();
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${width}-${mode}-100ms.png`) });
          await tab.waitForTimeout(700);
          const late = await read();
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${width}-${mode}-700ms.png`) });
          const sites = (seen: Seen) => Object.fromEntries(seen.sites.map(site => [site.site, site]));

          // The owner line: the shared spinner, and no icon of its own.
          expect(late.strays).toBe(0);
          expect(late.spinners).toBe(3);
          for (const site of late.sites) {
            expect(site.present).toBe(true);
            expect(site.width).toBeGreaterThan(8);
            expect(site.height).toBeGreaterThan(8);
            expect(site.painted).toBe(true);
          }
          // The 300 ms threshold: the waits are not painted yet, the running activity is.
          expect(early.strays).toBe(0);
          expect(sites(early).form?.painted).toBe(false);
          expect(sites(early).locate?.painted).toBe(false);
          expect(sites(early).run?.painted).toBe(true);
        } finally {
          await context.close();
        }
      });
    }
  }
});
