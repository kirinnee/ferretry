/**
 * SCROLLING TO THE BOTTOM MUST NOT FLICKER "JUMP TO LATEST", in a real browser, on a phone and a desktop, in
 * light and dark.
 *
 * The owner (2026-10-31): "scrolling to the bottom will trigger a strong flicker". The pill's row used to appear
 * with the pill and collapse without it, so the scroller changed height at the very moment the reader arrived:
 * the browser clamped `scrollTop`, the follow model read the clamp as the reader scrolling up, detached, showed
 * the pill (and its row) again, and the next wheel tick did it all over. The scene is the real `Transcript`
 * (`fixtures/jump-latest-scene.tsx`). The reader wheels up well clear of the tail, then wheels back down past
 * the bottom while every animation frame records the scroller's height, its offset and whether the pill is
 * there. The height must never change, the pill must leave once and not return, and the reader must end on
 * the tail, following.
 *
 * With a live turn running the working row under the messages ticks every second, as in the owner's recording.
 * Set `FY_SCROLL_FLICKER_SHOTS_DIR` to keep `<viewport>-<scheme>-<idle|live>-<mid|bottom>.png`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sharedChromium } from './support/chromium.ts';

const packageRoot = resolve(import.meta.dir, '../..');
const shotsDir = process.env.FY_SCROLL_FLICKER_SHOTS_DIR ?? '';

const SCENE_CSS = `
  html, body, #root { height: 100%; margin: 0; }
  .scene-chat { box-sizing: border-box; display: flex; flex-direction: column; inset: 0; position: fixed; }
  .scene-messages { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; }
  .scene-chat .fy-transcript-shell { flex: 1 1 auto; margin: 0 auto; max-width: 760px; width: 100%; box-sizing: border-box; min-height: 0; }
  .scene-composer { border-top: 1px solid var(--fy-border, #888); flex: none; height: 64px; padding: 12px 16px; box-sizing: border-box; }
`;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-jump-flicker-'));
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(packageRoot, 'scripts/build-composer-integration-fixture.ts'),
      '--out',
      directory,
      '--entry',
      'tests/integration/fixtures/jump-latest-scene.tsx',
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the jump-latest scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

beforeAll(async () => {
  browser = await sharedChromium();
  const { css, js } = await build();
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${SCENE_CSS}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
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

const framesSettled = async (tab: Page): Promise<void> =>
  await tab.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

interface Sample {
  readonly height: number;
  readonly top: number;
  readonly gap: number;
  readonly pill: boolean;
}

/** Records one sample per animation frame until stopped; `stop()` returns them. */
const startSampling = async (tab: Page): Promise<void> =>
  await tab.evaluate(() => {
    const scroller = document.querySelector('.fy-transcript') as HTMLElement;
    const samples: Sample[] = [];
    let running = true;
    const tick = (): void => {
      if (!running) return;
      samples.push({
        height: scroller.clientHeight,
        top: scroller.scrollTop,
        gap: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
        pill: document.querySelector('.fy-jump-latest') !== null,
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    (window as unknown as { __stop: () => Sample[] }).__stop = () => {
      running = false;
      return samples;
    };
  });

const stopSampling = async (tab: Page): Promise<readonly Sample[]> =>
  await tab.evaluate(() => (window as unknown as { __stop: () => Sample[] }).__stop());

const VIEWPORTS = [
  { name: 'phone', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 },
  { name: 'desktop', viewport: { width: 1_440, height: 900 }, deviceScaleFactor: 1 },
] as const;

describe('jump to latest while scrolling to the bottom', () => {
  for (const { name, viewport, deviceScaleFactor } of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      for (const turn of ['idle', 'live'] as const)
        it(`does not flicker on a ${name} in ${scheme} with ${turn === 'live' ? 'a live turn running' : 'no turn running'}`, async () => {
          const context = await browser.newContext({ viewport, colorScheme: scheme, deviceScaleFactor });
          try {
            const origin = server?.url.origin ?? '';
            await context.route('**/*', async route =>
              new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
            );
            const tab = await context.newPage();
            await tab.goto(`${origin}/?theme=studio-${scheme}&last=table${turn === 'live' ? '&busy=1' : ''}`);
            await tab.waitForSelector('.fy-transcript-content > :last-child');
            await framesSettled(tab);

            const scroller = await tab.locator('.fy-transcript').boundingBox();
            if (scroller === null) throw new Error('no transcript on screen');
            await tab.mouse.move(scroller.x + scroller.width / 2, scroller.y + scroller.height / 2);

            // Well clear of the tail: detached, the pill on offer.
            await tab.mouse.wheel(0, -700);
            await tab.waitForSelector('.fy-jump-latest');
            await framesSettled(tab);
            if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}-${scheme}-${turn}-mid.png`) });

            // Back down in wheel-sized steps, past the bottom, then a second of the reader still there.
            await startSampling(tab);
            for (let step = 0; step < 40; step += 1) {
              await tab.mouse.wheel(0, 60);
              await tab.waitForTimeout(16);
            }
            await tab.waitForTimeout(1_000);
            const samples = await stopSampling(tab);
            await framesSettled(tab);
            if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}-${scheme}-${turn}-bottom.png`) });

            // The scroller never changes size, whether or not the pill is up.
            expect(new Set(samples.map(sample => sample.height)).size).toBe(1);
            // The pill leaves once on the way down and never comes back.
            const flips = samples.filter((sample, index) => index > 0 && sample.pill !== samples[index - 1]?.pill);
            expect(flips.length).toBeLessThanOrEqual(1);
            // The offset only ever moves down: nothing is clamped back up.
            const back = samples.filter(
              (sample, index) => index > 0 && sample.top < (samples[index - 1]?.top ?? 0) - 1,
            );
            expect(back).toEqual([]);
            // And the reader ends on the tail, following, with no pill.
            const last = samples.at(-1);
            expect(last?.pill).toBe(false);
            expect(last?.gap ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(1);
          } finally {
            await context.close();
          }
        });
});
