/**
 * END B5: A SWATCH HAS ONLY ITS OWN STYLE'S RULES (mixed page x swatch, Geist / HUD / Pixel / Briefing added to T8's set).
 *
 * A style's page rules (`:root[data-style='x'] ...`) must neither reach a swatch preview of ANOTHER style nor be missing from a
 * swatch of their own style. Every swatch style is read on its OWN page (the reference), then on a page of each of the others; the
 * two reads must match whole: the controls (computed paint), the panel's registration brackets (HUD), the spinner (Geist), and a
 * focused field's ring (Briefing's halo must not reach a Studio swatch).
 *
 * Measured on the theme matrix's specimen page, the same way the kit tests are.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(280_000);

const packageRoot = import.meta.dir;
const conversationScenes = resolve(packageRoot, '../../../plugins/conversation/tests/integration/app/fixtures');

const STYLES = ['studio', 'geist', 'hud', 'pixel', 'briefing', 'genz'] as const;
const MODES = ['light', 'dark'] as const;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-style-swatch-scope-'));
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
  if (code !== 0) throw new Error(`the specimen scene did not build (${code}):\n${stderr}\n${stdout}`);
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
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

/** One page wearing `style` (the Studio palette throughout), at 1280. */
const open = async (mode: 'light' | 'dark', style: string): Promise<{ tab: Page; close: () => Promise<void> }> => {
  const context = await browser.newContext({ viewport: { width: 1_280, height: 2_400 }, colorScheme: mode });
  const origin = server?.url.origin ?? '';
  const tab = await context.newPage();
  await tab.goto(`${origin}/`);
  await tab.waitForSelector('[role="menu"] [role="menuitem"]');
  await tab.evaluate(
    ([s, m]) => {
      const root = document.documentElement;
      root.setAttribute('data-style', s as string);
      root.setAttribute('data-palette', 'studio');
      root.setAttribute('data-mode', m as string);
    },
    [style, mode] as const,
  );
  await tab.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
  });
  await tab.waitForTimeout(600);
  return { tab, close: async () => await context.close() };
};

const SWATCH_CONTROLS = `
  <button class="kt-btn" data-probe="btn">Outline</button>
  <button class="kt-btn" data-variant="primary" data-probe="btn-primary">Primary</button>
  <input class="kt-input" data-probe="input">
  <section class="kt-panel" data-probe="panel"><header class="kt-panel__header" data-probe="panel-header"><span class="kt-label" data-probe="panel-label">Head</span></header><div class="kt-row" data-probe="row">Row</div></section>
  <div class="kt-tabbar" data-probe="tabbar"><button class="kt-tab" aria-selected="true" data-probe="tab">Tab</button><button class="kt-tab" aria-pressed="true" data-probe="chip">Chip</button></div>
  <span class="kt-badge" data-probe="badge">Badge</span>
  <div class="fy-cc__card" data-selected="true" data-probe="card-selected"><span class="fy-cc__check" data-probe="tick"></span><span class="fy-cc__line">line</span></div>
  <div data-neo-segmented data-probe="segmented"><label data-probe="seg-off"><input type="radio" name="seg"><span>One</span></label><label data-probe="seg-on"><input type="radio" name="seg" checked><span>Two</span></label></div>
  <button role="switch" aria-checked="true" data-probe="switch"><span data-neo-switch-track data-probe="switch-track"><span data-neo-switch-thumb data-probe="switch-thumb"></span></span></button>
  <div class="fy-sp-progress__bar"><span class="fy-sp-progress__segment" data-state="done" data-probe="seg-done"></span><span class="fy-sp-progress__segment" data-state="current" data-probe="seg-current"></span></div>
  <div data-option-bar-track data-probe="bar"></div>
  <svg class="fy-spinner" viewBox="0 0 16 16" data-probe="spinner"><g class="fy-spinner-ring"><circle class="fy-spinner-track" cx="8" cy="8" fill="none" r="6"/><circle class="fy-spinner-arc" cx="8" cy="8" fill="none" pathLength="100" r="6"/></g><rect class="fy-spinner__p1" height="6" width="6" x="1" y="1"/><rect class="fy-spinner__p2" height="6" width="6" x="9" y="1"/><rect class="fy-spinner__p3" height="6" width="6" x="1" y="9"/><rect class="fy-spinner__p4" height="6" width="6" x="9" y="9"/></svg>`;

