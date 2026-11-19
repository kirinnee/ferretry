/**
 * THE THEME MATRIX: every STYLE x every PALETTE x both MODES, measured in a real browser on one fixed specimen page
 * (`fixtures/theme-matrix-scene.tsx`). The catalogue is the list (`STYLES`, `PALETTES`), so a style or palette added to it
 * is measured with no edit here, and a new one that cannot be read is a red row the day it lands.
 *
 * Owner (2026-11-19): "every style takes every palette", and "its ok some style fights readability rules". So the checks
 * come in two strengths:
 *
 *  HARD for every style (a loud one too): a focus ring that is drawn, >= 2px, and >= 3:1 against what is behind the
 *  control; no horizontal overflow at 390; the faces the style names are loaded (not the device's fallback).
 *  CONTRAST: text >= 4.5:1 on the colour it sits on; a control's edge (or its fill) >= 3:1 against what is behind it.
 *    A miss is a FAILURE, except for a style the catalogue marks `loud: true` (`StyleEntry.loud`: it deliberately fights
 *    readability): there it is a WARNING row in the printed table and the run stays green.
 *
 * A miss that exists TODAY and is not this unit's to fix sits in `KNOWN` below, one row per (style, palette, mode, check);
 * a row that no longer misses FAILS (so the ledger shrinks as the palettes are fixed and never goes stale).
 *
 * Set `FY_THEME_MATRIX_REPORT=<file>` to write the table (markdown) and `FY_THEME_MATRIX_SHOTS_DIR=<dir>` to keep one
 * 2x screenshot per style/palette/mode at 1280 and 390.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { PALETTES, STYLES } from '../../src/theme/catalog.ts';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';
import { type Known, type Measured, type Miss, misses, staleKnown, verdictOf } from '../support/theme-matrix.ts';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_THEME_MATRIX_SHOTS_DIR ?? '';
const reportFile = process.env.FY_THEME_MATRIX_REPORT ?? '';

const MODES = ['light', 'dark'] as const;
const VIEWPORTS = [
  { name: '1280', width: 1_280, height: 900, phone: false },
  { name: '390', width: 390, height: 900, phone: true },
] as const;

/**
 * Misses that exist TODAY and are not this test's to fix (each is a palette value or a shared rule another unit owns, and the
 * theme-parity capture pins every token, so a palette cannot be nudged here). Each row says why; a row that no longer misses
 * fails the run (see `staleKnown`), so fixing the cause means deleting its row.
 */
