/**
 * THE LOOK PREVIEWS in a real browser over fake data (`fixtures/device-controls-scene.tsx`: the real Settings › This
 * device page, no daemon): colour mode, text size and motion each carry a 160 x 100 animated frame, choosing a value
 * replays it, the Motion scene moves only while motion is allowed, and a preview never pushes the page sideways.
 *
 * Set `FY_LOOK_PREVIEWS_SHOTS_DIR` to keep `<viewport>-<theme>-<case>.png` (desktop 1280 and phone 390, light and dark).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(30_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_LOOK_PREVIEWS_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-look-previews-'));
  const child = Bun.spawn(
    [
      process.execPath,
      sceneBuilder,
      '--out',
      directory,
      '--entry',
      resolve(packageRoot, 'fixtures/device-controls-scene.tsx'),
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the look previews scene did not build (${code}):\n${stderr}\n${stdout}`);
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
  { name: '1280-light', width: 1_280, height: 900, phone: false, scheme: 'light' },
  { name: '1280-dark', width: 1_280, height: 900, phone: false, scheme: 'dark' },
  { name: '390-light', width: 390, height: 1_500, phone: true, scheme: 'light' },
  { name: '390-dark', width: 390, height: 1_500, phone: true, scheme: 'dark' },
] as const;

const open = async (variant: (typeof VARIANTS)[number]) => {
  const context = await browser.newContext({
    viewport: { width: variant.width, height: variant.height },
    deviceScaleFactor: variant.phone ? 2 : 1,
    hasTouch: variant.phone,
    isMobile: variant.phone,
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
  await tab.goto(`${origin}/settings?theme=studio-${variant.scheme}`);
  await tab.waitForSelector('[data-setting-row="Motion"] [data-setting-preview]');
  return { tab, problems, close: async () => await context.close() };
};

const shotOf = async (tab: Page, variant: (typeof VARIANTS)[number], name: string): Promise<void> => {
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${variant.name}-${name}.png`) });
};

/** Jump every animation inside the previews to `ms` into its loop and hold it there, so a frame is the same on every run. */
const seek = async (tab: Page, ms: number): Promise<void> => {
  await tab.evaluate(at => {
    for (const animation of document.getAnimations()) {
      animation.pause();
      animation.currentTime = at;
    }
  }, ms);
};

/**
 * Every frame is covered by something at every 16 ms of the play: the layers are stacked and each is opaque in itself,
 * so the covered share is 1 - (1 - before) * (1 - after), and below 1 the frame shows its bare background (an empty frame).
 */
const expectNeverEmpty = async (tab: Page): Promise<void> => {
  let lowest = 1;
  for (let at = 0; at <= PLAY_MS; at += 16) {
    await seek(tab, at);
    const covered = await tab.evaluate(() =>
      Math.min(
        ...[...document.querySelectorAll('[data-setting-preview]')].map(frame => {
          const opacity = (kind: string) => {
            const layer = frame.querySelector(`.fy-sp__layer--${kind}`);
            return layer === null ? 0 : Number(getComputedStyle(layer).opacity);
          };
          return 1 - (1 - opacity('before')) * (1 - opacity('after'));
        }),
      ),
    );
    lowest = Math.min(lowest, covered);
  }
  expect(lowest, 'no frame is ever empty during the play').toBe(1);
};

/** The length of the one movement (`--sp-loop`). */
const PLAY_MS = 1_400;

const ROWS = ['Colour mode', 'Text size', 'Motion'] as const;
const frameOf = (tab: Page, row: string) => tab.locator(`[data-setting-row="${row}"] [data-setting-preview]`);

/**
 * The frames REST on the chosen value and play once when it changes, so every row is given one change: Dark, Larger,
 * and Motion Reduced then back to Follow system (so its scene moves again).
 */
const playAll = async (tab: Page, hold = true): Promise<void> => {
  // Each click is followed by a hold at 0, so a movement cannot finish while the next click is being made.
  for (const [group, text] of [
    ['Colour mode', 'Dark'],
    ['Text size', 'Larger'],
    ['Motion', 'Reduced'],
    ['Motion', 'Follow system'],
  ] as const) {
    await tab.locator(`[role="radiogroup"][aria-label="${group}"] label`, { hasText: text }).click();
    if (hold) await seek(tab, 0);
  }
};