type Read = Record<string, Record<string, string>>;

/** Mount a swatch of `style` on the page, focus its field by keyboard, and read the computed paint of every probe. */
const readSwatch = (tab: Page, style: string, mode: 'light' | 'dark'): Promise<Read> =>
  tab.evaluate(
    async ([markup, swatchStyle, swatchMode]) => {
      const holder = document.createElement('div');
      holder.setAttribute('data-swatch', '');
      holder.setAttribute('data-style', swatchStyle as string);
      holder.setAttribute('data-palette', 'studio');
      holder.setAttribute('data-mode', swatchMode as string);
      holder.style.cssText = 'background:var(--bg);color:var(--fg);font-family:var(--font-body)';
      holder.innerHTML = markup as string;
      document.body.append(holder);
      // `:focus-visible` follows the keyboard: a key press first, then focus the field.
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      (holder.querySelector('[data-probe="input"]') as HTMLElement).focus();
      await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
      const out: Read = {};
      const read = (name: string, node: Element, pseudo?: string): void => {
        const css = getComputedStyle(node, pseudo);
        // A running animation moves transform and opacity every frame: those two are read only where nothing animates (the name and delay are read for the rest).
        const moving = (node as Element).getAnimations().length > 0;
        out[name] = {
          background: css.backgroundColor,
          image: css.backgroundImage,
          shadow: css.boxShadow,
          radius: css.borderTopLeftRadius,
          border: `${css.borderTopStyle} ${css.borderTopWidth} ${css.borderTopColor}`,
          borderLeft: `${css.borderLeftStyle} ${css.borderLeftWidth} ${css.borderLeftColor}`,
          borderBottom: `${css.borderBottomStyle} ${css.borderBottomWidth} ${css.borderBottomColor}`,
          family: css.fontFamily,
          tracking: css.letterSpacing,
          content: css.content,
          colour: css.color,
          opacity: moving ? 'animated' : css.opacity,
          outline: `${css.outlineStyle} ${css.outlineWidth} ${css.outlineOffset}`,
          transitionProperty: css.transitionProperty,
          transform: moving ? 'animated' : css.transform,
          translate: css.translate,
          animationName: css.animationName,
          animationDelay: css.animationDelay,
          display: css.display,
          rx: css.rx,
          geometry: node instanceof SVGElement ? `${css.width}/${css.height}/${css.x}/${css.y}` : '',
          imageRendering: css.imageRendering,
        };
      };
      for (const node of Array.from(holder.querySelectorAll('[data-probe]'))) {
        const name = (node as HTMLElement).dataset.probe as string;
        read(name, node);
      }
      const panel = holder.querySelector('[data-probe="panel"]') as Element;
      read('panel::before', panel, '::before');
      read('panel::after', panel, '::after');
      for (const part of ['p1', 'p2', 'p3', 'p4']) read(part, holder.querySelector(`.fy-spinner__${part}`) as Element);
      read('ring', holder.querySelector('.fy-spinner-ring') as Element);
      read('arc', holder.querySelector('.fy-spinner-arc') as Element);
      holder.remove();
      return out;
    },
    [SWATCH_CONTROLS, style, mode] as const,
  );

const readOnPage = async (page: string, swatch: string, mode: 'light' | 'dark'): Promise<Read> => {
  const { tab, close } = await open(mode, page);
  try {
    return await readSwatch(tab, swatch, mode);
  } finally {
    await close();
  }
};

