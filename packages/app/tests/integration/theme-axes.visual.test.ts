/**
 * r11 T1 · THE AXES, proved in a real browser (the owner's lines, item 12):
 *   "let them be a default palette when they select the style … have it as a flag tho (dont change my color when i change
 *    my style)"; "highcontrast is a color right? the style should be accessible"; "neo brutalism color with neo
 *    brutalism style? makes not that much sense"; "remove … blueprint, wayfinding, phosphor etc".
 *
 *   1. Pick Neo on a device on Inkwell → the page's `data-palette` becomes `neo` (labelled Pop Art). With `keepPalette` stored
 *      → it stays Inkwell (Studio's palette). The change shows on the root element the stylesheet reads.
 *   2. A stored palette paints itself in the FIRST frame (pre-paint, before any module). An id with no pack has no migration:
 *      `theme-open-ids.visual.test.ts` owns that case.
 *   3. The palette picker draws one chip per catalogue palette, each by the name the ONE map gives it (`theme/palette-names.ts`;
 *      C59 O6: proper names); none is named after a style (Briefing, owner's own ask, is the one allowed).
 *
 * The page is the real `App` over a fake machine (`fixtures/device-controls-scene.tsx`); no network, no real homes.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser } from 'playwright-core';
import { PALETTES } from '../../src/theme/catalog.ts';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';

const PALETTE_LABELS = PALETTES.map(palette => palette.label);

setDefaultTimeout(120_000);

const packageRoot = import.meta.dir;
const prePaint = await readFile(resolve(packageRoot, '../../public/pre-paint.js'), 'utf8');
const themeIds = await readFile(resolve(packageRoot, '../../public/generated/theme-ids.js'), 'utf8');

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-theme-axes-'));
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
  if (code !== 0) throw new Error(`the theme scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  // The pre-paint page: the REAL script, parser-blocking, then ONE inline reader that runs before anything else could.
  const bare = `<!doctype html><html><head><meta charset="utf-8"><script src="/generated/theme-ids.js"></script><script src="/pre-paint.js"></script><script>window.__first = { style: document.documentElement.getAttribute('data-style'), palette: document.documentElement.getAttribute('data-palette'), mode: document.documentElement.getAttribute('data-mode') };</script></head><body></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      if (path === '/generated/theme-ids.js')
        return new Response(themeIds, { headers: { 'content-type': 'text/javascript' } });
      if (path === '/pre-paint.js') return new Response(prePaint, { headers: { 'content-type': 'text/javascript' } });
      if (path === '/bare') return new Response(bare, { headers: { 'content-type': 'text/html' } });
      return new Response(page, { headers: { 'content-type': 'text/html' } });
    },
  });
  browser = await sharedChromium();
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const origin = (): string => server?.url.origin ?? '';

/** The Appearance page with a device that already stored `seed`. */
const openSettings = async (
  seed: Record<string, unknown>,
  view: { width: number; height: number; colorScheme?: 'light' | 'dark' } = { width: 1_280, height: 3_200 },
) => {
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    colorScheme: view.colorScheme,
  });
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin() ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  tab.setDefaultTimeout(10_000);
  await tab.goto(`${origin()}/settings?seed=${encodeURIComponent(JSON.stringify(seed))}`);
  await tab.waitForSelector('[data-specimen]');
  return { tab, close: async () => await context.close() };
};

const root = (tab: Awaited<ReturnType<typeof openSettings>>['tab']) =>
  tab.evaluate(() => ({
    style: document.documentElement.dataset.style,
    palette: document.documentElement.dataset.palette,
  }));

const INDIGO_STUDIO = { style: 'studio', palette: 'studio', mode: 'light', textScale: 'default' } as const;

