/**
 * r11 O3 — THE 300 ms LOADER THRESHOLD, in a real browser over the real loaders and the real stylesheet
 * (`fixtures/loading-threshold-scene.tsx`). Owner: "loader showing should have 300ms threshold, else the loader keep
 * showing". A wait that answers in 250 ms must paint NO loader pixel (sampled every frame); one that answers in 600 ms
 * shows from about 300 ms and, once shown, stays at least 300 ms (no blink). The same for the top bar, the "Updating…"
 * pill and `<Spinner wait />`, and the same under reduced motion (OS-style `data-motion=reduced` kills every animation
 * with `!important`; the gate must survive it).
 *
 * Set `FY_LOADING_THRESHOLD_SHOTS_DIR` to keep `<viewport>-<theme>-<scene>-<before|after>.png` (1280 and 390, light and
 * dark: 150 ms into a wait = nothing drawn, 550 ms = the loader) and to print each measured first/last visible time.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_LOADING_THRESHOLD_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-loading-threshold-'));
  const child = Bun.spawn(
    [
      process.execPath,
      sceneBuilder,
      '--out',
      directory,
      '--entry',
      resolve(packageRoot, 'fixtures/loading-threshold-scene.tsx'),
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the loading threshold scene did not build (${code}):\n${stderr}\n${stdout}`);
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

interface Sample {
  readonly firstVisible: number | null;
  readonly lastVisible: number | null;
  readonly frames: number;
}

/** Runs one fake read of `ms` and returns what a person would have seen, frame by frame. */
const run = async (
  scene: string,
  ms: number,
  options: { readonly theme?: string; readonly motion?: 'reduced'; readonly shot?: boolean } = {},
): Promise<Sample> => {
  const theme = options.theme ?? 'studio-light';
  const context = await browser.newContext({
    viewport: { width: 1_280, height: 800 },
    colorScheme: theme.endsWith('dark') ? 'dark' : 'light',
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  tab.setDefaultTimeout(10_000);
  try {
    await tab.goto(
      `${origin}/?theme=${theme}&scene=${scene}&ms=${ms}${options.motion === undefined ? '' : '&motion=reduced'}`,
    );
    await tab.waitForFunction(
      expected =>
        (window as unknown as { __loader: { frames: number } }).__loader.frames > 0 && performance.now() > expected,
      ms + 1_700,
    );
    const measured = await tab.evaluate(() => (window as unknown as { __loader: Sample }).__loader);
    if (shotsDir !== '')
      console.log(
        `measured ${scene}${options.motion === undefined ? '' : '/reduced'} ${ms}ms: first=${measured.firstVisible?.toFixed(0) ?? 'never'} last=${measured.lastVisible?.toFixed(0) ?? 'never'} frames=${measured.frames}`,
      );
    return measured;
  } finally {
    await context.close();
  }
};

const SCENES = ['page', 'bar', 'cache', 'spinner'] as const;

describe('a wait that answers inside 300 ms paints no loader', () => {
  for (const scene of SCENES) {
    for (const motion of [undefined, 'reduced'] as const) {
      it(`${scene}${motion === undefined ? '' : ' (reduced motion)'}: 250 ms → never visible`, async () => {
        const seen = await run(scene, 250, { motion });
        expect(seen.frames).toBeGreaterThan(20);
        expect(seen.firstVisible).toBeNull();
      });
    }
  }
});

describe('a wait that outlasts 300 ms shows from about 300 ms and does not blink', () => {
  for (const scene of ['page', 'bar'] as const) {
    for (const motion of [undefined, 'reduced'] as const) {
      it(`${scene}${motion === undefined ? '' : ' (reduced motion)'}: 600 ms → visible from ~300 ms, held ≥ 300 ms`, async () => {
        const seen = await run(scene, 600, { motion, theme: 'studio-dark' });
        expect(seen.firstVisible).not.toBeNull();
        expect(seen.firstVisible as number).toBeGreaterThanOrEqual(295);
        expect(seen.firstVisible as number).toBeLessThanOrEqual(420);
        expect((seen.lastVisible as number) - (seen.firstVisible as number)).toBeGreaterThanOrEqual(300);
      });
    }
  }
  for (const scene of ['cache', 'spinner'] as const) {
    it(`${scene}: 900 ms → visible from ~300 ms until the read ends`, async () => {
      const seen = await run(scene, 900, {});
      expect(seen.firstVisible as number).toBeGreaterThanOrEqual(295);
      expect(seen.firstVisible as number).toBeLessThanOrEqual(420);
      expect(seen.lastVisible as number).toBeGreaterThanOrEqual(850);
    });
  }
});

describe.skipIf(shotsDir === '')('the loader before and after the threshold (kept shots)', () => {
  for (const [width, height, phone] of [
    [1_280, 800, false],
    [390, 800, true],
  ] as const) {
    for (const mode of ['light', 'dark'] as const) {
      for (const scene of ['page', 'cache', 'spinner'] as const) {
        it(`${width}-${mode}-${scene}`, async () => {
          const context = await browser.newContext({
            viewport: { width, height },
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
            await tab.goto(`${origin}/?theme=studio-${mode}&scene=${scene}&ms=1500`);
            await tab.waitForTimeout(150);
            await tab.screenshot({ path: join(shotsDir, `${width}-${mode}-${scene}-before.png`) });
            await tab.waitForTimeout(400);
            await tab.screenshot({ path: join(shotsDir, `${width}-${mode}-${scene}-after.png`) });
          } finally {
            await context.close();
          }
        });
      }
    }
  }
});
