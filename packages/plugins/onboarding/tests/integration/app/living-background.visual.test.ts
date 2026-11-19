/**
 * THE LIVING BACKGROUND behind the first-run page and the stepper, in a real browser over fake data (the REAL
 * `OnboardingPage` via `fixtures/setup-link-scene.tsx`, the REAL `StepperView` via `fixtures/stepper-scene.tsx`):
 *
 *  - one background, scenery (`aria-hidden`, no pointer), whose grid breathes and whose glow drifts;
 *  - only `transform` and `opacity` ever animate (nothing re-lays-out or repaints a phone);
 *  - under reduced motion, from the OS OR from the app's Motion = Reduced, nothing runs and the picture is whole;
 *  - a hidden tab pauses both animations, a visible one resumes them;
 *  - the content does not move: its bounding boxes are the same with and without the background;
 *  - text keeps >= 4.5:1 over the brightest frame of the background.
 *
 * Set `FY_LIVING_BG_SHOTS_DIR` to keep `<viewport>-<scheme>-<scene>-t0|t3|before.png` (phone 390 and desktop 1280, light and
 * dark; `t0` is the first frame, `t3` the frame three seconds in) and `<...>-reduced.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_LIVING_BG_SHOTS_DIR ?? '';

interface Scene {
  readonly name: 'setup' | 'stepper';
  readonly entry: string;
  readonly query: string;
  readonly host: string;
  /** Selectors whose boxes must not move when the background is removed. */
  readonly content: readonly string[];
  readonly fill: 'viewport' | 'parent';
}
const SCENES: readonly Scene[] = [
  {
    name: 'setup',
    entry: 'fixtures/setup-link-scene.tsx',
    query: '',
    host: '[data-onboarding="setup"]',
    content: ['[data-onboarding="setup"]', '#onboarding-title', '[data-onboarding="setup"] header'],
    fill: 'viewport',
  },
  {
    name: 'stepper',
    entry: 'fixtures/stepper-scene.tsx',
    query: '&case=fresh',
    host: '[data-first-run-stepper]',
    content: ['[data-first-run-stepper]', '#first-run-stepper-heading', '[data-first-run-stepper] li'],
    fill: 'parent',
  },
];

let browser: Browser;
const built = new Map<string, { directory: string; server: ReturnType<typeof Bun.serve> }>();

const build = async (entry: string) => {
  const directory = await mkdtemp(join(tmpdir(), 'ferretry-living-bg-'));
  const child = Bun.spawn([process.execPath, sceneBuilder, '--out', directory, '--entry', entry], {
    cwd: packageRoot,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the scene ${entry} did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request =>
      new URL(request.url).pathname === '/app.js'
        ? new Response(js, { headers: { 'content-type': 'text/javascript' } })
        : new Response(page, { headers: { 'content-type': 'text/html' } }),
  });
  return { directory, server };
};

