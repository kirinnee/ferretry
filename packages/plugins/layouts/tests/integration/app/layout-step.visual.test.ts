/**
 * THE LAYOUT STEP in a real browser over fake data (`fixtures/layout-step-scene.tsx`): two short rows of cards (never
 * full width on a desktop), the demo of a card the person just chose plays once and then rests, motion off plays
 * nothing, and the page never scrolls sideways.
 *
 * Set `FY_LAYOUT_STEP_SHOTS_DIR` to keep `<viewport>-<theme>-<case>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(30_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_LAYOUT_STEP_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-layout-step-'));
  const child = Bun.spawn(
    [
      process.execPath,
      sceneBuilder,
      '--out',
      directory,
      '--entry',
      resolve(packageRoot, 'fixtures/layout-step-scene.tsx'),
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the layout step scene did not build (${code}):\n${stderr}\n${stdout}`);
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
  { name: '390-light', width: 390, height: 900, phone: true, scheme: 'light' },
  { name: '390-dark', width: 390, height: 900, phone: true, scheme: 'dark' },
] as const;
type Variant = (typeof VARIANTS)[number];

const open = async (variant: Variant, query = '') => {
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
  await tab.waitForSelector('[data-layout-step] [data-choice-cards]');
  return { tab, problems, close: async () => await context.close() };
};

const shot = async (tab: Page, variant: Variant, name: string): Promise<void> => {
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${variant.name}-${name}.png`), fullPage: true });
};

/** Jump every running animation to `ms` and hold it there, so a frame is the same on every run. */
const seek = async (tab: Page, ms: number): Promise<void> => {
  await tab.evaluate(at => {
    for (const animation of document.getAnimations()) {
      animation.pause();
      animation.currentTime = at;
    }
  }, ms);
};

describe('the layout step', () => {
  for (const variant of VARIANTS) {
    it(`${variant.name}: two rows of cards that fit, are not full width on a desktop, and never scroll sideways`, async () => {
      const { tab, problems, close } = await open(variant);
      try {
        await shot(tab, variant, 'rest');
        const boxes = await tab.$$eval('[data-layout-step] .fy-cc__card', cards =>
          cards.map(card => {
            const rect = card.getBoundingClientRect();
            const demo = card.querySelector('.fy-lstep-demo')?.getBoundingClientRect();
            return {
              width: rect.width,
              left: rect.left,
              right: rect.right,
              demo: demo ? { left: demo.left, right: demo.right } : null,
            };
          }),
        );
        expect(boxes).toHaveLength(4);
        for (const box of boxes) {
          expect(box.demo, 'every card draws its demo').not.toBeNull();
          expect(box.demo!.left).toBeGreaterThanOrEqual(box.left);
          expect(box.demo!.right).toBeLessThanOrEqual(box.right);
          if (!variant.phone) expect(Math.round(box.width), 'not full width').toBeLessThanOrEqual(320);
        }
        const overflow = await tab.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, 'no sideways scroll').toBeLessThanOrEqual(0);
        expect(problems).toEqual([]);
      } finally {
        await close();
      }
    });

    it(`${variant.name}: choosing Words and Compact plays each demo once, and then it rests`, async () => {
      const { tab, close } = await open(variant);
      try {
        await tab.locator('[data-choice="words"]').click();
        await tab.locator('[data-choice="compact"]').click();
        await seek(tab, 120);
        await shot(tab, variant, 'mid-animation');
        const moving = await tab.evaluate(() => document.getAnimations().length);
        expect(moving, 'something moves on select').toBeGreaterThan(0);
        await tab.evaluate(() => {
          for (const animation of document.getAnimations()) animation.finish();
        });
        await shot(tab, variant, 'chosen');
        const resting = await tab.evaluate(
          () => document.getAnimations().filter(animation => animation.playState === 'running').length,
        );
        expect(resting, 'nothing keeps repeating').toBe(0);
        const picked = await tab.$$eval('[data-layout-step] input:checked', inputs =>
          inputs.map(input => (input as HTMLInputElement).value),
        );
        expect(picked).toEqual(['words', 'compact']);
      } finally {
        await close();
      }
    });
  }

  it('with motion off nothing plays at all', async () => {
    const { tab, close } = await open(VARIANTS[0], '&motion=reduced');
    try {
      await tab.locator('[data-choice="words"]').click();
      await tab.locator('[data-choice="compact"]').click();
      const moving = await tab.evaluate(
        () => document.getAnimations().filter(animation => animation.playState === 'running').length,
      );
      expect(moving).toBe(0);
    } finally {
      await close();
    }
  });
});