const drift = (want: Read, got: Read): string[] => {
  const out: string[] = [];
  for (const [probe, props] of Object.entries(want))
    for (const [prop, value] of Object.entries(props))
      if (got[probe]?.[prop] !== value) out.push(`${probe}.${prop}: own page ${value} | mixed ${got[probe]?.[prop]}`);
  return out;
};

describe('a swatch has only its own style’s computed style, on a page of any style (mixed page x swatch)', () => {
  for (const mode of MODES)
    it(`${mode}: every swatch style reads as it does on its own page, on a page of each of the others`, async () => {
      const own = new Map<string, Read>();
      for (const style of STYLES) own.set(style, await readOnPage(style, style, mode));
      const failures: string[] = [];
      for (const page of STYLES)
        for (const swatch of STYLES) {
          if (page === swatch) continue;
          const got = await readOnPage(page, swatch, mode);
          for (const line of drift(own.get(swatch) as Read, got))
            failures.push(`${swatch} swatch on ${page} page: ${line}`);
        }
      expect(failures).toEqual([]);
    });

  it('the references really differ by style (the comparison is not between blanks)', async () => {
    const studio = await readOnPage('studio', 'studio', 'light');
    const hud = await readOnPage('hud', 'hud', 'light');
    const pixel = await readOnPage('pixel', 'pixel', 'light');
    const geist = await readOnPage('geist', 'geist', 'light');
    const briefing = await readOnPage('briefing', 'briefing', 'light');
    // HUD: the panel's registration bracket is drawn on the HUD swatch alone (the swatch loses it without its own rule).
    expect(hud['panel::before']?.content).toBe('""');
    expect(studio['panel::before']?.content).not.toBe('""');
    // Pixel: a square switch track.
    expect(pixel['switch-track']?.border).not.toBe(studio['switch-track']?.border);
    // Geist: the spinner is four spokes (the second turned a quarter), not the studio mark.
    expect(geist.p2?.transform).not.toBe(studio.p2?.transform);
    // Briefing: a focused field carries its own halo.
    expect(briefing.input?.shadow).not.toBe(studio.input?.shadow);
  });
});

/** `FY_STYLE_SWATCH_SHOTS=<dir>` keeps one shot per page style: every swatch style side by side, as that page draws them. */
const shotsDir = process.env.FY_STYLE_SWATCH_SHOTS ?? '';
(shotsDir === '' ? describe.skip : describe)('shots: every swatch style on a page of one style', () => {
  for (const page of ['studio', 'hud', 'briefing'] as const)
    it(`${page} page`, async () => {
      await mkdir(shotsDir, { recursive: true });
      const { tab, close } = await open('light', page);
      try {
        await tab.evaluate(
          ([markup, styles]) => {
            const row = document.createElement('div');
            row.style.cssText =
              'position:fixed;inset:0;z-index:99;display:grid;grid-template-columns:repeat(5,1fr);gap:8px;padding:8px;background:var(--bg);overflow:auto';
            for (const style of styles as readonly string[]) {
              const holder = document.createElement('div');
              holder.setAttribute('data-swatch', '');
              holder.setAttribute('data-style', style);
              holder.setAttribute('data-palette', 'studio');
              holder.setAttribute('data-mode', 'light');
              holder.style.cssText = 'background:var(--bg);color:var(--fg);font-family:var(--font-body);padding:8px';
              holder.innerHTML = `<b>${style} swatch</b>${markup as string}`;
              row.append(holder);
            }
            document.body.append(row);
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
            (row.querySelector('[data-style="studio"] [data-probe="input"]') as HTMLElement).focus();
          },
          [SWATCH_CONTROLS, ['studio', 'geist', 'hud', 'pixel', 'briefing']] as const,
        );
        await tab.setViewportSize({ width: 1_280, height: 760 });
        await tab.waitForTimeout(400);
        await tab.screenshot({ path: join(shotsDir, `swatches-on-${page}-page.png`) });
      } finally {
        await close();
      }
    });
});
