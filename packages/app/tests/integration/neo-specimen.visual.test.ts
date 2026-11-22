/**
 * THE NEO-BRUTALISM SPECIMEN (r10 T13) in a real browser over fake data (`fixtures/neo-specimen-scene.tsx`): every component
 * family the app draws, under style `neo` with any palette and either mode, at 1280 and 390 wide. It holds the style to
 * what the owner's v4 favourite is (hard rules, no radius, flat offset shadows with no blur, a block that presses into its
 * shadow, a hard ring on focus) and to the two checks every style must pass: a focus ring and no horizontal overflow.
 *
 * Set `FY_NEO_SPECIMEN_SHOTS_DIR` to keep `<width>-<palette>-<mode>[-<state>].png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { COLOUR_TOOLS, type ColourTools, sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_NEO_SPECIMEN_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-neo-specimen-'));
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
  if (code !== 0) throw new Error(`the neo specimen scene did not build (${code}):\n${stderr}\n${stdout}`);
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
const PALETTES = ['neo', 'studio', 'hacker'] as const;
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
  await tab.goto(`${origin}/?style=neo&palette=${palette}&mode=${mode}${query}`);
  await tab.waitForSelector('[data-specimen]');
  await tab.evaluate(async () => await document.fonts.ready);
  return { tab, problems, close: async () => await context.close() };
};

const shot = async (tab: Page, name: string): Promise<void> => {
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}.png`), fullPage: true });
};

describe('the Neo-brutalism specimen', () => {
  for (const width of WIDTHS) {
    for (const palette of PALETTES) {
      for (const mode of MODES) {
        const name = `${width.width}-${palette}-${mode}`;
        it(`${name}: draws without error, without horizontal overflow, with no radius and no blurred shadow`, async () => {
          const { tab, problems, close } = await open(width, palette, mode);
          try {
            await shot(tab, name);
            expect(problems).toEqual([]);
            const report = await tab.evaluate(() => {
              const doc = document.documentElement;
              const rounded: string[] = [];
              const blurred: string[] = [];
              for (const element of document.querySelectorAll<HTMLElement>('[data-specimen] *')) {
                const style = getComputedStyle(element);
                const label = `${element.tagName.toLowerCase()}.${element.className}`.slice(0, 60);
                // A visually hidden 1px box (`sr-only`: a segmented control's radios) draws nothing, so its UA radio rounding is no corner.
                const box = element.getBoundingClientRect();
                if (style.borderTopLeftRadius !== '0px' && (box.width > 1 || box.height > 1))
                  rounded.push(`${label} ${style.borderTopLeftRadius}`);
                if (
                  style.boxShadow !== 'none' &&
                  /\d+px\s+\d+px\s+[1-9]\d*px/u.test(style.boxShadow.replace(/rgba?\([^)]*\)/gu, ''))
                )
                  blurred.push(`${label} ${style.boxShadow}`);
              }
              const card = document.querySelector('.fy-cc__card');
              return {
                overflow: doc.scrollWidth - doc.clientWidth,
                rounded,
                blurred,
                ink: ((): string => {
                  const probe = document.createElement('i');
                  probe.style.color = 'var(--shadow-ink)';
                  document.body.append(probe);
                  const value = getComputedStyle(probe).color;
                  probe.remove();
                  return value;
                })(),
                cardShadow: card === null ? 'none' : getComputedStyle(card).boxShadow,
              };
            });
            expect(report.overflow).toBeLessThanOrEqual(0);
            // The hard offset has an ink on EVERY palette (owner: every style takes every palette).
            expect(report.ink).not.toBe('rgba(0, 0, 0, 0)');
            expect(report.cardShadow).not.toBe('none');
            // The style's own promise, asserted (it used to be only logged): not one rounded corner and not one blurred
            // shadow on anything the specimen draws.
            expect({ name, rounded: report.rounded }).toEqual({ name, rounded: [] });
            expect({ name, blurred: report.blurred }).toEqual({ name, blurred: [] });
          } finally {
            await close();
          }
        });
      }
    }
  }
});

/**
 * Every control that takes focus draws a hard ring of at least 2px that is at least 3:1 against what is behind it (WCAG 1.4.11),
 * on SEVERAL palettes (not only Neo's own: every style takes every palette), and a press moves the block into its shadow.
 */