const KNOWN: readonly Known[] = [
  {
    style: ['studio', 'mission', 'geist'],
    check: 'focus',
    what: /^Name \(border\)/u,
    why: ".kt-input sets outline: var(--outline-always) (none outside Contrast), which outranks the shell :focus-visible ring, so a text field's only focus mark is a 1px border-colour change",
  },
  {
    palette: ['ledger'],
    mode: 'dark',
    check: 'text',
    what: /^(ok|warn|err|Stop ferret)$/u,
    why: 'Ledger dark status inks on their tint are 4.15-4.31:1',
  },
  {
    palette: ['wayfinding'],
    mode: 'dark',
    check: 'text',
    what: /^accent$/u,
    why: 'Wayfinding dark accent badge text is 4.47:1',
  },
];
const usedKnown = new Set<number>();

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-theme-matrix-'));
  const child = Bun.spawn(
    [
      process.execPath,
      sceneBuilder,
      '--out',
      directory,
      '--entry',
      resolve(packageRoot, 'fixtures/theme-matrix-scene.tsx'),
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the matrix scene did not build (${code}):\n${stderr}\n${stdout}`);
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

/**
 * Runs in the page. For every `[data-spec]` element (and the menu) it reads the colour the text really is, composited over
 * every translucent layer behind it, through one canvas pixel (the page's own engine parses `color-mix`, `color()` and
 * alpha). A backdrop that is a gradient or an image is not read: such a surface is judged on the solid colour beneath it.
 */
const MEASURE = `(async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  const paint = (layers) => {
    g.clearRect(0, 0, 1, 1);
    g.fillStyle = '#fff';
    g.fillRect(0, 0, 1, 1);
    for (const layer of layers) { g.fillStyle = layer; g.fillRect(0, 0, 1, 1); }
    const d = g.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2]];
  };
  const lum = ([r, gg, b]) => {
    const f = (v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(gg) + 0.0722 * f(b);
  };
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  // The layers behind (and, with self, including) an element, outermost first.
  const behind = (el, self) => {
    const layers = [];
    for (let n = self ? el : el.parentElement; n; n = n.parentElement) layers.unshift(getComputedStyle(n).backgroundColor);
    return layers;
  };
  const name = (el) => (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 28);
  const out = { text: [], edge: [], focus: [], overflow: [], fonts: [] };

  const texts = [...document.querySelectorAll('[data-spec~="text"], [role="menuitem"]')];
  for (const el of texts) {
    const own = [...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim() !== '');
    if (!own && el.tagName !== 'BUTTON') continue;
    const under = paint(behind(el, true));
    const ink = paint([...behind(el, true), getComputedStyle(el).color]);
    out.text.push({ what: name(el), ratio: ratio(ink, under) });
  }

  const edges = [...document.querySelectorAll('[data-spec~="edge"], [role="menu"]')];
  for (const el of edges) {
    const cs = getComputedStyle(el);
    const around = paint(behind(el, false));
    const border = Number.parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none'
      ? ratio(paint([...behind(el, false), cs.borderTopColor]), around) : 0;
    const fill = ratio(paint(behind(el, true)), around);
    out.edge.push({ what: name(el) + ' edge', ratio: Math.max(border, fill) });
  }

  for (const el of document.querySelectorAll('[data-spec~="focus"]')) {
    const rest = getComputedStyle(el);
    const restBorder = rest.borderTopColor;
    el.focus({ focusVisible: true });
    const cs = getComputedStyle(el);
    // The indicator the reader sees: the outline when one is drawn, else a border that CHANGED colour on focus (a text field).
    const outline = cs.outlineStyle !== 'none' && Number.parseFloat(cs.outlineWidth) > 0;
    const border = !outline && cs.borderTopStyle !== 'none' && cs.borderTopColor !== restBorder;
    const colour = outline ? cs.outlineColor : cs.borderTopColor;
    out.focus.push({
      what: name(el) + (border ? ' (border)' : ''),
      drawn: outline || border,
      width: Number.parseFloat(outline ? cs.outlineWidth : cs.borderTopWidth) || 0,
      ratio: outline || border ? ratio(paint([...behind(el, false), colour]), paint(behind(el, false))) : 0,
    });
    el.blur();
  }

  const limit = window.innerWidth;
  const doc = document.documentElement;
  if (doc.scrollWidth > limit + 0.5) out.overflow.push({ what: 'the page scrolls sideways', right: doc.scrollWidth, limit });
  for (const el of document.querySelectorAll('[data-specimen] *')) {
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.right > limit + 0.5) out.overflow.push({ what: name(el), right: rect.right, limit });
  }

  // Every face OUR stylesheet declares that a stack on the page names must really load; a stack's device faces (system-ui,
  // Helvetica Neue, Arial …) are not ours to load.
  const families = new Set();
  for (const el of document.querySelectorAll('[data-specimen], [data-specimen] *'))
    for (const part of getComputedStyle(el).fontFamily.split(',')) families.add(part.trim().replace(/^["']|["']$/g, ''));
  const declared = new Set([...document.fonts].map((face) => face.family.replace(/^["']|["']$/g, '')));
  for (const family of families) {
    if (!declared.has(family)) continue;
    const loaded = await document.fonts.load('16px "' + family + '"');
    out.fonts.push({ family, loaded: loaded.length > 0 && loaded.every((face) => face.status === 'loaded') });
  }
  return out;
})()`;

const open = async (viewport: (typeof VIEWPORTS)[number], mode: 'light' | 'dark') => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: mode,
    deviceScaleFactor: 2,
    hasTouch: viewport.phone,
    isMobile: viewport.phone,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  await tab.goto(`${origin}/`);
  // A colour read mid-transition is neither the old theme nor the new one: measure the settled state.
  await tab.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });
  await tab.waitForSelector('[role="menu"] [role="menuitem"]');
  return { tab, close: async () => await context.close() };
};

const settle = async (tab: Page, style: string, palette: string, mode: string): Promise<Measured> => {
  await tab.evaluate(
    ([s, p, m]) => {
      const root = document.documentElement;
      root.setAttribute('data-style', s as string);
      root.setAttribute('data-palette', p as string);
      root.setAttribute('data-mode', m as string);
    },
    [style, palette, mode] as const,
  );
  return (await tab.evaluate(MEASURE)) as Measured;
};

interface Row {
  readonly viewport: string;
  readonly style: string;
  readonly palette: string;
  readonly mode: string;
  readonly miss: Miss;
}
const failures: Row[] = [];
const warnings: Row[] = [];
const known: Row[] = [];
let measuredCombos = 0;
const EXPECTED_COMBOS = VIEWPORTS.length * MODES.length * STYLES.length * PALETTES.length;

for (const viewport of VIEWPORTS)
  for (const mode of MODES)
    describe(`the theme matrix at ${viewport.name} in ${mode}`, () => {
      let session: Awaited<ReturnType<typeof open>>;
      beforeAll(async () => {
        session = await open(viewport, mode);
      }, 60_000);
      afterAll(async () => {
        await session.close();
      });

      for (const style of STYLES)
        for (const palette of PALETTES)
          it(`${style.id} x ${palette.id}`, async () => {
            const measured = await settle(session.tab, style.id, palette.id, mode);
            measuredCombos += 1;
            if (shotsDir !== '')
              await session.tab.screenshot({
                path: join(shotsDir, `${viewport.name}-${style.id}-${palette.id}-${mode}.png`),
                fullPage: true,
              });
            const where = { viewport: viewport.name, style: style.id, palette: palette.id, mode };
            const hard: Miss[] = [];
            for (const miss of misses(measured)) {
              const { verdict, known: index } = verdictOf(style.loud === true, where, miss, KNOWN);
              const row: Row = { ...where, miss };
              if (verdict === 'known') {
                usedKnown.add(index);
                known.push(row);
              } else if (verdict === 'warn') warnings.push(row);
              else {
                failures.push(row);
                hard.push(miss);
              }
            }
            expect(
              hard.map(miss => `${miss.check}: ${miss.what} ${miss.got} (need ${miss.need})`),
              `${style.id} x ${palette.id} ${mode} at ${viewport.name}`,
            ).toEqual([]);
          });
    });

describe('the known-misses ledger', () => {
  it('has no row that no longer misses (delete it when its cause is fixed)', () => {
    // A filtered run (-t) measures only some combinations, so a row can look unused; only a full run can say.
    if (measuredCombos < EXPECTED_COMBOS) return;
    expect(staleKnown(KNOWN, usedKnown).map(row => row.why)).toEqual([]);
  });
});

afterAll(async () => {
  const table = (rows: readonly Row[]): string =>
    rows.length === 0
      ? '(none)'
      : [
          '| width | style | palette | mode | check | what | got | need |',
          '| --- | --- | --- | --- | --- | --- | --- | --- |',
          ...rows.map(
            row =>
              `| ${row.viewport} | ${row.style} | ${row.palette} | ${row.mode} | ${row.miss.check} | ${row.miss.what} | ${row.miss.got} | ${row.miss.need} |`,
          ),
        ].join('\n');
  const text = `# Theme matrix\n\n${measuredCombos} of ${EXPECTED_COMBOS} combinations measured.\n\n## Failures\n\n${table(failures)}\n\n## Warnings (loud styles: contrast misses)\n\n${table(warnings)}\n\n## Known misses (ledger)\n\n${table(known)}\n`;
  if (reportFile !== '') await writeFile(reportFile, text, 'utf8');
  if (failures.length > 0 || warnings.length > 0) console.log(text);
});
