/**
 * THE GEN Z MAXIMALISM SPECIMEN (r10 T15) in a real browser: the same fake-data component scene the Neo specimen draws
 * (`fixtures/neo-specimen-scene.tsx`, which takes `?style=`), under style `genz` with several palettes and both modes at 1280
 * and 390 wide. The style is LOUD (`loud: true`), so contrast is the matrix's warning to report; this suite holds the style to
 * what stays hard for every style (a ring of at least 2px at 3:1 on every focusable control, text fields included, and no
 * horizontal overflow) and to the style's own signature (the stacked two-colour offset shadow, pill controls, the display face).
 *
 * Set `FY_GENZ_SPECIMEN_SHOTS_DIR` to keep `<width>-<palette>-<mode>.png` and the focused-field close-ups.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser } from 'playwright-core';
import { COLOUR_TOOLS, type ColourTools, sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_GENZ_SPECIMEN_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-genz-specimen-'));
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
  if (code !== 0) throw new Error(`the specimen scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      if (new URL(request.url).pathname === '/app.js')
        return new Response(js, { headers: { 'content-type': 'text/javascript' } });
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
const PALETTES = ['studio', 'neo', 'vaporwave'] as const;
const MODES = ['light', 'dark'] as const;

const open = async (width: (typeof WIDTHS)[number], palette: string, mode: string) => {
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
  await tab.goto(`${origin}/?style=genz&palette=${palette}&mode=${mode}`);
  await tab.waitForSelector('[data-specimen]');
  // The scene paints its own page surface (`bg-bg`) over the body; the app lets the colour field show through, so the specimen does too.
  await tab.addStyleTag({ content: '[data-specimen]{background:transparent !important}' });
  await tab.evaluate(async () => await document.fonts.ready);
  return { tab, problems, close: async () => await context.close() };
};

describe('the Gen Z maximalism specimen', () => {
  for (const width of WIDTHS)
    for (const palette of PALETTES)
      for (const mode of MODES) {
        const name = `${width.width}-${palette}-${mode}`;
        it(`${name}: draws without error or overflow, in the display face, with the stacked shadow and pill controls`, async () => {
          const { tab, problems, close } = await open(width, palette, mode);
          try {
            if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}.png`), fullPage: true });
            expect(problems).toEqual([]);
            const report = await tab.evaluate(() => {
              const doc = document.documentElement;
              const card = document.querySelector('.fy-cc__card');
              const button = document.querySelector('.kt-btn');
              return {
                overflow: doc.scrollWidth - doc.clientWidth,
                displayFace: getComputedStyle(doc).getPropertyValue('--font-display'),
                bagelLoaded: document.fonts.check('16px "Bagel Fat One"'),
                bricolageLoaded: document.fonts.check('16px "Bricolage Grotesque"'),
                cardShadow: card === null ? 'none' : getComputedStyle(card).boxShadow,
                buttonRadius: button === null ? '' : getComputedStyle(button).borderTopLeftRadius,
              };
            });
            expect(report.overflow).toBeLessThanOrEqual(0);
            expect(report.displayFace).toContain('Bagel Fat One');
            expect(report.bagelLoaded).toBe(true);
            expect(report.bricolageLoaded).toBe(true);
            // Two stacked offsets: a palette hue then ink, flat (no blur): two `Npx Npx 0` layers.
            expect(report.cardShadow.match(/\d+px \d+px 0px/gu)?.length).toBeGreaterThanOrEqual(2);
            expect(Number.parseFloat(report.buttonRadius)).toBeGreaterThanOrEqual(20);
          } finally {
            await close();
          }
        });
      }
});

/** A text field is the control the house rules most often hid the ring on; every focusable control draws >= 2px at >= 3:1. */
describe('the Gen Z maximalism specimen focus', () => {
  const FOCUSABLE = [
    '[data-part="btn-outline"]',
    '[data-part="btn-primary"]',
    '[data-part="input"]',
    '[role="switch"]',
    '.fy-cc__card:has(input:not(:checked))',
  ] as const;
  for (const palette of PALETTES)
    for (const mode of MODES)
      it(`${palette}-${mode}: every focusable control draws a ring of at least 2px at 3:1`, async () => {
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
              return {
                width: Math.max(width(own), width(outer)),
                contrast: ratio(rgba(drawn.outlineColor), backdrop((holder.parentElement ?? holder) as HTMLElement)),
              };
            });
            expect({ palette, mode, selector, ok: ring.width >= 2 }).toEqual({ palette, mode, selector, ok: true });
            expect({ selector, ok: ring.contrast >= 3, contrast: ring.contrast.toFixed(2) }).toEqual({
              selector,
              ok: true,
              contrast: ring.contrast.toFixed(2),
            });
            const box = await target.boundingBox();
            if (shotsDir !== '' && box !== null)
              await tab.screenshot({
                path: join(shotsDir, `focus-${palette}-${mode}-${index}.png`),
                clip: {
                  x: Math.max(0, box.x - 14),
                  y: Math.max(0, box.y - 14),
                  width: box.width + 32,
                  height: box.height + 32,
                },
              });
          }
        } finally {
          await close();
        }
      });
});
