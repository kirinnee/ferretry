/**
 * THE SETTING PREVIEW in a real browser over fake data (`fixtures/setting-preview-scene.tsx`): a ~160 x 100 frame beside a
 * row that RESTS on the chosen value, plays before → after ONCE when the value changes (never an empty frame, in any
 * sample of the real play), holds still on the final frame under reduced motion, stops while the tab is hidden and adds no height beyond its own box.
 *
 * Set `FY_SETTING_PREVIEW_SHOTS_DIR` to keep `<viewport>-<theme>-<case>.png` (desktop 1280 and phone 390, light and dark).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(30_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_SETTING_PREVIEW_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-setting-preview-'));
  const child = Bun.spawn(
    [
      process.execPath,
      sceneBuilder,
      '--out',
      directory,
      '--entry',
      resolve(packageRoot, 'fixtures/setting-preview-scene.tsx'),
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the setting preview scene did not build (${code}):\n${stderr}\n${stdout}`);
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
  { name: '1280-light', width: 1_280, height: 520, phone: false, scheme: 'light' },
  { name: '1280-dark', width: 1_280, height: 520, phone: false, scheme: 'dark' },
  { name: '390-light', width: 390, height: 900, phone: true, scheme: 'light' },
  { name: '390-dark', width: 390, height: 900, phone: true, scheme: 'dark' },
] as const;

const open = async (variant: (typeof VARIANTS)[number], query = '') => {
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
  await tab.goto(`${origin}/?theme=studio-${variant.scheme}${query}`);
  await tab.waitForSelector('[data-setting-preview]');
  return { tab, problems, close: async () => await context.close() };
};

const shotOf = async (tab: Page, variant: (typeof VARIANTS)[number], name: string): Promise<void> => {
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${variant.name}-${name}.png`) });
};

/** The length of the one movement (`--sp-loop`). */
const PLAY_MS = 1_400;

/** Choose the other value of the first row: the frame plays its one movement. */
const flip = async (tab: Page): Promise<void> => {
  // Click and hold in the same page turn, so a slow machine cannot let the movement end before it is looked at.
  await tab.evaluate(
    () =>
      new Promise<void>(resolve => {
        document.querySelector<HTMLElement>('[data-flip]')?.click();
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            for (const animation of document.getAnimations()) animation.pause();
            resolve();
          }),
        );
      }),
  );
  await tab.waitForFunction(
    () => document.querySelector('[data-setting-preview]')?.getAttribute('data-sp-state') !== 'still',
  );
};

/** Jump every running animation to `ms` into its movement and hold it there, so a frame is the same on every run. */
const seek = async (tab: Page, ms: number): Promise<void> => {
  await tab.evaluate(at => {
    for (const animation of document.getAnimations()) {
      animation.pause();
      animation.currentTime = at;
    }
  }, ms);
};

/**
 * How much of the frame is covered by SOMETHING at this instant: the layers are stacked and each is opaque in itself, so
 * the covered share is 1 - (1 - before) * (1 - after). Below 1 the frame shows its bare background: an empty frame.
 * A frame with no `before` layer (resting) is covered by `after` alone.
 */
const coverageNow = (): number => {
  const frame = document.querySelector('[data-setting-preview]');
  if (frame === null) return -1;
  const opacity = (kind: string): number => {
    const layer = frame.querySelector(`.fy-sp__layer--${kind}`);
    return layer === null ? 0 : Number(getComputedStyle(layer).opacity);
  };
  return 1 - (1 - opacity('before')) * (1 - opacity('after'));
};

/** Sample the computed coverage on the animation timeline every 16 ms of the play: it must be full at every sample. */
const expectNeverEmpty = async (tab: Page): Promise<void> => {
  const lowest = { at: -1, coverage: 1 };
  for (let at = 0; at <= PLAY_MS; at += 16) {
    await seek(tab, at);
    const coverage = await tab.evaluate(coverageNow);
    if (coverage < lowest.coverage) {
      lowest.at = at;
      lowest.coverage = coverage;
    }
  }
  expect(lowest, 'the frame is covered at every sample of the play').toEqual({ at: -1, coverage: 1 });
};

/**
 * The REAL play, nothing held or seeked: pick the other value, then read the coverage back to back (one browser round
 * trip each) for two play lengths and return the samples. Run twice (a change and the way back) so both plays are sampled.
 */
const sampleRealPlay = async (tab: Page): Promise<{ coverages: number[]; states: string[] }> => {
  const coverages: number[] = [];
  const states: string[] = [];
  await tab.evaluate(() => document.querySelector<HTMLElement>('[data-flip]')?.click());
  const started = Date.now();
  while (Date.now() - started < PLAY_MS * 2) {
    const coverage = await tab.evaluate(coverageNow);
    const state = await tab.evaluate(
      () => document.querySelector('[data-setting-preview]')?.getAttribute('data-sp-state') ?? '',
    );
    coverages.push(coverage);
    states.push(state);
  }
  return { coverages, states };
};

