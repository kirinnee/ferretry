/**
 * L89b: A DARK DIALOG HAS AN EDGE you can see, in a real browser over fake data (`fixtures/select-box-scene.tsx?dialog=1`: the
 * app's one centred `Dialog`, the real stylesheet).
 *
 * In dark a dialog is a very dark panel on a near-black scrim, so its 1px edge is the only thing that says where it ends. It was
 * drawn in the decorative hairline (`--border`), 1.07-2.1:1 against the scrim in six of the twelve dark palettes. A control
 * boundary must clear 3:1 (WCAG 1.4.11), so the edge is measured against the scrim ACTUALLY painted over the page, in every
 * palette. Light is left as it is: its panel stands out by its fill, and `--border-strong` there would make the edge weaker.
 *
 * Set `FY_LAYOUT_SHOTS_DIR` to keep `<name>.png` shots.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Page } from 'playwright-core';
import { COLOUR_TOOLS, type ColourTools } from '../support/browser/colour.ts';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';
import { PALETTES, lookOfPalette } from '../../src/theme/catalog.ts';

setDefaultTimeout(120_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_LAYOUT_SHOTS_DIR ?? '';

let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-dialog-edge-'));
  const child = Bun.spawn(
    [
      process.execPath,
      sceneBuilder,
      '--out',
      directory,
      '--entry',
      resolve(packageRoot, 'fixtures/select-box-scene.tsx'),
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the select box scene did not build (${code}):\n${stderr}\n${stdout}`);
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
    deviceScaleFactor: phone ? 2 : 1,
    hasTouch: phone,
    isMobile: phone,
    reducedMotion: 'reduce',
  });
  const tab = await context.newPage();
  tab.setDefaultTimeout(15_000);
  await tab.goto(`${server?.url.origin}/?theme=${palette}-${mode}&dialog=1&lines=4`);
  await tab.click('[data-open]');
  await tab.waitForSelector('.fy-dialog__panel');
  await tab.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });
  await tab.evaluate(COLOUR_TOOLS);
  return { tab, close: async () => await context.close() };
};

/** The dialog's edge against the scrim as painted over the page behind it, and the edge's own colour token. */
const edge = async (tab: Page) =>
  await tab.evaluate(() => {
    const { backdrop, over, ratio, rgba } = (window as unknown as { __colour: ColourTools }).__colour;
    const panel = document.querySelector('.fy-dialog__panel') as HTMLElement;
    const scrim = document.querySelector('.fy-dialog__scrim') as HTMLElement;
    const style = getComputedStyle(panel);
    const page = backdrop(document.body);
    const dimmed = over(rgba(getComputedStyle(scrim).backgroundColor), [...page, 1]);
    const fill = backdrop(panel);
    const line = over(rgba(style.borderTopColor), [...fill, 1]);
    const probe = document.createElement('i');
    probe.style.color = 'var(--border)';
    panel.append(probe);
    const hairline = getComputedStyle(probe).color;
    probe.remove();
    return {
      edge: ratio(line, dimmed),
      border: style.borderTopColor,
      hairline,
      width: Number.parseFloat(style.borderTopWidth),
    };
  });

const shot = async (tab: Page, name: string): Promise<void> => {
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}.png`) });
};

describe('a dark dialog has an edge that reads against the scrim', () => {
  it('every dark palette, in its own look, draws the dialog edge at 3:1 or more against the scrim', async () => {
    const misses: string[] = [];
    const lowest = { value: 99, palette: '' };
    for (const { id } of PALETTES) {
      const look = lookOfPalette(id);
      const { tab, close } = await open(1_440, 900, 'dark', id);
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
        const seen = await edge(tab);
        if (seen.edge < lowest.value) {
          lowest.value = seen.edge;
          lowest.palette = id;
        }
        if (seen.edge < 3) misses.push(`${id}: ${seen.edge.toFixed(2)}:1`);
      } finally {
        await close();
      }
    }
    if (process.env.FY_LAYOUT_SHOTS_DIR)
      console.log(`lowest dark dialog edge: ${lowest.palette} ${lowest.value.toFixed(2)}:1`);
    expect(misses, 'dark palettes whose dialog edge is under 3:1 against the scrim').toEqual([]);
  });

  it('light keeps its hairline: its panel stands out by its fill, and a stronger ink would weaken the edge', async () => {
    const { tab, close } = await open(1_440, 900, 'light');
    try {
      const seen = await edge(tab);
      expect(seen.border, 'the light dialog edge stays the decorative hairline').toBe(seen.hairline);
    } finally {
      await close();
    }
  });

  for (const [width, height] of [
    [390, 844],
    [1_440, 900],
  ] as const)
    for (const mode of ['light', 'dark'] as const)
      it(`${width}, ${mode}: the dialog on its scrim (shot)`, async () => {
        const { tab, close } = await open(width, height, mode);
        try {
          const seen = await edge(tab);
          expect(seen.width, 'a 1px edge').toBeGreaterThan(0);
          await shot(tab, `L89b-${width}-${mode}`);
        } finally {
          await close();
        }
      });
});