const FOCUS_PALETTES = ['neo', 'studio', 'hacker', 'contrast', 'geist', 'vintage'] as const;
describe('the Neo-brutalism specimen states', () => {
  const FOCUSABLE = [
    '[data-part="btn-outline"]',
    '[data-part="btn-primary"]',
    '[data-part="input"]',
    '[role="switch"]',
    '.fy-cc__card:has(input:not(:checked))',
    '[role="radiogroup"] label:has(input:not(:checked))',
  ] as const;
  for (const palette of FOCUS_PALETTES)
    for (const mode of MODES) {
      it(`${palette}-${mode}: a focused control draws a ring of at least 2px and 3:1; hover and press are shot`, async () => {
        const { tab, close } = await open(WIDTHS[0], palette, mode);
        try {
          await tab.evaluate(COLOUR_TOOLS);
          for (const [index, selector] of FOCUSABLE.entries()) {
            const target = tab.locator(selector).first();
            await target.scrollIntoViewIfNeeded();
            await tab.keyboard.press('Tab'); // makes the next focus a keyboard one
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
              const ringColour = rgba(drawn.outlineColor);
              // The ring is drawn OUTSIDE the holder, so what it must stand out from is what is behind the holder.
              const behind = backdrop((holder.parentElement ?? holder) as HTMLElement);
              return {
                tag: active.tagName,
                width: Math.max(width(own), width(outer)),
                contrast: ratio(ringColour, behind),
              };
            });
            expect({ palette, selector, tag: ring.tag, ok: ring.width >= 2 }).toEqual({
              palette,
              selector,
              tag: ring.tag,
              ok: true,
            });
            expect({
              palette,
              selector,
              ringContrastOk: ring.contrast >= 3,
              contrast: ring.contrast.toFixed(2),
            }).toEqual({
              palette,
              selector,
              ringContrastOk: true,
              contrast: ring.contrast.toFixed(2),
            });
            const box = await target.boundingBox();
            if (shotsDir !== '' && box !== null)
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
          await tab.mouse.move(0, 0);
          for (const [label, selector] of [
            ['btn', '[data-part="btn-outline"]'],
            ['prim', '[data-part="btn-primary"]'],
            ['card', '.fy-cc__card:has(input:not(:checked))'],
          ] as const) {
            const target = tab.locator(selector).first();
            await target.hover();
            const box = await target.boundingBox();
            if (shotsDir !== '' && box !== null)
              await tab.screenshot({
                path: join(shotsDir, `states-${palette}-${mode}-${label}-hover.png`),
                clip: {
                  x: Math.max(0, box.x - 12),
                  y: Math.max(0, box.y - 12),
                  width: box.width + 28,
                  height: box.height + 28,
                },
              });
            await tab.mouse.down();
            if (shotsDir !== '' && box !== null)
              await tab.screenshot({
                path: join(shotsDir, `states-${palette}-${mode}-${label}-press.png`),
                clip: {
                  x: Math.max(0, box.x - 12),
                  y: Math.max(0, box.y - 12),
                  width: box.width + 28,
                  height: box.height + 28,
                },
              });
            await tab.mouse.up();
            await tab.mouse.move(0, 0);
          }
        } finally {
          await close();
        }
      });
    }

  it('the menu opens as a hard block with an offset shadow', async () => {
    const { tab, close } = await open(WIDTHS[0], 'neo', 'light', '&menu=1');
    try {
      await tab.waitForSelector('[role="menu"]');
      await shot(tab, 'menu-neo-light');
    } finally {
      await close();
    }
  });
});