const opacityOf = async (tab: Page, layer: 'before' | 'after'): Promise<number> =>
  await tab
    .locator(`[data-setting-preview] >> nth=0`)
    .locator(`.fy-sp__layer--${layer}`)
    .evaluate(node => Number(getComputedStyle(node).opacity));

describe('SettingPreview', () => {
  for (const variant of VARIANTS) {
    it(`${variant.name}: it is 160 x 100, rests, plays before then after once on a change, and the frames are shot`, async () => {
      const { tab, problems, close } = await open(variant);
      try {
        // Resting: the selected value only, never blank, and nothing running.
        expect(await tab.locator('[data-setting-preview]').first().getAttribute('data-sp-state')).toBe('still');
        expect(await tab.locator('.fy-sp__layer--before').count()).toBe(0);
        expect(await tab.evaluate(() => document.getAnimations().length)).toBe(0);
        expect(await opacityOf(tab, 'after')).toBe(1);
        await shotOf(tab, variant, 'rest');
        await flip(tab);
        const box = await tab.locator('[data-setting-preview]').first().boundingBox();
        expect(Math.round(box?.width ?? 0)).toBe(160);
        expect(Math.round(box?.height ?? 0)).toBe(100);
        expect(await tab.locator('[data-setting-preview]').first().getAttribute('data-sp-state')).toBe('playing');
        await seek(tab, 0);
        expect(await opacityOf(tab, 'before')).toBe(1);
        expect(await opacityOf(tab, 'after')).toBe(0);
        await shotOf(tab, variant, 't0-before');
        await seek(tab, PLAY_MS * 0.3);
        await shotOf(tab, variant, 'mid-fade');
        // 630 ms: the instant the old frame went empty (both layers transparent) before this was fixed.
        await seek(tab, 630);
        expect(await tab.evaluate(coverageNow)).toBe(1);
        await shotOf(tab, variant, 'mid-630ms');
        await seek(tab, PLAY_MS * 0.45);
        await shotOf(tab, variant, 'mid-fade-in');
        await expectNeverEmpty(tab);
        await seek(tab, PLAY_MS * 0.7);
        expect(await opacityOf(tab, 'before')).toBe(0);
        expect(await opacityOf(tab, 'after')).toBe(1);
        await shotOf(tab, variant, 'final-after');
        expect(problems).toEqual([]);
      } finally {
        await close();
      }
    });

    it(`${variant.name}: the real play (every frame, two plays) is never empty and then rests on the answer`, async () => {
      const { tab, close } = await open(variant);
      try {
        for (let play = 0; play < 2; play += 1) {
          const { coverages, states } = await sampleRealPlay(tab);
          // About 60 frames a second for two durations; a slow machine drops frames, so only a floor is asserted.
          expect(coverages.length).toBeGreaterThan(20);
          expect(Math.min(...coverages), 'no sample of the real play shows an empty frame').toBe(1);
          // It really moved (was playing in some samples) and ended at rest.
          expect(states).toContain('playing');
          expect(states.at(-1)).toBe('still');
          expect(await tab.evaluate(() => document.getAnimations().length)).toBe(0);
          expect(await tab.locator('.fy-sp__layer--before').count()).toBe(0);
          expect(await opacityOf(tab, 'after')).toBe(1);
          if (play === 0) await shotOf(tab, variant, 'rested-after-play');
        }
      } finally {
        await close();
      }
    });

    it(`${variant.name}: with motion reduced it shows the final frame only and runs nothing`, async () => {
      const { tab, close } = await open(variant, '&motion=reduced');
      try {
        await tab.locator('[data-flip]').first().click();
        expect(await tab.locator('[data-setting-preview]').first().getAttribute('data-sp-state')).toBe('still');
        expect(await tab.locator('.fy-sp__layer--before').count()).toBe(0);
        expect(await tab.evaluate(() => document.getAnimations().length)).toBe(0);
        expect(
          await tab
            .locator('.fy-sp__layer--after')
            .first()
            .evaluate(node => Number(getComputedStyle(node).opacity)),
        ).toBe(1);
        await shotOf(tab, variant, 'reduced-motion');
      } finally {
        await close();
      }
    });
  }

  it('stops while the tab is hidden and does not change the row height', async () => {
    const variant = VARIANTS[0];
    const { tab, close } = await open(variant);
    try {
      await flip(tab);
      const rowBox = await tab.locator('[data-setting-row="Menu side"]').boundingBox();
      // A 100px frame plus the row's own padding: the row grows to hold it and no further.
      expect(rowBox?.height ?? 0).toBeLessThan(120);
      await tab.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await tab.waitForFunction(
        () => document.querySelector('[data-setting-preview]')?.getAttribute('data-sp-state') === 'paused',
      );
      const states = await tab.evaluate(() => document.getAnimations().map(animation => animation.playState));
      expect(states.length).toBeGreaterThan(0);
      expect(states.every(state => state === 'paused')).toBe(true);
    } finally {
      await close();
    }
  });
});
