/**
 * NO ACCENT SIDE BAR ON A SELECTED ITEM (r11 S2). The owner: "this side highlight thing is VERY LLM, please dont use it".
 *
 * The real Settings shell over the sweep scene (every plugin's real settings tab over one fake machine) is opened on the tabs that
 * drew a bar, and every element that marks "the one that is current / open / kept / lit / a tone" is measured in Chromium on COMPUTED
 * style, never on the source text:
 *  - SETTINGS NAV: the current tab (`.fy-tab--active`, `[aria-current=page]`);
 *  - ACCESS SETTINGS: every `.fy-acc-notice` (the tone moved to a small dot before the sentence);
 *  - LAYOUT PREVIEWS: the lit column of the density preview (`.fy-ls-col[data-lit]`);
 *  - CONVERSATION LINKS: an open (Continue) and a kept (import) row. The links screen is a route of the conversation plugin with no
 *    scene of its own, so its rows are drawn with the REAL markup classes (`fy-convo-item`, `data-open`, `data-selected`) under
 *    the real bundled `links.css`.
 * For each: no inset box-shadow bar (x offset >= 2px, no y, no blur), no left/inline-start border of 2px or more, nor a 1px one in an accent or tone colour, no `::before`/`::after` strip 2-6px wide filled with a colour. The current item still reads: its fill is not transparent
 * and, for the settings nav, its weight is at least 600.
 * Set `FY_NO_SIDE_BAR_SHOTS_DIR` to keep `<viewport>-<scheme>-<case>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(90_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_NO_SIDE_BAR_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-no-side-bar-'));
  const entry = join(directory, 'entry.tsx');
  await Bun.write(
    entry,
    `import { registerSettingsSweep } from ${JSON.stringify(resolve(packageRoot, 'fixtures/settings-sweep-register.ts'))};\nregisterSettingsSweep();\nawait import(${JSON.stringify(resolve(packageRoot, 'fixtures/settings-shell-scene.tsx'))});\n`,
  );
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
  if (code !== 0) throw new Error(`the scene did not build (${code}):\n${stderr}\n${stdout}`);
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
}, 300_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VARIANTS = [
  { name: '1280', width: 1_280, height: 900, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;
const SCHEMES = ['light', 'dark'] as const;
type Variant = (typeof VARIANTS)[number];

const open = async (variant: Variant, scheme: (typeof SCHEMES)[number], path: string, ready: string) => {
  const context = await browser.newContext({
    viewport: { width: variant.width, height: variant.height },
    deviceScaleFactor: variant.phone ? 2 : 1,
    hasTouch: variant.phone,
    isMobile: variant.phone,
    colorScheme: scheme,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', error => problems.push(error.message));
  await page.goto(`${origin}${path}?theme=studio-${scheme}`);
  try {
    await page.waitForSelector(ready, { timeout: 15_000 });
  } catch (error) {
    const seen = (
      await page
        .locator('body')
        .innerText()
        .catch(() => '')
    ).slice(0, 400);
    throw new Error(`the scene did not draw ${ready}: ${String(error)}\n${problems.join('\n')}\nON SCREEN: ${seen}`);
  }
  return { page, close: async () => await context.close() };
};

/** What marks the one current / open / kept / lit item, or carries a tone. */
const MARKED = '[aria-current], .fy-tab--active, [data-selected], [data-open], [data-lit], .fy-acc-notice';

interface Bar {
  readonly item: string;
  readonly kind: 'inset-shadow' | 'side-border' | 'strip';
  readonly detail: string;
}
interface Probe {
  readonly marked: number;
  readonly bars: readonly Bar[];
  readonly fills: readonly string[];
  readonly weights: readonly number[];
  readonly dots: readonly { readonly width: number; readonly height: number; readonly radius: string }[];
}

