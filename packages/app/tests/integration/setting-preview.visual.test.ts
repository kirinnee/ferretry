/**
 * THE SETTING PREVIEW in a real browser over fake data (`fixtures/setting-preview-scene.tsx`): a ~160 x 100 frame beside a
 * row that loops before → after, holds still on the final frame under reduced motion, stops while the tab is hidden and
 * adds no height beyond its own box.
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

/** Jump every running animation to `ms` into its loop and hold it there, so a frame is the same on every run. */
const seek = async (tab: Page, ms: number): Promise<void> => {
  await tab.evaluate(at => {
    for (const animation of document.getAnimations()) {
      animation.pause();
      animation.currentTime = at;
    }
  }, ms);
};

const opacityOf = async (tab: Page, layer: 'before' | 'after'): Promise<number> =>
  await tab
    .locator(`[data-setting-preview] >> nth=0`)
    .locator(`.fy-sp__layer--${layer}`)
    .evaluate(node => Number(getComputedStyle(node).opacity));

describe('SettingPreview', () => {
  for (const variant of VARIANTS) {
    it(`${variant.name}: it is 160 x 100, plays before then after, and the frames are shot`, async () => {
      const { tab, problems, close } = await open(variant);
      try {
        const box = await tab.locator('[data-setting-preview]').first().boundingBox();
        expect(Math.round(box?.width ?? 0)).toBe(160);
        expect(Math.round(box?.height ?? 0)).toBe(100);
        expect(await tab.locator('[data-setting-preview]').first().getAttribute('data-sp-state')).toBe('playing');
        await seek(tab, 0);
        expect(await opacityOf(tab, 'before')).toBe(1);
        expect(await opacityOf(tab, 'after')).toBe(0);
        await shotOf(tab, variant, 't0-before');
        await seek(tab, 4_200 * 0.42);
        await shotOf(tab, variant, 'mid-fade');
        await seek(tab, 4_200 * 0.7);
        expect(await opacityOf(tab, 'before')).toBe(0);
        expect(await opacityOf(tab, 'after')).toBe(1);
        await shotOf(tab, variant, 'final-after');
        expect(problems).toEqual([]);
      } finally {
        await close();
      }
    });

    it(`${variant.name}: with motion reduced it shows the final frame only and runs nothing`, async () => {
      const { tab, close } = await open(variant, '&motion=reduced');
      try {
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
