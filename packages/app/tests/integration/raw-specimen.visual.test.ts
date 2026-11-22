/**
 * THE RAW BRUTALISM SPECIMEN (r10 T11) in a real browser: the same fake-data page the Neo specimen draws
 * (`fixtures/neo-specimen-scene.tsx`, which takes `?style=`), under style `raw` with EVERY palette and both modes, at 1280 and
 * 390 wide. It holds the style to what makes it Raw and not Neo: no radius, NO shadow of any kind (Neo casts a flat offset one),
 * the device's own faces (a serif body, a monospace label; nothing downloaded), links underlined at rest, no easing; and to the
 * two checks every style must pass: a focus ring of at least 2px at 3:1, and no horizontal overflow.
 *
 * Set `FY_RAW_SPECIMEN_SHOTS_DIR` to keep `<width>-<palette>-<mode>.png` (and a Neo twin, `neo-<palette>-<mode>.png`, to compare).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { PALETTE_IDS } from '../../src/theme/catalog.ts';
import { COLOUR_TOOLS, type ColourTools, sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_RAW_SPECIMEN_SHOTS_DIR ?? '';

/**
 * THE DEVICE'S OWN FACES, stood in for. Raw names Times New Roman and Courier New and ships neither; the build machine has no
 * fonts of its own, so a shot would show whatever the headless browser falls back to. Here a licensed look-alike answers to each
 * name (Gelasio for Times, JetBrains Mono for Courier: both OFL, both already bundled) so the shots show what a desktop shows.
 * The page under test is untouched: the stylesheet still names only system faces.
 */