/** Measured in the page: every marked element's COMPUTED box-shadow, side borders and pseudo strips. */
const probe = async (page: Page, scope: string): Promise<Probe> =>
  await page.evaluate(
    ({ marked, scopeSelector }) => {
      // The accent and tone colours as the page resolves them (a border in one of them is a bar; a neutral one is a divider).
      const resolveColour = (token: string): string => {
        const el = document.createElement('i');
        el.style.color = `var(${token})`;
        document.body.append(el);
        const value = getComputedStyle(el).color;
        el.remove();
        return value;
      };
      const tones = ['--accent', '--warn', '--err', '--ok', '--tone'].map(resolveColour);
      const describe = (el: Element) =>
        `${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/).slice(0, 2).join('.')}`;
      const split = (value: string): string[] => {
        const parts: string[] = [];
        let depth = 0;
        let current = '';
        for (const char of value) {
          if (char === '(') depth += 1;
          if (char === ')') depth -= 1;
          if (char === ',' && depth === 0) {
            parts.push(current.trim());
            current = '';
          } else current += char;
        }
        if (current.trim() !== '') parts.push(current.trim());
        return parts;
      };
      const bars: { item: string; kind: 'inset-shadow' | 'side-border' | 'strip'; detail: string }[] = [];
      const fills: string[] = [];
      const weights: number[] = [];
      const dots: { width: number; height: number; radius: string }[] = [];
      const nodes = [...document.querySelectorAll<HTMLElement>(scopeSelector)]
        .flatMap(root => (root.matches(marked) ? [root] : []).concat([...root.querySelectorAll<HTMLElement>(marked)]))
        .filter((el, index, all) => all.indexOf(el) === index)
        .filter(el => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0);
      for (const el of nodes) {
        const style = getComputedStyle(el);
        for (const shadow of split(style.boxShadow === 'none' ? '' : style.boxShadow)) {
          if (!/\binset\b/.test(shadow)) continue;
          // `rgb(..) 3px 0px 0px 0px inset`: offsets x y blur spread.
          const numbers = [...shadow.replace(/rgba?\([^)]*\)/g, '').matchAll(/-?\d+(\.\d+)?px/g)].map(m =>
            parseFloat(m[0]),
          );
          const [x = 0, y = 0, blur = 0] = numbers;
          if (Math.abs(x) >= 2 && y === 0 && blur === 0)
            bars.push({ item: describe(el), kind: 'inset-shadow', detail: shadow });
        }
        for (const side of ['Left', 'InlineStart'] as const) {
          const width = parseFloat(style[`border${side}Width` as 'borderLeftWidth']);
          const colour = style[`border${side}Color` as 'borderLeftColor'];
          if (
            style[`border${side}Style` as 'borderLeftStyle'] !== 'none' &&
            (width >= 2 || (width >= 1 && tones.includes(colour)))
          )
            bars.push({ item: describe(el), kind: 'side-border', detail: `${width}px ${colour}` });
        }
        const height = el.getBoundingClientRect().height;
        for (const pseudo of ['::before', '::after'] as const) {
          const after = getComputedStyle(el, pseudo);
          if (after.content === 'none' || after.content === 'normal' || after.display === 'none') continue;
          const w = parseFloat(after.width);
          const h = parseFloat(after.height);
          const painted = after.backgroundColor !== 'rgba(0, 0, 0, 0)' && after.backgroundColor !== 'transparent';
          if (painted && w >= 2 && w <= 6 && h >= height * 0.5)
            bars.push({ item: describe(el), kind: 'strip', detail: `${pseudo} ${w}x${h}` });
          if (painted && pseudo === '::before') dots.push({ width: w, height: h, radius: after.borderRadius });
        }
        fills.push(style.backgroundColor);
        weights.push(parseInt(style.fontWeight, 10));
      }
      return { marked: nodes.length, bars, fills, weights, dots };
    },
    { marked: MARKED, scopeSelector: scope },
  );

const shot = async (page: Page, variant: Variant, scheme: string, name: string): Promise<void> => {
  if (shotsDir !== '') await page.screenshot({ path: join(shotsDir, `${variant.name}-${scheme}-${name}.png`) });
};

