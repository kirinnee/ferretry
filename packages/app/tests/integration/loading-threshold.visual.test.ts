/**
 * r11 O3 — THE 300 ms LOADER THRESHOLD, in a real browser over the real loaders and the real stylesheet
 * (`fixtures/loading-threshold-scene.tsx`). Owner: "loader showing should have 300ms threshold, else the loader keep
 * showing". A wait that answers in 250 ms must paint NO loader pixel (sampled every frame); one that answers in 600 ms
 * shows from about 300 ms and, once shown, the shell's held loader and the one top bar stay at least 300 ms (no blink); a loader its owner mounts off its read leaves with the read (o9-11: never a copy drawn over content). The same for the top bar, the "Updating…"
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
  /** The most leftover copies of a loader (`[data-loading-ghost]`) any single frame held: always 0. */
  readonly ghosts: number;
  /** Frames in which the top bar and a page loader were both painted: always 0. */
  readonly both: number;
}

/** Runs one fake read of `ms` and returns what a person would have seen, frame by frame. */
const run = async (
  scene: string,
  ms: number,
  options: {
    readonly theme?: string;
    readonly motion?: 'reduced';
    readonly shot?: boolean;
    readonly width?: number;
  } = {},
): Promise<Sample> => {
  const theme = options.theme ?? 'studio-light';
  const context = await browser.newContext({
    viewport: { width: options.width ?? 1_280, height: 800 },
    colorScheme: theme.endsWith('dark') ? 'dark' : 'light',
    ...((options.width ?? 1_280) < 600 ? { deviceScaleFactor: 2, hasTouch: true, isMobile: true } : {}),
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

const SCENES = ['page', 'held', 'bar', 'cache', 'spinner'] as const;

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

describe('a wait that outlasts 300 ms shows from about 300 ms', () => {
  // The shell holds its own loader (`held`) and the one top bar (`bar`): once shown, they stay 300 ms, however soon the answer comes.
  for (const scene of ['held', 'bar'] as const) {
    for (const ms of [350, 600] as const) {
      for (const motion of [undefined, 'reduced'] as const) {
        it(`${scene}${motion === undefined ? '' : ' (reduced motion)'}: ${ms} ms read → visible from ~300 ms, held ≥ 300 ms`, async () => {
          const seen = await run(scene, ms, { motion, theme: 'studio-dark' });
          expect(seen.firstVisible).not.toBeNull();
          expect(seen.firstVisible as number).toBeGreaterThanOrEqual(295);
          expect(seen.firstVisible as number).toBeLessThanOrEqual(420);
          expect((seen.lastVisible as number) - (seen.firstVisible as number)).toBeGreaterThanOrEqual(300);
        });
      }
    }
  }
  // A loader its owner mounts off its read leaves WITH the read: nothing is kept (or copied) over what replaced it.
  for (const scene of ['page', 'cache', 'spinner', 'sheet'] as const) {
    it(`${scene}: a 600 ms read → visible from ~300 ms, gone when the read answers, no copy left behind`, async () => {
      const seen = await run(scene, 600, { theme: 'studio-dark' });
      expect(seen.firstVisible as number).toBeGreaterThanOrEqual(295);
      expect(seen.firstVisible as number).toBeLessThanOrEqual(420);
      expect(seen.lastVisible as number).toBeLessThanOrEqual(700);
      expect(seen.ghosts).toBe(0);
    });
  }
});

describe('one indicator at a time (L203)', () => {
  it('the top bar leaves the moment a page loader starts: no frame paints both', async () => {
    const seen = await run('barpage', 1_500, { theme: 'studio-dark' });
    expect(seen.firstVisible, 'the bar was shown first').not.toBeNull();
    expect(seen.both).toBe(0);
  });
});

describe.skipIf(shotsDir === '')('the loader before and after the threshold (kept shots)', () => {
  for (const [width, height, phone] of [
    [1_280, 800, false],
    [390, 800, true],
  ] as const) {
    for (const mode of ['light', 'dark'] as const) {
      for (const scene of ['page', 'cache', 'spinner', 'sheet'] as const) {
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