beforeAll(async () => {
  browser = await sharedChromium();
  for (const scene of SCENES) built.set(scene.name, await build(scene.entry));
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 240_000);

afterAll(async () => {
  for (const { directory, server } of built.values()) {
    server.stop(true);
    await rm(directory, { force: true, recursive: true });
  }
});

const VARIANTS = [
  { name: '1280-light', width: 1_280, height: 800, phone: false, scheme: 'light' },
  { name: '1280-dark', width: 1_280, height: 800, phone: false, scheme: 'dark' },
  { name: '390-light', width: 390, height: 844, phone: true, scheme: 'light' },
  { name: '390-dark', width: 390, height: 844, phone: true, scheme: 'dark' },
] as const;
type Variant = (typeof VARIANTS)[number];

const open = async (
  scene: Scene,
  variant: Variant,
  reducedMotion: 'reduce' | 'no-preference' = 'no-preference',
  appMotion = '',
) => {
  const { server } = built.get(scene.name) as { server: ReturnType<typeof Bun.serve> };
  const context = await browser.newContext({
    viewport: { width: variant.width, height: variant.height },
    deviceScaleFactor: variant.phone ? 2 : 1,
    hasTouch: variant.phone,
    isMobile: variant.phone,
    colorScheme: variant.scheme,
    reducedMotion,
  });
  const origin = server.url.origin;
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  const problems: string[] = [];
  tab.on('pageerror', error => problems.push(error.message));
  await tab.goto(`${origin}/?theme=studio-${variant.scheme}${scene.query}`);
  if (appMotion !== '') await tab.evaluate(value => (document.documentElement.dataset.motion = value), appMotion);
  await tab.waitForSelector(`${scene.host} [data-living-background]`);
  await tab.evaluate(async () => await document.fonts.ready);
  return { tab, problems, close: async () => await context.close() };
};

const runningAnimations = async (tab: Page): Promise<string[]> =>
  await tab.evaluate(() =>
    document
      .getAnimations()
      .filter(animation => animation.playState === 'running' && animation instanceof CSSAnimation)
      .map(animation => (animation as CSSAnimation).animationName),
  );

const seek = async (tab: Page, at: number): Promise<void> =>
  await tab.evaluate(time => {
    for (const animation of document.getAnimations()) {
      animation.pause();
      animation.currentTime = time;
    }
  }, at);

const shot = async (tab: Page, variant: Variant, scene: Scene, name: string): Promise<void> => {
  if (shotsDir !== '')
    await tab.screenshot({ path: join(shotsDir, `${variant.name}-${scene.name}-${name}.png`), fullPage: true });
};

const boxes = async (tab: Page, selectors: readonly string[]) =>
  await tab.evaluate(
    list =>
      list.map(selector => {
        const rect = (document.querySelector(selector) as Element).getBoundingClientRect();
        return [selector, rect.x, rect.y, rect.width, rect.height] as const;
      }),
    selectors,
  );

/** `rgb(...)`, `rgba(...)` or `color(srgb r g b [/ a])`, as 0-255 channels. */
const channels = (css: string): [number, number, number] => {
  const numbers = (css.match(/-?\d*\.?\d+/gu) ?? []).map(Number);
  const [r = 0, g = 0, b = 0] = numbers;
  return css.startsWith('color(') ? [r * 255, g * 255, b * 255] : [r, g, b];
};
const luminance = ([r, g, b]: [number, number, number]): number => {
  const lin = (channel: number): number => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const contrast = (a: [number, number, number], b: [number, number, number]): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
const over = (
  top: [number, number, number],
  alpha: number,
  under: [number, number, number],
): [number, number, number] => [
  top[0] * alpha + under[0] * (1 - alpha),
  top[1] * alpha + under[1] * (1 - alpha),
  top[2] * alpha + under[2] * (1 - alpha),
];

describe('The living background', () => {
  for (const scene of SCENES)
    for (const variant of VARIANTS) {
      it(`${scene.name} ${variant.name}: one scenery layer, a breathing grid and a drifting glow, only transform and opacity`, async () => {
        const { tab, problems, close } = await open(scene, variant);
        try {
          const layer = tab.locator(`${scene.host} [data-living-background]`);
          expect(await layer.count(), 'one background').toBe(1);
          expect(await layer.getAttribute('aria-hidden')).toBe('true');
          expect(await layer.getAttribute('data-fill')).toBe(scene.fill);
          expect(await layer.evaluate(node => getComputedStyle(node).pointerEvents)).toBe('none');
          const names = await runningAnimations(tab);
          expect(names).toContain('fy-lb-breathe');
          expect(names).toContain('fy-lb-drift');
          const properties = await tab.evaluate(() => {
            const found = new Set<string>();
            for (const animation of document.getAnimations()) {
              if (!(animation instanceof CSSAnimation)) continue;
              for (const frame of (animation.effect as KeyframeEffect).getKeyframes())
                for (const key of Object.keys(frame)) found.add(key);
            }
            return [...found].filter(key => !['offset', 'easing', 'composite', 'computedOffset'].includes(key));
          });
          expect(properties.filter(key => !['opacity', 'transform'].includes(key))).toEqual([]);
          await seek(tab, 0);
          await shot(tab, variant, scene, 't0');
          await seek(tab, 3_000);
          await shot(tab, variant, scene, 't3');
          // The same page without the background, for the before/after pair.
          await tab.evaluate(() => document.querySelector('[data-living-background]')?.remove());
          await shot(tab, variant, scene, 'before');
          expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          expect(problems).toEqual([]);
        } finally {
          await close();
        }
      });

      it(`${scene.name} ${variant.name}: the content has the same boxes with and without the background`, async () => {
        const { tab, close } = await open(scene, variant);
        try {
          const before = await boxes(tab, scene.content);
          await tab.evaluate(() => document.querySelector('[data-living-background]')?.remove());
          expect(await boxes(tab, scene.content)).toEqual(before);
        } finally {
          await close();
        }
      });

      it(`${scene.name} ${variant.name}: under reduced motion (OS or app) nothing runs and the picture is whole`, async () => {
        for (const how of ['os', 'app'] as const) {
          const { tab, close } = await open(
            scene,
            variant,
            how === 'os' ? 'reduce' : 'no-preference',
            how === 'app' ? 'reduced' : '',
          );
          try {
            expect(await runningAnimations(tab), `${how}: nothing runs`).toEqual([]);
            expect(await tab.locator('[data-living-background]').count(), `${how}: the still grid is drawn`).toBe(1);
            expect(await tab.locator('[data-living-background] .fy-lb-grid').isVisible()).toBe(true);
            if (how === 'os') await shot(tab, variant, scene, 'reduced');
          } finally {
            await close();
          }
        }
      });
    }

  it('switching Motion between Reduced and Full stops and restarts the movement live', async () => {
    const [scene, variant] = [SCENES[0] as Scene, VARIANTS[0]];
    const { tab, close } = await open(scene, variant);
    try {
      expect((await runningAnimations(tab)).length).toBeGreaterThan(0);
      await tab.evaluate(() => (document.documentElement.dataset.motion = 'reduced'));
      await tab.waitForSelector('[data-living-background]:not([data-live])');
      expect(await runningAnimations(tab)).toEqual([]);
      await tab.evaluate(() => delete document.documentElement.dataset.motion);
      await tab.waitForSelector('[data-living-background][data-live]');
      expect((await runningAnimations(tab)).length).toBeGreaterThan(0);
    } finally {
      await close();
    }
  });

  for (const scene of SCENES)
    it(`${scene.name}: a hidden tab pauses the animations, and a visible one resumes them`, async () => {
      const { tab, close } = await open(scene, VARIANTS[2]);
      try {
        const setHidden = async (hidden: boolean): Promise<void> =>
          await tab.evaluate(value => {
            Object.defineProperty(document, 'visibilityState', {
              configurable: true,
              get: () => (value ? 'hidden' : 'visible'),
            });
            document.dispatchEvent(new Event('visibilitychange'));
          }, hidden);
        await setHidden(true);
        await tab.waitForSelector('[data-living-background][data-paused]');
        const states = await tab.evaluate(() =>
          [...document.querySelectorAll('[data-living-background] *')]
            .flatMap(node => node.getAnimations())
            .filter(animation => animation instanceof CSSAnimation)
            .map(animation => animation.playState),
        );
        expect(states.length).toBe(2);
        expect([...new Set(states)]).toEqual(['paused']);
        await setHidden(false);
        await tab.waitForSelector('[data-living-background]:not([data-paused])');
        expect((await runningAnimations(tab)).length).toBeGreaterThanOrEqual(2);
      } finally {
        await close();
      }
    });

  for (const scheme of ['light', 'dark'] as const)
    it(`${scheme}: text keeps its contrast over the glow and the brightest dot`, async () => {
      const variant = VARIANTS.find(candidate => candidate.scheme === scheme && candidate.phone) as Variant;
      const { tab, close } = await open(SCENES[0] as Scene, variant);
      try {
        const read = await tab.evaluate(() => {
          const probe = (value: string): string => {
            const node = document.createElement('i');
            node.style.color = value;
            document.body.append(node);
            const resolved = getComputedStyle(node).color;
            node.remove();
            return resolved;
          };
          const grid = document.querySelector('.fy-lb-grid') as Element;
          const peak = [...document.getAnimations()]
            .filter(animation => animation instanceof CSSAnimation && animation.animationName === 'fy-lb-breathe')
            .flatMap(animation => (animation.effect as KeyframeEffect).getKeyframes())
            .map(frame => Number(frame.opacity))
            .filter(value => !Number.isNaN(value));
          return {
            bg: probe('var(--bg)'),
            fg: probe('var(--fg)'),
            muted: probe('var(--muted)'),
            dot: getComputedStyle(grid).color,
            glow: probe('var(--accent)'),
            peak: Math.max(...peak),
          };
        });
        const bg = channels(read.bg);
        // The glow is a wide wash, so text can sit anywhere on it: it alone keeps 4.5:1 (its full 12 %, centre of the drift).
        const glow = over(channels(read.glow), 0.12, bg);
        expect(contrast(channels(read.fg), glow), 'text on the glow').toBeGreaterThanOrEqual(4.5);
        expect(contrast(channels(read.muted), glow), 'muted text on the glow').toBeGreaterThanOrEqual(4.5);
        // A dot is 1.4 px on a 28 px grid and the grid fades out toward the middle, so no glyph sits on one for more than a
        // pixel or two. Worst case anyway (a full dot at the breathing peak, on top of the glow, no mask): text still reads.
        const worst = over(channels(read.dot), read.peak, glow);
        expect(read.peak, 'the breathing peak is read from the real animation').toBeGreaterThan(0);
        expect(contrast(channels(read.fg), worst), 'text on a dot, worst frame').toBeGreaterThanOrEqual(4.5);
        expect(contrast(channels(read.muted), worst), 'muted text on a dot, worst frame').toBeGreaterThanOrEqual(3);
      } finally {
        await close();
      }
    });
});