describe('picking a style brings its default palette, unless the device keeps its colours', () => {
  it('Neo on Inkwell → Pop Art; with keepPalette on → stays Inkwell', async () => {
    const changing = await openSettings(INDIGO_STUDIO);
    try {
      expect(await root(changing.tab)).toEqual({ style: 'studio', palette: 'studio' });
      await changing.tab.locator('[data-choice="neo"]').click();
      expect(await root(changing.tab)).toEqual({ style: 'neo', palette: 'neo' });
      // Pop is the colour the style came with; the person can then change it on its own.
      await changing.tab.locator('[data-palette-chip="geist"]').click();
      expect(await root(changing.tab)).toEqual({ style: 'neo', palette: 'geist' });
    } finally {
      await changing.close();
    }
    const keeping = await openSettings({ ...INDIGO_STUDIO, keepPalette: true });
    try {
      await keeping.tab.locator('[data-choice="neo"]').click();
      expect(await root(keeping.tab)).toEqual({ style: 'neo', palette: 'studio' });
    } finally {
      await keeping.close();
    }
  });

  // Ruling C-5 (O10 Q4): the style's default applies only until the owner picks a palette; a chosen one is never overridden.
  for (const view of [
    { name: '1440-light', width: 1_440, height: 3_200, colorScheme: 'light' },
    { name: '1440-dark', width: 1_440, height: 3_200, colorScheme: 'dark' },
    { name: '390-light', width: 390, height: 3_200, colorScheme: 'light' },
    { name: '390-dark', width: 390, height: 3_200, colorScheme: 'dark' },
  ] as const)
    it(`Neo → Terminal (picked) → Geist keeps Terminal in Settings (${view.name})`, async () => {
      const page = await openSettings({ ...INDIGO_STUDIO, mode: view.colorScheme }, view);
      try {
        await page.tab.locator('[data-choice="neo"]').click();
        expect(await root(page.tab)).toEqual({ style: 'neo', palette: 'neo' });
        await page.tab.locator('[data-palette-chip="hacker"]').click();
        expect(await root(page.tab)).toEqual({ style: 'neo', palette: 'hacker' });
        await page.tab.locator('[data-choice="geist"]').click();
        expect(await root(page.tab)).toEqual({ style: 'geist', palette: 'hacker' });
        const dir = process.env.FY_Q4_SHOTS_DIR;
        if (dir) {
          await page.tab.locator('[data-choice="geist"]').scrollIntoViewIfNeeded();
          await page.tab.screenshot({ path: `${dir}/${view.name}-q4-settings-style-geist.png` });
          await page.tab.locator('[data-palette-chip="hacker"]').scrollIntoViewIfNeeded();
          await page.tab.screenshot({ path: `${dir}/${view.name}-q4-settings-palette-terminal-kept.png` });
        }
      } finally {
        await page.close();
      }
    });

  // Owner C1 (!A581) then !A605: no removed palette's name, and no "was …", renders anywhere; every live palette shows its proper name.
  it('no old palette name renders on the Appearance page, in text, labels or tooltips', async () => {
    const page = await openSettings(INDIGO_STUDIO);
    try {
      const rendered = await page.tab.evaluate(() => {
        const texts = [document.body.innerText];
        for (const node of document.querySelectorAll('[aria-label],[title],[placeholder],[alt]'))
          for (const name of ['aria-label', 'title', 'placeholder', 'alt']) texts.push(node.getAttribute(name) ?? '');
        return texts.join('\n');
      });
      const OLD =
        /\b(?:Phosphor|Blueprint|Broadsheet|Wayfinding|Ledger|Ma|Cyberpunk|Retro futurism|Vintage analog|High Contrast)\b|\bwas (?:Studio|Geist|Mission|Neo)\b/u;
      expect(rendered.match(OLD)?.[0]).toBeUndefined();
      // The names that DO render are the catalogue's, each from the one map.
      for (const name of PALETTE_LABELS) expect(rendered).toContain(name);
    } finally {
      await page.close();
    }
  });

  it('the palette picker shows one chip per palette, each by its proper name, none named after a style', async () => {
    const page = await openSettings(INDIGO_STUDIO);
    try {
      const names = await page.tab
        .locator('[data-palette-chip] .fy-ap-chip__name')
        .evaluateAll(nodes => nodes.map(node => node.textContent?.trim() ?? ''));
      expect(names).toEqual(PALETTE_LABELS);
      const styleNames = await page.tab
        .locator('[data-choice]')
        .evaluateAll(nodes => nodes.map(node => (node.getAttribute('data-choice') ?? '').toLowerCase()));
      for (const name of names) if (name !== 'Briefing') expect(styleNames).not.toContain(name.toLowerCase());
      expect(await page.tab.locator('[data-choice="contrast"]').count()).toBe(0);
    } finally {
      await page.close();
    }
  });
});

describe('pre-paint: the first frame already wears the stored look', () => {
  const firstFrame = async (value: Record<string, unknown>) => {
    const context = await browser.newContext();
    try {
      await context.addInitScript(
        raw => localStorage.setItem('fy:app:theme', raw),
        JSON.stringify({ format: 1, value }),
      );
      const tab = await context.newPage();
      await tab.goto(`${origin()}/bare`);
      return await tab.evaluate(() => (window as unknown as { __first: Record<string, string> }).__first);
    } finally {
      await context.close();
    }
  };

  // C59 O6: Gradient mesh and Briefing are palettes again (and Aurora and Afterglow are new), so a stored one paints itself.
  for (const palette of ['mesh', 'briefing', 'aurora', 'afterglow']) {
    it(`a stored palette "${palette}" paints "${palette}" itself`, async () => {
      const first = await firstFrame({ style: 'studio', palette, mode: 'dark', textScale: 'default' });
      expect(first).toMatchObject({ style: 'studio', palette, mode: 'dark' });
    });
  }
});

/**
 * Set `FY_THEME_AXES_SHOTS_DIR` to keep the Look group (style cards, the 8 palette chips, specimen) as
 * `<viewport>-<style>-<mode>.png`, drawn on the default palette each style brings. Fake data only.
 */
const shotsDir = process.env.FY_THEME_AXES_SHOTS_DIR ?? '';
describe.skipIf(shotsDir === '')('the Look group, shot per style on its own default palette', () => {
  for (const viewport of [
    { name: '1280', width: 1_280 },
    { name: '390', width: 390 },
  ]) {
    it(`${viewport.name}`, async () => {
      await mkdir(shotsDir, { recursive: true });
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: 3_200 },
        hasTouch: viewport.width < 600,
        isMobile: viewport.width < 600,
      });
      await context.route('**/*', async route =>
        new URL(route.request().url()).origin === origin() ? await route.continue() : await route.abort(),
      );
      try {
        const tab = await context.newPage();
        await tab.goto(`${origin()}/settings?seed=${encodeURIComponent(JSON.stringify(INDIGO_STUDIO))}`);
        await tab.waitForSelector('[data-specimen]');
        for (const style of ['studio', 'neo', 'genz']) {
          for (const mode of ['Light', 'Dark']) {
            await tab.locator(`[data-choice="${style}"]`).click();
            await tab.locator('[role="radiogroup"][aria-label="Colour mode"] label', { hasText: mode }).click();
            await tab.waitForTimeout(1_200);
            const png = await tab.locator('[data-setting-group="Look"]').screenshot();
            await Bun.write(join(shotsDir, `${viewport.name}-${style}-${mode.toLowerCase()}.png`), png);
          }
        }
      } finally {
        await context.close();
      }
    });
  }
});
