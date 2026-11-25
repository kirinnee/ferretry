/**
 * L213: THE PINNED STEP STRIP HAS A VISIBLE BOTTOM EDGE in dark, in a real browser over fake data
 * (`fixtures/step-frame-scene.tsx?scene=pinned`: the real `StepPageFrame` with a pinned `StepDemo` and a long body).
 *
 * On a phone the heading and the demo (Appearance, Voice) stay while the body scrolls under them. The strip is opaque, and what
 * says "the body passes under this" is a soft shadow along its bottom edge. A black shadow cannot show on a near-black page: it
 * painted 0.56 L* of lightness step in studio dark (2.08 L* in light, where it reads). So the edge is READ FROM PIXELS: a screenshot
 * of the scrolled page, the lightness (CIE L*) of the page's own gutter in the rows under the strip's bottom edge, against the
 * strip's own fill. Dark must show a step at least as large as the light shadow's (2 L*), in every dark palette.
 *
 * Set `FY_LAYOUT_SHOTS_DIR` to keep `<name>.png` shots; `FY_PINNED_STRIP_LOG=1` prints the numbers.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';
import { PALETTES, lookOfPalette } from '../../src/theme/catalog.ts';

setDefaultTimeout(120_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_LAYOUT_SHOTS_DIR ?? '';
const log = process.env.FY_PINNED_STRIP_LOG === '1';

let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-pinned-strip-'));
  const child = Bun.spawn(
    [
      process.execPath,
      sceneBuilder,
      '--out',
      directory,
      '--entry',
      resolve(packageRoot, 'fixtures/step-frame-scene.tsx'),
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the step frame scene did not build (${code}):\n${stderr}\n${stdout}`);
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
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const open = async (width: number, height: number, mode: 'light' | 'dark', palette = 'studio') => {
  const browser = await sharedChromium();
  const phone = width < 768;
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme: mode,
    deviceScaleFactor: 1,
    hasTouch: phone,
    isMobile: phone,
    reducedMotion: 'reduce',
  });
  const tab = await context.newPage();
  tab.setDefaultTimeout(15_000);
  await tab.goto(`${server?.url.origin}/?theme=${palette}-${mode}&scene=pinned`);
  await tab.waitForSelector('.fy-spf__pin');
  await tab.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });
  return { tab, close: async () => await context.close() };
};

/** Scroll the body halfway under the pin, then read the page's own gutter under the strip's bottom edge from a screenshot. */
const stepUnderTheStrip = async (tab: Page): Promise<number> => {
  await tab.evaluate(() => {
    const scroller = document.querySelector('[data-scroller]') as HTMLElement;
    scroller.scrollTop = 420;
  });
  await tab.waitForTimeout(150);
  const bottom = await tab.evaluate(
    () => (document.querySelector('.fy-spf__pin') as HTMLElement).getBoundingClientRect().bottom,
  );
  const png = (await tab.screenshot()).toString('base64');
  return await tab.evaluate(
    async ({ png, bottom }) => {
      const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
      context.drawImage(image, 0, 0);
      const lightness = (x: number, y: number): number => {
        const [r, g, b] = context.getImageData(x, y, 1, 1).data;
        const lin = (v: number | undefined): number => {
          const c = (v ?? 0) / 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        };
        const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
        return luminance > 216 / 24389 ? 116 * Math.cbrt(luminance) - 16 : (24389 / 27) * luminance;
      };
      // The page's own gutter (the 16px strip left of the cards), so a card passing under never counts as the edge.
      const x = 8;
      const edge = Math.round(bottom);
      const fill = lightness(x, edge - 6);
      let widest = 0;
      for (let y = edge; y < edge + 24; y += 1) widest = Math.max(widest, Math.abs(lightness(x, y) - fill));
      return widest;
    },
    { png, bottom },
  );
};

const shot = async (tab: Page, name: string): Promise<void> => {
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}.png`) });
};

describe('the pinned strip has a bottom edge that reads in dark', () => {
  it('every dark palette, in its own look, shows at least the light shadow’s lightness step under the strip (2 L*)', async () => {
    const misses: string[] = [];
    for (const { id } of PALETTES) {
      const look = lookOfPalette(id);
      const { tab, close } = await open(390, 844, 'dark', id);
      try {
        await tab.evaluate(
          ({ style, palette }) => {
            const root = document.documentElement;
            root.setAttribute('data-style', style);
            root.setAttribute('data-palette', palette);
            root.setAttribute('data-mode', 'dark');
          },
          { style: look.style, palette: look.palette },
        );
        const step = await stepUnderTheStrip(tab);
        if (log) console.log(`${id}: ${step.toFixed(2)} L*`);
        if (step < 2) misses.push(`${id}: ${step.toFixed(2)} L*`);
      } finally {
        await close();
      }
    }
    expect(misses, 'dark palettes whose strip edge steps under 2 L* on the page').toEqual([]);
  });

  it('light is left as it is: the soft shadow already reads', async () => {
    const { tab, close } = await open(390, 844, 'light');
    try {
      const step = await stepUnderTheStrip(tab);
      if (log) console.log(`light: ${step.toFixed(2)} L*`);
      expect(step, 'the light strip edge reads').toBeGreaterThanOrEqual(2);
    } finally {
      await close();
    }
  });

  for (const [width, height] of [
    [390, 844],
    [1_440, 900],
  ] as const)
    for (const mode of ['light', 'dark'] as const)
      it(`${width}, ${mode}: the pinned step page (shot)`, async () => {
        const { tab, close } = await open(width, height, mode);
        try {
          await tab.evaluate(() => {
            (document.querySelector('[data-scroller]') as HTMLElement).scrollTop = 420;
          });
          await tab.waitForTimeout(150);
          await shot(tab, `L213-${width}-${mode}`);
        } finally {
          await close();
        }
      });
});