describe('no accent side bar on a selected item', () => {
  for (const variant of VARIANTS)
    for (const scheme of SCHEMES) {
      const where = `${variant.name} ${scheme}`;

      it(`the settings nav's current tab reads by fill and weight, not a bar (${where})`, async () => {
        const { page, close } = await open(
          variant,
          scheme,
          '/d/ws/settings/access/devices',
          '[data-add-device-surface]',
        );
        try {
          // A phone opens the list first; the desktop shows the nav beside the page.
          const nav = '.fy-settings-nav';
          if ((await page.locator(`${nav} .fy-tab--active, ${nav} [aria-current=page]`).count()) === 0)
            await page
              .waitForSelector(`${nav} .fy-tab--active, ${nav} [aria-current=page]`, { timeout: 10_000 })
              .catch(() => {});
          const measured = await probe(page, nav);
          await shot(page, variant, scheme, 'settings-nav');
          // A phone opens the list of tabs, where no tab is current yet; the desktop draws the nav beside the page.
          if (!variant.phone) expect(measured.marked).toBeGreaterThan(0);
          expect(measured.bars).toEqual([]);
          if (!variant.phone) expect(measured.fills.some(fill => fill !== 'rgba(0, 0, 0, 0)')).toBe(true);
          if (!variant.phone) expect(Math.max(...measured.weights)).toBeGreaterThanOrEqual(600);
        } finally {
          await close();
        }
      });

      it(`an Access notice carries its tone as a dot, not a bar (${where})`, async () => {
        const { page, close } = await open(
          variant,
          scheme,
          '/d/ws/settings/access/security',
          '[data-security-settings]',
        );
        try {
          expect(await page.locator('.fy-acc-notice').count()).toBeGreaterThan(0);
          const measured = await probe(page, '.fy-acc');
          await shot(page, variant, scheme, 'access-notice');
          expect(measured.marked).toBeGreaterThan(0);
          expect(measured.bars).toEqual([]);
          // A notice without an icon draws one 8px round dot before its sentence.
          for (const dot of measured.dots) {
            expect(dot.width).toBe(8);
            expect(dot.height).toBe(8);
          }
        } finally {
          await close();
        }
      });

      it(`the lit column of a layout preview is a fill, not a bar (${where})`, async () => {
        const { page, close } = await open(variant, scheme, '/d/ws/settings/layouts/layout', '.fy-ls-col');
        try {
          const measured = await probe(page, '.fy-ls-col');
          await shot(page, variant, scheme, 'layout-preview');
          expect(measured.marked).toBeGreaterThan(0);
          expect(measured.bars).toEqual([]);
          expect(measured.fills.some(fill => fill !== 'rgba(0, 0, 0, 0)')).toBe(true);
        } finally {
          await close();
        }
      });

      it(`an open or kept conversation row is a fill, not a bar (${where})`, async () => {
        const { page, close } = await open(
          variant,
          scheme,
          '/d/ws/settings/access/devices',
          '[data-add-device-surface]',
        );
        try {
          await page.evaluate(() => {
            const list = document.createElement('ul');
            list.id = 'convo-probe';
            list.style.cssText =
              'position:fixed;inset:16px auto auto 16px;width:320px;margin:0;padding:0;list-style:none;z-index:99;background:var(--surface)';
            list.innerHTML = [
              '<li class="fy-convo-item" data-open><div class="fy-convo-row"><span class="fy-convo-title">Fix the shop-cart page</span></div></li>',
              '<li class="fy-convo-item" data-selected><div class="fy-convo-row"><span class="fy-convo-title">Notes day</span></div></li>',
              '<li class="fy-convo-item"><div class="fy-convo-row"><span class="fy-convo-title">Plain row</span></div></li>',
            ].join('');
            document.body.append(list);
          });
          const measured = await probe(page, '#convo-probe');
          await shot(page, variant, scheme, 'conversation-links');
          expect(measured.marked).toBe(2);
          expect(measured.bars).toEqual([]);
          expect(measured.fills.every(fill => fill !== 'rgba(0, 0, 0, 0)')).toBe(true);
        } finally {
          await close();
        }
      });
    }
});