describe('the Look previews', () => {
  for (const variant of VARIANTS) {
    it(`${variant.name}: each of the three rows carries a 160 x 100 frame that plays, and the page does not widen`, async () => {
      const { tab, problems, close } = await open(variant);
      try {
        for (const row of ROWS) expect(await frameOf(tab, row).getAttribute('data-sp-state')).toBe('still');
        await playAll(tab);
        for (const row of ROWS) {
          // A frame scrolled out of view holds its movement (that is the design), so each is brought into view first.
          await frameOf(tab, row).scrollIntoViewIfNeeded();
          await tab.waitForFunction(
            name =>
              document
                .querySelector(`[data-setting-row="${name}"] [data-setting-preview]`)
                ?.getAttribute('data-sp-state') === 'playing',
            row,
          );
          const box = await frameOf(tab, row).boundingBox();
          expect(Math.round(box?.width ?? 0)).toBe(160);
          expect(Math.round(box?.height ?? 0)).toBe(100);
          expect(await frameOf(tab, row).getAttribute('data-sp-state')).toBe('playing');
        }
        expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await frameOf(tab, 'Motion').scrollIntoViewIfNeeded();
        await seek(tab, 0);
        await shotOf(tab, variant, 'look-t0-before');
        await seek(tab, PLAY_MS * 0.3);
        await shotOf(tab, variant, 'look-mid-fade');
        await seek(tab, 630);
        await shotOf(tab, variant, 'look-mid-630ms');
        await seek(tab, PLAY_MS * 0.45);
        await shotOf(tab, variant, 'look-mid-fade-in');
        await expectNeverEmpty(tab);
        await seek(tab, PLAY_MS * 0.7);
        await shotOf(tab, variant, 'look-final');
        expect(problems).toEqual([]);
      } finally {
        await close();
      }
    });

    it(`${variant.name}: pausing holds the Motion scene's own animations where they are, not back at 0`, async () => {
      const { tab, close } = await open(variant);
      try {
        await playAll(tab, false);
        await frameOf(tab, 'Motion').scrollIntoViewIfNeeded();
        await tab.waitForTimeout(300);
        await tab.evaluate(() => {
          Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
          document.dispatchEvent(new Event('visibilitychange'));
        });
        await tab.waitForFunction(
          () =>
            document
              .querySelector('[data-setting-row="Motion"] [data-setting-preview]')
              ?.getAttribute('data-sp-state') === 'paused',
        );
        const mine = () =>
          tab.evaluate(() =>
            document
              .getAnimations()
              .filter(a => (a.effect as KeyframeEffect | null)?.target?.closest('[data-setting-row="Motion"]'))
              .map(a => ({
                name: (a as CSSAnimation).animationName,
                state: a.playState,
                at: Number(a.currentTime ?? 0),
              })),
          );
        await tab.waitForTimeout(150); // the pause lands on the next frame
        const held = await mine();
        // The dots and the ring keep their animation while paused (3 dots + ring + 2 fade layers), all paused.
        expect(held.filter(a => a.name === 'fy-dap-bounce' || a.name === 'fy-dap-turn').length).toBe(4);
        expect(held.every(a => a.state === 'paused')).toBe(true);
        expect(held.filter(a => a.name === 'fy-dap-bounce' || a.name === 'fy-dap-turn').every(a => a.at > 0)).toBe(
          true,
        );
        await tab.waitForTimeout(300);
        expect((await mine()).map(a => a.at)).toEqual(held.map(a => a.at));
      } finally {
        await close();
      }
    });

    it(`${variant.name}: choosing a value replays its frame, and Reduced stills the Motion one`, async () => {
      const { tab, close } = await open(variant);
      try {
        await tab.locator('[role="radiogroup"][aria-label="Colour mode"] label', { hasText: 'Dark' }).click();
        expect(await frameOf(tab, 'Colour mode').getAttribute('data-sp-value')).toBe('dark');
        await tab.locator('[role="radiogroup"][aria-label="Text size"] label', { hasText: 'Larger' }).click();
        expect(await frameOf(tab, 'Text size').getAttribute('data-sp-value')).toBe('larger');
        // The larger frame draws the lines bigger than the default one while the button keeps its size, and no line is cut.
        const clipped = await tab.evaluate(() =>
          [...document.querySelectorAll('[data-setting-row="Text size"] .fy-dap-type__line')].some(
            node => node.scrollWidth > node.clientWidth,
          ),
        );
        expect(clipped).toBe(false);
        await seek(tab, PLAY_MS * 0.7);
        await shotOf(tab, variant, 'look-dark-larger');
        await tab.locator('[role="radiogroup"][aria-label="Motion"] label', { hasText: 'Reduced' }).click();
        await tab.waitForFunction(
          () =>
            document
              .querySelector('[data-setting-row="Motion"] [data-setting-preview]')
              ?.getAttribute('data-sp-state') === 'still',
        );
        expect(await frameOf(tab, 'Motion').getAttribute('data-dap-motion')).toBeNull();
        expect(await frameOf(tab, 'Motion').locator('[data-dap-motion="still"]').count()).toBe(1);
        const running = await tab.evaluate(
          () =>
            document
              .getAnimations()
              .filter(animation =>
                (animation.effect as KeyframeEffect | null)?.target?.closest('[data-setting-preview]'),
              ).length,
        );
        expect(running).toBe(0);
        await frameOf(tab, 'Motion').scrollIntoViewIfNeeded();
        await shotOf(tab, variant, 'look-motion-reduced');
      } finally {
        await close();
      }
    });
  }
});