const fontsDir = resolve(packageRoot, '../../src/assets/fonts');
const STAND_INS = [
  { family: 'Times New Roman', weight: '100 900', file: join(fontsDir, 'gelasio-latin-wght-normal.woff2') },
  { family: 'Courier New', weight: '400', file: join(fontsDir, 'jetbrains-mono-latin-400-normal.woff2') },
  { family: 'Courier New', weight: '700', file: join(fontsDir, 'jetbrains-mono-latin-700-normal.woff2') },
].map((entry, index) => ({ ...entry, url: `/stand-in-${index}.woff2` }));
const standInCss = STAND_INS.map(
  entry =>
    `@font-face{font-family:'${entry.family}';font-weight:${entry.weight};src:url(${entry.url}) format('woff2')}`,
).join('');

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-raw-specimen-'));
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
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${standInCss}${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      const face = STAND_INS.find(entry => entry.url === path);
      if (face !== undefined) return new Response(Bun.file(face.file), { headers: { 'content-type': 'font/woff2' } });
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

const DESKTOP = { width: 1_280, height: 900, phone: false } as const;
const PHONE = { width: 390, height: 1_840, phone: true } as const;
const MODES = ['light', 'dark'] as const;
/** Every palette is checked on the desktop page; the phone page (the overflow risk) on a spread of three. */
const PHONE_PALETTES = ['neo', 'studio', 'hacker'] as const;

const open = async (view: typeof DESKTOP | typeof PHONE, style: string, palette: string, mode: string) => {
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: view.phone ? 2 : 1,
    hasTouch: view.phone,
    isMobile: view.phone,
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
  await tab.goto(`${origin}/?style=${style}&palette=${palette}&mode=${mode}`);
  await tab.waitForSelector('[data-specimen]');
  await tab.evaluate(async () => await document.fonts.ready);
  return { tab, problems, close: async () => await context.close() };
};

const shot = async (tab: Page, name: string): Promise<void> => {
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}.png`), fullPage: true });
};

describe('the Raw Brutalism specimen', () => {
  const cases = [
    ...PALETTE_IDS.flatMap(palette => MODES.map(mode => ({ view: DESKTOP, palette, mode }))),
    ...PHONE_PALETTES.flatMap(palette => MODES.map(mode => ({ view: PHONE, palette, mode }))),
  ];
  for (const { view, palette, mode } of cases) {
    const name = `${view.width}-${palette}-${mode}`;
    it(`${name}: draws without error or overflow, with no radius, no shadow, and the device's own faces`, async () => {
      const { tab, problems, close } = await open(view, 'raw', palette, mode);
      try {
        await shot(tab, name);
        expect(problems).toEqual([]);
        const report = await tab.evaluate(() => {
          const doc = document.documentElement;
          const rounded: string[] = [];
          const shadowed: string[] = [];
          const eased: string[] = [];
          for (const element of document.querySelectorAll<HTMLElement>('[data-specimen] *')) {
            const style = getComputedStyle(element);
            const label = `${element.tagName.toLowerCase()}.${element.className}`.slice(0, 60);
            // Nothing is drawn for a box with no area, nor for a visually hidden 1px one (`sr-only`: the radios of a segmented
            // control). A native radio's own UA stylesheet rounds it (`50%` in newer Chromium), and no pixel of it shows.
            const box = element.getBoundingClientRect();
            if (box.width <= 1 && box.height <= 1) continue;
            // A status dot is a shape, never themed (`--radius-dot`): a circle that is also a small filled box is fine.
            if (style.borderTopLeftRadius !== '0px' && style.borderTopLeftRadius !== '9999px')
              rounded.push(`${label} ${style.borderTopLeftRadius}`);
            if (style.boxShadow !== 'none') shadowed.push(`${label} ${style.boxShadow}`);
            if (/[1-9]/u.test(style.transitionDuration.replace(/0s|0ms|[ ,.]/gu, '')))
              eased.push(`${label} ${style.transitionDuration}`);
          }
          const probe = document.querySelector('[data-part="btn-outline"]') as HTMLElement;
          const link = document.createElement('a');
          link.href = '#';
          link.textContent = 'link';
          document.body.append(link);
          const linkLine = getComputedStyle(link).textDecorationLine;
          link.remove();
          return {
            overflow: doc.scrollWidth - doc.clientWidth,
            rounded,
            shadowed,
            eased,
            body: getComputedStyle(document.body).fontFamily,
            button: getComputedStyle(probe).fontFamily,
            linkLine,
          };
        });
        expect(report.overflow).toBeLessThanOrEqual(0);
        expect({ name, rounded: report.rounded }).toEqual({ name, rounded: [] });
        expect({ name, shadowed: report.shadowed }).toEqual({ name, shadowed: [] });
        expect({ name, eased: report.eased }).toEqual({ name, eased: [] });
        // Nothing downloaded: a serif to read, a monospace to label.
        expect(report.body).toContain('Times');
        expect(report.button).toContain('Times');
        expect(report.linkLine).toBe('underline');
      } finally {
        await close();
      }
    });
  }

  it('is not Neo: same page, same palette, but a Neo card casts an offset shadow and Raw casts none', async () => {
    const raw = await open(DESKTOP, 'raw', 'neo', 'light');
    const neo = await open(DESKTOP, 'neo', 'neo', 'light');
    try {
      const read = (tab: Page) =>
        tab.evaluate(() => {
          const card = document.querySelector('.fy-cc__card') as HTMLElement;
          const style = getComputedStyle(card);
          return { shadow: style.boxShadow, family: getComputedStyle(document.body).fontFamily };
        });
      const [r, n] = [await read(raw.tab), await read(neo.tab)];
      await shot(neo.tab, 'neo-neo-light');
      expect(r.shadow).toBe('none');
      expect(n.shadow).not.toBe('none');
      expect(r.family).not.toBe(n.family);
    } finally {
      await raw.close();
      await neo.close();
    }
  });
});

/** Every control that takes focus draws a hard ring of at least 2px and 3:1 against what is behind it, on several palettes. */
const FOCUS_PALETTES = ['neo', 'studio', 'hacker', 'contrast', 'geist', 'vintage', 'vaporwave'] as const;
describe('the Raw Brutalism specimen focus', () => {
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
      it(`${palette}-${mode}: a focused control draws a ring of at least 2px and 3:1`, async () => {
        const { tab, close } = await open(DESKTOP, 'raw', palette, mode);
        try {
          await tab.evaluate(COLOUR_TOOLS);
          for (const selector of FOCUSABLE) {
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
              const behind = backdrop((holder.parentElement ?? holder) as HTMLElement);
              return {
                width: Math.max(width(own), width(outer)),
                contrast: ratio(rgba(drawn.outlineColor), behind),
              };
            });
            expect({ palette, mode, selector, wide: ring.width >= 2 }).toEqual({ palette, mode, selector, wide: true });
            expect({ palette, mode, selector, seen: ring.contrast >= 3, contrast: ring.contrast.toFixed(2) }).toEqual({
              palette,
              mode,
              selector,
              seen: true,
              contrast: ring.contrast.toFixed(2),
            });
          }
        } finally {
          await close();
        }
      });
    }
});
