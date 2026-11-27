/**
 * LOOK-ALIKE STYLES (ledger W-81, E-105). The owner reported styles that are "too close to tell apart even with strong
 * minis": Geist vs Minimal Swiss, Studio / Lucid / Briefing, and Neumorphism in dark. The theme matrix
 * (`theme-matrix.visual.test.ts`) only compares each style with Studio on 8 colour-free probes, and a probe that differs by a
 * pixel of radius counts as "different"; it never asks whether two styles LOOK different.
 *
 * This file does. Every style is drawn on ONE palette, on the same specimen page the matrix uses, in both modes. Each
 * specimen's first 1400px is shrunk to a 64 x 70 grid of grey levels (letter shapes wash out, what is left is where the boxes,
 * edges, fills and shadows are), and each pair's distance is the mean grey difference over the cells either one draws on
 * (`tests/support/style-pairs.ts`). A WATCHED pair must be at least `LOOK_FLOOR` apart: the reported pairs, and every pair that
 * includes the Accessible style. A style added later is measured against every other one by the same loop (the pair list is
 * the catalogue's).
 *
 * `FY_STYLE_PAIRS_REPORT=<file>` writes every pair (markdown); `FY_STYLE_PAIRS_SHOTS_DIR=<dir>` keeps the screenshots.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { STYLES } from '../../src/theme/catalog.ts';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';
import { ACCESSIBLE_FLOOR, LOOK_FLOOR, lookDistance, REPORTED_PAIRS } from '../support/style-pairs.ts';

setDefaultTimeout(120_000);

const packageRoot = import.meta.dir;
const conversationScenes = resolve(packageRoot, '../../../plugins/conversation/tests/integration/app/fixtures');
const report = process.env.FY_STYLE_PAIRS_REPORT ?? '';
const shotsDir = process.env.FY_STYLE_PAIRS_SHOTS_DIR ?? '';
/** The palette every style is drawn on: the neutral house one, which every style takes. */
const PALETTE = 'studio';
const MODES = ['light', 'dark'] as const;
const VIEW = { width: 1_280, height: 2_000 };
/** The specimen's first 1400px: every style draws its components inside it, and the empty ground below is the same on all. */
const CROP = { x: 0, y: 0, width: 1_280, height: 1_400 };
const GRID = { w: 64, h: 70 };

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-style-pairs-'));
  const child = Bun.spawn(
    [
      process.execPath,
      sceneBuilder,
      '--out',
      directory,
      '--entry',
      resolve(conversationScenes, 'theme-matrix-scene.tsx'),
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  browser = await sharedChromium();
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request =>
      new URL(request.url).pathname === '/app.js'
        ? new Response(js, { headers: { 'content-type': 'text/javascript' } })
        : new Response(html, { headers: { 'content-type': 'text/html' } }),
  });
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

/** A picture (base64 PNG) shrunk to a grid of grey levels, in the page (there is no image library in the box). */
const GREY = `(async (b64, w, h) => {
  const image = new Image();
  image.src = 'data:image/png;base64,' + b64;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(image, 0, 0, w, h);
  const px = g.getImageData(0, 0, w, h).data;
  const out = [];
  for (let i = 0; i < px.length; i += 4) out.push(Math.round(0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]));
  return out;
})`;

const apply = async (tab: Page, style: string, mode: string): Promise<void> => {
  await tab.evaluate(
    ([s, p, m]) => {
      const root = document.documentElement;
      root.setAttribute('data-style', s as string);
      root.setAttribute('data-palette', p as string);
      root.setAttribute('data-mode', m as string);
    },
    [style, PALETTE, mode] as const,
  );
  // A face that arrives late re-flows the text: measure after the new style's faces are in.
  await tab.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
  });
};

const greys = new Map<string, readonly number[]>();
const key = (style: string, mode: string) => `${style}|${mode}`;

const measure = async (mode: (typeof MODES)[number]): Promise<void> => {
  const context = await browser.newContext({ viewport: VIEW, colorScheme: mode, deviceScaleFactor: 1 });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  await tab.goto(`${origin}/`);
  // A colour read mid-transition is neither the old style nor the new one: measure the settled state.
  await tab.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });
  await tab.waitForSelector('[data-probe="hypermedia"] .dh-doc .callout');
  for (const style of STYLES) {
    await apply(tab, style.id, mode);
    const png = await tab.screenshot({ clip: CROP, animations: 'disabled' });
    if (shotsDir !== '') await writeFile(join(shotsDir, `${style.id}-${mode}.png`), png);
    greys.set(
      key(style.id, mode),
      (await tab.evaluate(`${GREY}(${JSON.stringify(png.toString('base64'))}, ${GRID.w}, ${GRID.h})`)) as number[],
    );
  }
  await context.close();
};

const ids = STYLES.map(style => style.id) as string[];
const pairs = ids.flatMap((a, i) => ids.slice(i + 1).map(b => [a, b] as const));
const accessible = (a: string, b: string): boolean => a === 'accessible' || b === 'accessible';
const watched = (a: string, b: string): boolean =>
  accessible(a, b) || REPORTED_PAIRS.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
const rows: string[] = [];

describe('the accessibility style', () => {
  it('is in the catalogue, so every pair above includes it', () => {
    expect(ids).toContain('accessible');
  });
});
const floor = (a: string, b: string): number => (accessible(a, b) ? ACCESSIBLE_FLOOR : LOOK_FLOOR);

for (const mode of MODES)
  describe(`style pairs in ${mode}`, () => {
    beforeAll(async () => {
      await measure(mode);
    });

    for (const [a, b] of pairs)
      it(`${a} and ${b}`, () => {
        const distance = lookDistance(greys.get(key(a, mode)) ?? [], greys.get(key(b, mode)) ?? []);
        rows.push(`| ${mode} | ${a} | ${b} | ${distance.toFixed(2)} |${watched(a, b) ? ' watched' : ''}`);
        if (!watched(a, b)) return;
        expect(distance, `${a} and ${b} in ${mode} read alike (need ${floor(a, b)})`).toBeGreaterThanOrEqual(
          floor(a, b),
        );
      });
  });

afterAll(async () => {
  if (report !== '')
    await writeFile(
      report,
      `| mode | a | b | distance | |\n| --- | --- | --- | --- | --- |\n${rows.sort().join('\n')}\n`,
    );
});
