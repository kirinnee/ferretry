/**
 * THE HUD / SCI-FI FUI SPECIMEN (r10 T10) in a real browser over fake data. It reuses the Neo specimen page
 * (`fixtures/neo-specimen-scene.tsx`, which takes `?style=<id>`) so the HUD is drawn on the REAL components, then holds
 * the style to what makes it a HUD (registration brackets on a panel, a scan-line veil, a glow instead of a drop
 * shadow) and to the two checks every style must pass: a visible focus ring and no horizontal overflow. Body text must
 * also stay readable (HUD is not a `loud` style), on several palettes: every style takes every palette.
 *
 * Set `FY_HUD_SPECIMEN_SHOTS_DIR` to keep `<width>-<palette>-<mode>[-<state>].png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { COLOUR_TOOLS, type ColourTools, sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_HUD_SPECIMEN_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-hud-specimen-'));
  const child = Bun.spawn(
    [
      process.execPath,
      sceneBuilder,
      '--out',
      directory,
      '--entry',
      resolve(packageRoot, 'fixtures/neo-specimen-scene.tsx'),
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the hud specimen scene did not build (${code}):\n${stderr}\n${stdout}`);
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

const WIDTHS = [
  { width: 1_280, height: 900, phone: false },
  { width: 390, height: 1_840, phone: true },
] as const;
const PALETTES = ['studio', 'mission', 'neo', 'phosphor', 'cyberpunk', 'broadsheet', 'contrast'] as const;
const SHOT_PALETTES = new Set<string>(['studio', 'cyberpunk', 'broadsheet']);
const MODES = ['light', 'dark'] as const;

const open = async (width: (typeof WIDTHS)[number], palette: string, mode: string, query = '') => {
  const context = await browser.newContext({
    viewport: { width: width.width, height: width.height },
    deviceScaleFactor: width.phone ? 2 : 1,
    hasTouch: width.phone,
    isMobile: width.phone,
    colorScheme: mode as 'light' | 'dark',
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  tab.setDefaultTimeout(8_000);
  const problems: string[] = [];
  tab.on('pageerror', error => problems.push(error.message));
  await tab.goto(`${origin}/?style=hud&palette=${palette}&mode=${mode}${query}`);
  await tab.waitForSelector('[data-specimen]');
  await tab.evaluate(async () => await document.fonts.ready);
  return { tab, problems, close: async () => await context.close() };
};

const shot = async (tab: Page, name: string): Promise<void> => {
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}.png`), fullPage: true });
};

describe('the HUD specimen', () => {
  for (const width of WIDTHS) {
    for (const palette of PALETTES) {
      for (const mode of MODES) {
        const name = `${width.width}-${palette}-${mode}`;
        it(`${name}: no overflow, panel brackets, scan-line veil, Orbitron labels, readable body text`, async () => {
          const { tab, problems, close } = await open(width, palette, mode);
          try {
            await tab.evaluate(COLOUR_TOOLS);
            if (SHOT_PALETTES.has(palette)) await shot(tab, name);
            expect(problems).toEqual([]);
            const report = await tab.evaluate(() => {
              const doc = document.documentElement;
              const panel = document.querySelector('.kt-panel') as HTMLElement;
              const label = document.querySelector('.kt-label') as HTMLElement;
              const { backdrop, ratio, rgba } = (window as unknown as { __colour: ColourTools }).__colour;
              const body = document.querySelector('[data-specimen] p, [data-specimen] .text-fg') as HTMLElement;
              const target = body ?? panel;
              return {
                overflow: doc.scrollWidth - doc.clientWidth,
                bracket: getComputedStyle(panel, '::before').borderTopStyle,
                veil: getComputedStyle(document.body, '::before').opacity,
                labelFont: getComputedStyle(label).fontFamily,
                bodyFont: getComputedStyle(target).fontFamily,
                bodyContrast: ratio(rgba(getComputedStyle(target).color), backdrop(target)),
                fontsLoaded: document.fonts.check('600 12px Orbitron'),
              };
            });
            expect(report.overflow).toBeLessThanOrEqual(0);
            expect(report.bracket).toBe('solid');
            expect(Number(report.veil)).toBeGreaterThan(0);
            expect(report.labelFont).toContain('Orbitron');
            expect(report.bodyFont).toContain('Public Sans');
            expect(report.fontsLoaded).toBe(true);
            expect({ name, ok: report.bodyContrast >= 4.5 }).toEqual({ name, ok: true });
          } finally {
            await close();
          }
        });
      }
    }
  }
});

/** Every control that takes focus draws a ring of at least 2px that is at least 3:1 against what is behind it (WCAG 1.4.11). */
describe('the HUD specimen states', () => {
  const FOCUSABLE = [
    '[data-part="btn-outline"]',
    '[data-part="btn-primary"]',
    '[data-part="input"]',
    '[role="switch"]',
    '.fy-cc__card:has(input:not(:checked))',
    '[role="radiogroup"] label:has(input:not(:checked))',
  ] as const;
  for (const palette of PALETTES)
    for (const mode of MODES) {
      it(`${palette}-${mode}: a focused control draws a ring of at least 2px and 3:1; hover and press are shot`, async () => {
        const { tab, close } = await open(WIDTHS[0], palette, mode);
        try {
          await tab.evaluate(COLOUR_TOOLS);
          for (const [index, selector] of FOCUSABLE.entries()) {
            const target = tab.locator(selector).first();
            await target.scrollIntoViewIfNeeded();
            await tab.keyboard.press('Tab');
            await target.evaluate(element => {
              const focusable = element.matches('input,button,select,textarea')
                ? element
                : element.querySelector('input');
              (focusable as HTMLElement).focus({ focusVisible: true } as FocusOptions);
            });
            const ring = await tab.evaluate(() => {
              const active = document.activeElement as HTMLElement;
              const holder = active.closest('.fy-cc__card, label') ?? active;
              const own = getComputedStyle(active);
              const outer = getComputedStyle(holder);
              const width = (style: CSSStyleDeclaration) =>
                style.outlineStyle === 'none' ? 0 : Number.parseFloat(style.outlineWidth);
              const drawn = width(outer) >= width(own) ? outer : own;
              const { backdrop, ratio, rgba } = (window as unknown as { __colour: ColourTools }).__colour;
              const behind = backdrop((holder.parentElement ?? holder) as HTMLElement);
              return {
                tag: active.tagName,
                width: Math.max(width(own), width(outer)),
                contrast: ratio(rgba(drawn.outlineColor), behind),
              };
            });
            expect({ palette, selector, tag: ring.tag, ok: ring.width >= 2 }).toEqual({
              palette,
              selector,
              tag: ring.tag,
              ok: true,
            });
            expect({ palette, selector, ok: ring.contrast >= 3, contrast: ring.contrast.toFixed(2) }).toEqual({
              palette,
              selector,
              ok: true,
              contrast: ring.contrast.toFixed(2),
            });
            const box = await target.boundingBox();
            if (shotsDir !== '' && SHOT_PALETTES.has(palette) && box !== null)
              await tab.screenshot({
                path: join(shotsDir, `states-${palette}-${mode}-${index}-focus.png`),
                clip: {
                  x: Math.max(0, box.x - 12),
                  y: Math.max(0, box.y - 12),
                  width: box.width + 28,
                  height: box.height + 28,
                },
              });
          }
        } finally {
          await close();
        }
      });
    }
});
