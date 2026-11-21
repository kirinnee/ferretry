/**
 * THE THEME MATRIX: every STYLE x every PALETTE x both MODES x two WIDTHS (16 x 8 x 2 x 2 = 512 combinations today), measured
 * in a real browser on one fixed specimen page (`plugins/conversation/tests/integration/app/fixtures/theme-matrix-scene.tsx`). The catalogue is the list (`STYLES`,
 * `PALETTES`), so a style or palette added to it is measured with no edit here, and a new one that cannot be read is a red
 * row the day it lands.
 *
 * Owner (2026-11-19): "every style takes every palette", and "its ok some style fights readability rules". So the checks
 * come in two strengths:
 *
 *  HARD for every style (a loud one too): a focus ring that is drawn, >= 2px, and >= 3:1 against what is behind the
 *  control; no horizontal overflow at 390; every face the text names is declared and loaded at the weight it is drawn in.
 *  CONTRAST: text >= 4.5:1 (>= 3:1 only for WCAG large text) against the PAINTED backdrop, read pixel by pixel from a
 *  screenshot with the text hidden (so a gradient or an image is what it really is, not a solid token); a control's edge
 *  (or its fill) >= 3:1 against what is behind it. A miss is a FAILURE, except for a style the catalogue marks
 *  `loud: true` (`StyleEntry.loud`: it deliberately fights readability): there it is a WARNING row in the printed table.
 *
 * FOCUS is the real thing: the page is walked with the keyboard (Tab through every control, the arrow keys through the choice
 * row and the menu), and each focused control is read against its own resting state. An outline that is drawn anyway (the
 * Contrast style's always-on outline) is not a focus indicator; only what CHANGES on focus is. The choice card is read through
 * its visible proxy (the radio itself is `sr-only`), and every menu row is read in turn.
 *
 * A miss that exists TODAY and is not this unit's to fix is PINNED in `KNOWN` below by its exact identity (width, style,
 * palette, mode, check, what), with no wildcard. The observed miss set is compared with the pinned set both ways: a miss
 * nobody pinned fails, and a pin whose miss is gone fails.
 *
 * r11 T14 turns the owner's theme line (turn 4247, item 12) into asserts, on the same page and the same 512 combinations:
 *  1. the High contrast palette is HARD on every style, loud included (text 7:1 body / 4.5:1 muted, edges and rings 3:1);
 *  2. no gradient background on the page, panels, cards, buttons, fields or menus (Retro's title bar and Glass's frost are the
 *     two allowed; the body's first layer is the texture pattern, not a wash);
 *  3. a textarea, code block, table or menu has a corner radius <= 16px, and a two-line textarea does not clip its text;
 *  4. display text <= 3.25rem at 1280, body text 0.75-1.15rem (the product's dense body is 13.5px = 0.84rem);
 *  5. each style differs from Studio on >= 6 of 8 component probes, and no two styles share a spinner;
 *  6. a selected item draws no accent side bar (border, inset shadow or pseudo-element);
 *  7. a focus ring lies inside every clipping ancestor (r11 S13's measure; the specimen has a tight scroll box).
 * A style unit (r11 T5-T12) deletes the `KNOWN` rows of its styles as it fixes them; the ledger test fails on a stale pin.
 *
 * Set `FY_THEME_MATRIX_REDUCED_TRANSPARENCY=1` to emulate `prefers-reduced-transparency: reduce` for the whole run.
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
import {
  contractMisses,
  contrastRatio,
  type Known,
  luminance,
  type Measured,
  type Miss,
  misses,
  type Facts,
  pinnedMisses,
  type Signature,
  stalePins,
  verdictOf,
} from '../support/theme-matrix.ts';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
/** The specimen page's browser entry lives in Conversation's tests: it mounts Conversation's real renderer through that plugin's own half. */
const conversationScenes = resolve(packageRoot, '../../../plugins/conversation/tests/integration/app/fixtures');
const shotsDir = process.env.FY_THEME_MATRIX_SHOTS_DIR ?? '';
const reportFile = process.env.FY_THEME_MATRIX_REPORT ?? '';
/** Set to `1` to run the whole matrix with the OS "reduce transparency" setting emulated (every surface must stay readable opaque). */
const reducedTransparency = process.env.FY_THEME_MATRIX_REDUCED_TRANSPARENCY === '1';

const MODES = ['light', 'dark'] as const;
const VIEWPORTS = [
  { name: '1280', width: 1_280, height: 2_400, phone: false },
  { name: '390', width: 390, height: 2_400, phone: true },
] as const;

/**
 * Faces a stack may name that are the DEVICE's, not ours: nothing to declare or load. Every other family a text stack names
 * must have an `@font-face` in `styles/theme-fonts.css` and must load at the weight the page draws it in.
 */
const DEVICE_FACES: readonly string[] = [
  // Installed-font aliases that sit AFTER our bundled face in a stack (`'Geist', 'Geist Sans'`, `'Inter var', Inter`): a device may answer to them, none is ours to ship.
  'Inter var',
  'Geist Sans',
  'Aptos',
  'Aptos Display',
  'Segoe UI',
  'Roboto',
  'Helvetica Neue',
  'Helvetica',
  'Arial',
  'Arial Black',
  'Liberation Sans',
  'Impact',
  'Courier New',
  'Cascadia Code',
  'SFMono-Regular',
  'SF Mono',
  'Menlo',
  'Consolas',
  'Liberation Mono',
  'Tahoma',
  'Trebuchet MS',
  'Verdana',
  'Lucida Console',
  // Lucid names the Lucida family first so an installed copy wins; the system UI face answers everywhere else.
  'Lucida Grande',
  'Lucida Sans Unicode',
  'Lucida Sans',
  // Raw Brutalism draws with the device's own serif and monospace on purpose (r10 T11).
  'Courier',
  'Times',
  'Times New Roman',
  'Liberation Serif',
];

/**
 * Misses that exist TODAY and are not this test's to fix. r11 T14 (written BEFORE the style units T5-T12) pins every
 * (style, probe) pair that fails on the base: each style unit DELETES the rows of its own styles as it fixes them, and the
 * ledger test below fails on a pin whose miss is gone, so the list can only shrink. When the last row is gone the owner's
 * theme line (turn 4247, item 12) holds on every style. A row is the cross product of the lists it names, every list
 * explicit (never `PALETTES.map(...)`: a palette added to the catalogue is in no pin until somebody reads what it misses),
 * and says why; the identity of a miss is (width, style, palette, mode, check, what).
 *
 * The rows are by CHECK: gradient (probe 2), radius (3), size (4), distinct and spinner (5, measured on the style's own
 * default palette, at both widths in both modes, with the real motion), sidebar (6), ringclip (7), and text on the High
 * contrast palette (probe 1).
 */
const WHY = {
  gradient:
    "a gradient background (owner: 'most of them should not have gradient background'); the style unit (r11 T5-T12) removes it",
  radius:
    'a radius over 16px on a field, code block, table or menu (owner: the super-rounded ones are broken); the style unit caps it',
  size: 'display text over 3.25rem at 1280 (owner: Exaggerated Minimalism is too large); the style unit caps it',
  sidebar:
    "an accent side bar on the selected item (owner: 'this side highlight thing is VERY LLM'); r11 S2 removes the shell/nav ones, the style unit the style ones",
  ringclip:
    'a focus ring drawn outside its control is cut by a clipping ancestor; r11 S13 drew it inside everywhere but here; the style unit (r11 T11 briefing, T12 genz) draws it inside',
  spinner: 'this style shares a spinner with another; the style unit (r11 T5-T12) gives it its own',
  distinct:
    'this style differs from Studio on fewer than 6 of 8 components; the style unit (r11 T5-T12) designs the rest',
  hypermedia:
    'this style differs from Studio on 5 of 8 components, short only on hypermedia: no renderer reads an --hm-* slot until r12 H5 (C6), so the style unit cannot fix it; r12 H5 deletes the row',
  primaryRing:
    "the style's own :focus-visible rule on the Primary button removes the --surface band r11 S13 draws under the inside ring, so the ring is accent on accent (1.00:1); the style unit (r11 T11) keeps the band",
  text: 'the High contrast palette must pass 7:1 body text hard on this style (no loud exemption); the style unit fixes it',
} as const;

const BOTH_WIDTHS = ['1280', '390'] as const;
const BOTH_MODES = ['light', 'dark'] as const;
/** Explicit, never `PALETTES.map(...)`: a palette added to the catalogue is in no pin until somebody reads what it misses. */
const EVERY_PALETTE = ['studio', 'geist', 'mission', 'neo', 'hacker', 'vintage', 'vaporwave', 'contrast'] as const;

const KNOWN: readonly Known[] = [
  {
    viewports: BOTH_WIDTHS,
    styles: ['lucid'],
    palettes: EVERY_PALETTE,
    modes: ['light'],
    check: 'gradient',
    what: 'Badge background',
    why: WHY.gradient,
  },
  {
    viewports: BOTH_WIDTHS,
    styles: ['lucid', 'neumorphism'],
    palettes: EVERY_PALETTE,
    modes: BOTH_MODES,
    check: 'gradient',
    what: 'Button background',
    why: WHY.gradient,
  },
  {
    viewports: BOTH_WIDTHS,
    styles: ['antiposh', 'genz', 'lucid', 'neumorphism'],
    palettes: EVERY_PALETTE,
    modes: BOTH_MODES,
    check: 'gradient',
    what: 'Card background',
    why: WHY.gradient,
  },
  {
    viewports: BOTH_WIDTHS,
    styles: ['antiposh', 'lucid', 'neumorphism'],
    palettes: EVERY_PALETTE,
    modes: BOTH_MODES,
    check: 'gradient',
    what: 'Choice card background',
    why: WHY.gradient,
  },
  {
    viewports: BOTH_WIDTHS,
    styles: ['lucid', 'neumorphism'],
    palettes: EVERY_PALETTE,
    modes: BOTH_MODES,
    check: 'gradient',
    what: 'Field background',
    why: WHY.gradient,
  },
  {
    viewports: BOTH_WIDTHS,
    styles: ['genz', 'glass', 'lucid'],
    palettes: EVERY_PALETTE,
    modes: BOTH_MODES,
    check: 'gradient',
    what: 'Page background',
    why: WHY.gradient,
  },
  {
    viewports: BOTH_WIDTHS,
    styles: ['lucid'],
    palettes: EVERY_PALETTE,
    modes: BOTH_MODES,
    check: 'gradient',
    what: 'Panel header background',
    why: WHY.gradient,
  },
  {
    viewports: BOTH_WIDTHS,
    styles: ['genz', 'neumorphism'],
    palettes: EVERY_PALETTE,
    modes: BOTH_MODES,
    check: 'radius',
    what: 'Code block radius',
    why: WHY.radius,
  },
  {
    viewports: BOTH_WIDTHS,
    styles: ['genz', 'neumorphism'],
    palettes: EVERY_PALETTE,
    modes: BOTH_MODES,
    check: 'radius',
    what: 'Menu radius',
    why: WHY.radius,
  },
  {
    viewports: BOTH_WIDTHS,
    styles: ['briefing', 'neumorphism'],
    palettes: EVERY_PALETTE,
    modes: BOTH_MODES,
    check: 'radius',
    what: 'Textarea radius',
    why: WHY.radius,
  },
  {
    viewports: BOTH_WIDTHS,
    styles: ['briefing', 'genz'],
    palettes: EVERY_PALETTE,
    modes: BOTH_MODES,
    check: 'ringclip',
    what: 'Clipped button ring',
    why: WHY.ringclip,
  },
  {
    viewports: BOTH_WIDTHS,
    styles: ['briefing'],
    palettes: EVERY_PALETTE,
    modes: BOTH_MODES,
    check: 'sidebar',
    what: 'Selected choice card',
    why: WHY.sidebar,
  },
  {
    viewports: ['1280'],
    styles: ['exaggerated'],
    palettes: EVERY_PALETTE,
    modes: BOTH_MODES,
    check: 'size',
    what: 'display heading',
    why: WHY.size,
  },
  {
    viewports: BOTH_WIDTHS,
    styles: ['antiposh'],
    palettes: ['vintage'],
    modes: BOTH_MODES,
    check: 'spinner',
    what: 'spinner shared with another style',
    why: WHY.spinner,
  },
  {
    viewports: BOTH_WIDTHS,
    styles: ['briefing', 'swiss'],
    palettes: ['geist'],
    modes: BOTH_MODES,
    check: 'spinner',
    what: 'spinner shared with another style',
    why: WHY.spinner,
  },
  {
    viewports: BOTH_WIDTHS,
    styles: ['exaggerated', 'glass', 'lucid', 'neumorphism', 'studio'],
    palettes: ['studio'],
    modes: BOTH_MODES,
    check: 'spinner',
    what: 'spinner shared with another style',
    why: WHY.spinner,
  },
  {
    viewports: BOTH_WIDTHS,
    styles: ['genz'],
    palettes: ['vaporwave'],
    modes: BOTH_MODES,
    check: 'spinner',
    what: 'spinner shared with another style',
    why: WHY.spinner,
  },
  {
    viewports: BOTH_WIDTHS,
    styles: ['neumorphism'],
    palettes: ['contrast'],
    modes: ['light'],
    check: 'text',
    what: 'Danger',
    why: WHY.text,
  },
  {
    viewports: BOTH_WIDTHS,
    styles: ['neumorphism'],
    palettes: ['contrast'],
    modes: ['light'],
    check: 'text',
    what: 'Stop ferret',
    why: WHY.text,
  },
  {
    viewports: BOTH_WIDTHS,
    styles: ['antiposh'],
    palettes: ['contrast'],
    modes: BOTH_MODES,
    check: 'text',
    what: 'The menu beside your work',
    why: WHY.text,
  },
  // The hypermedia component: no renderer reads an `--hm-*` slot yet (r12 H5 owns that, per C6), so every style draws the
  // picture the same and these four reach 5 of 8 (the shared --radius-sm on .fy-render-pan no longer counts). r12 H5 deletes them.
  {
    viewports: BOTH_WIDTHS,
    styles: ['antiposh'],
    palettes: ['vintage'],
    modes: BOTH_MODES,
    check: 'distinct',
    what: 'differs from Studio on fewer than 6 of 8 components',
    why: WHY.hypermedia,
  },
  {
    viewports: BOTH_WIDTHS,
    styles: ['briefing', 'swiss'],
    palettes: ['geist'],
    modes: BOTH_MODES,
    check: 'distinct',
    what: 'differs from Studio on fewer than 6 of 8 components',
    why: WHY.hypermedia,
  },
  {
    viewports: BOTH_WIDTHS,
    styles: ['exaggerated'],
    palettes: ['studio'],
    modes: BOTH_MODES,
    check: 'distinct',
    what: 'differs from Studio on fewer than 6 of 8 components',
    why: WHY.hypermedia,
  },
  {
    viewports: BOTH_WIDTHS,
    styles: ['briefing', 'lucid'],
    palettes: EVERY_PALETTE,
    modes: BOTH_MODES,
    check: 'focus',
    what: 'Primary ring colour',
    why: WHY.primaryRing,
  },
];

const pins = pinnedMisses(KNOWN);
const usedPins = new Set<string>();

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
      resolve(conversationScenes, 'theme-matrix-scene.tsx'),
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
 * Page-side helpers, installed once per page as `window.__m`. The luminance and ratio are the SAME functions the unit
 * tests cover (`tests/support/theme-matrix.ts`), stringified, so there is one copy of the maths.
 */
const HELPERS = `(() => {
  const luminance = ${luminance.toString()};
  const contrastRatio = ${contrastRatio.toString()};
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
  const rgba = (colour) => {
    g.clearRect(0, 0, 1, 1);
    g.fillStyle = colour;
    g.fillRect(0, 0, 1, 1);
    const d = g.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  };
  const ratio = (a, b) => contrastRatio(luminance(a[0], a[1], a[2]), luminance(b[0], b[1], b[2]));
  // The layers behind (and, with self, including) an element, outermost first.
  const behind = (el, self) => {
    const layers = [];
    for (let n = self ? el : el.parentElement; n; n = n.parentElement) layers.unshift(getComputedStyle(n).backgroundColor);
    return layers;
  };
  const name = (el) => {
    if (el.matches('.fy-cc__card')) return 'Choice ' + el.getAttribute('data-choice');
    if (el.matches('input[type="radio"]')) return 'Choice ' + el.value;
    if (el.matches('.kt-panel')) return 'Card';
    return (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 28);
  };
  // A focus indicator lives on the control, except a radio: the native input is sr-only and its card is what the reader sees.
  const indicatorOf = (el) => (el.matches('input[type="radio"]') ? el.closest('label') : el);
  // Splits a computed list ("a(b, c), d") on its top-level commas.
  const splitTop = (value) => {
    const out = [];
    let depth = 0, start = 0;
    for (let i = 0; i < value.length; i += 1) {
      const c = value[i];
      if (c === '(') depth += 1;
      else if (c === ')') depth -= 1;
      else if (c === ',' && depth === 0) { out.push(value.slice(start, i).trim()); start = i + 1; }
    }
    out.push(value.slice(start).trim());
    return out.filter((part) => part !== '');
  };
  window.__m = { paint, rgba, ratio, behind, name, indicatorOf, splitTop };
})()`;

/** The elements whose focus ring is read: the tagged ones, the choice cards (through their radios) and every menu row. */
const FOCUS_SELECTOR = '[data-spec~="focus"], .fy-cc__card, [role="menuitem"], [role="menuitemcheckbox"]';

/**
 * Step 1, in the page: blur, remember every focus candidate's RESTING style, and list every text run with the colour it is
 * drawn in. The runs are read per text node (so a menu row's detail, a card's line and a badge each count), and an input's
 * value is a run of its own.
 */
const PREPARE = `(() => {
  const { name } = window.__m;
  document.activeElement?.blur?.();
  const rest = new Map();
  const keys = ['outlineStyle', 'outlineWidth', 'outlineColor', 'outlineOffset', 'borderTopStyle', 'borderTopColor', 'borderTopWidth', 'boxShadow'];
  const candidates = [...document.querySelectorAll(${JSON.stringify(FOCUS_SELECTOR)})];
  for (const el of candidates) {
    const cs = getComputedStyle(el);
    rest.set(el, Object.fromEntries(keys.map((k) => [k, cs[k]])));
  }
  window.__rest = rest;
  const wanted = candidates.map((el) => name(el)).sort();

  const runs = [];
  const roots = [...document.querySelectorAll('[data-spec~="text"], [role="menuitem"], [role="menuitemcheckbox"], .fy-cc__title, .fy-cc__line')];
  const seen = new Set();
  const describe = (el, what, text, rects) => {
    const cs = getComputedStyle(el);
    return { what, text, rects, muted: el.closest('.text-muted') !== null, ink: cs.color, px: Number.parseFloat(cs.fontSize), weight: Number.parseInt(cs.fontWeight, 10) || 400, style: cs.fontStyle, family: cs.fontFamily };
  };
  for (const root of roots) {
    if (root.tagName === 'INPUT') {
      if (root.value === '') continue;
      const cs = getComputedStyle(root);
      const r = root.getBoundingClientRect();
      const left = Number.parseFloat(cs.borderLeftWidth) + Number.parseFloat(cs.paddingLeft);
      const right = Number.parseFloat(cs.borderRightWidth) + Number.parseFloat(cs.paddingRight);
      const top = Number.parseFloat(cs.borderTopWidth) + Number.parseFloat(cs.paddingTop);
      const bottom = Number.parseFloat(cs.borderBottomWidth) + Number.parseFloat(cs.paddingBottom);
      runs.push(describe(root, name(root) + ' value', root.value, [{ x: r.left + left, y: r.top + top, w: r.width - left - right, h: r.height - top - bottom }]));
      continue;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent.trim();
      if (text === '' || seen.has(node)) continue;
      seen.add(node);
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0).map((r) => ({ x: r.left, y: r.top, w: r.width, h: r.height }));
      runs.push(describe(node.parentElement, text.slice(0, 28), text, rects));
    }
  }
  return { runs, wanted };
})()`;

/** Hides the glyphs (not the layout, the colour or the decorations that read currentColor) so a screenshot is the backdrop. */
const HIDE_TEXT = `[data-specimen], [data-specimen] * {
  -webkit-text-fill-color: transparent !important; text-shadow: none !important; text-decoration: none !important;
}`;

/** Step 2, in the page: the worst contrast of every text run over the pixels actually painted behind it. */
const BACKDROP = `(async ({ png, runs }) => {
  const { rgba, ratio } = window.__m;
  const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.drawImage(bitmap, 0, 0);
  const out = [];
  for (const run of runs) {
    const [ir, ig, ib, ia] = rgba(run.ink);
    let worst = Number.POSITIVE_INFINITY;
    for (const r of run.rects) {
      const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y));
      const x1 = Math.min(bitmap.width, Math.ceil(r.x + r.w)), y1 = Math.min(bitmap.height, Math.ceil(r.y + r.h));
      if (x1 <= x0 || y1 <= y0) continue;
      const d = g.getImageData(x0, y0, x1 - x0, y1 - y0).data;
      for (let i = 0; i < d.length; i += 4) {
        const back = [d[i], d[i + 1], d[i + 2]];
        const ink = [ir * ia + back[0] * (1 - ia), ig * ia + back[1] * (1 - ia), ib * ia + back[2] * (1 - ia)];
        const value = ratio(ink, back);
        if (value < worst) worst = value;
      }
    }
    if (worst !== Number.POSITIVE_INFINITY) out.push({ what: run.what, ratio: worst, px: run.px, weight: run.weight, muted: run.muted });
  }
  return out;
})`;

/** Step 3, in the page: edges, overflow, and the faces the text names (declared, and loaded at the weight drawn). */
const STATIC = `(async ({ runs, device }) => {
  const { paint, ratio, behind, name } = window.__m;
  const out = { edge: [], overflow: [], fonts: [] };

  // A raised Card has no edge of its own in every style (most draw a faint rule and rely on a darker fill), so its edge is a
  // hard check only where the style promises one: Neumorphism cuts cards from the page's own ground and gives them an edge.
  const cardEdge = document.documentElement.getAttribute('data-style') === 'neumorphism' ? ', [data-spec~="panel-edge"]' : '';
  for (const el of document.querySelectorAll('[data-spec~="edge"], [role="menu"], .fy-cc__card' + cardEdge)) {
    const cs = getComputedStyle(el);
    const around = paint(behind(el, false));
    const border = Number.parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none'
      ? ratio(paint([...behind(el, false), cs.borderTopColor]), around) : 0;
    const fill = ratio(paint(behind(el, true)), around);
    out.edge.push({ what: name(el) + ' edge', ratio: Math.max(border, fill) });
  }

  const limit = window.innerWidth;
  const doc = document.documentElement;
  if (doc.scrollWidth > limit + 0.5) out.overflow.push({ what: 'the page scrolls sideways', right: doc.scrollWidth, limit });
  for (const el of document.querySelectorAll('[data-specimen] *')) {
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.right > limit + 0.5) out.overflow.push({ what: name(el), right: rect.right, limit });
  }

  // Every family a drawn text stack names, at the weight and style it is drawn in. A device face (and a generic) is not ours;
  // any other must have an @font-face and must load. A name nothing declares is a MISSING face, not a skipped one.
  const generic = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-monospace', 'ui-sans-serif', 'ui-serif', 'ui-rounded', '-apple-system', 'BlinkMacSystemFont', 'math', 'emoji']);
  const declared = new Set([...document.fonts].map((face) => face.family.replace(/^["']|["']$/g, '')));
  const done = new Set();
  for (const run of runs) {
    for (const part of run.family.split(',')) {
      const family = part.trim().replace(/^["']|["']$/g, '');
      if (generic.has(family) || device.includes(family)) continue;
      const what = family + ' ' + run.weight + (run.style === 'normal' ? '' : ' ' + run.style);
      if (done.has(what)) continue;
      done.add(what);
      if (!declared.has(family)) { out.fonts.push({ what, loaded: false, reason: 'no @font-face' }); continue; }
      const faces = await document.fonts.load(run.style + ' ' + run.weight + ' ' + run.px + 'px "' + family + '"', run.text);
      if (faces.length === 0) out.fonts.push({ what, loaded: false, reason: 'no face at this weight' });
      else out.fonts.push({ what, loaded: faces.every((face) => face.status === 'loaded'), reason: 'not loaded' });
    }
  }
  return out;
})`;

/** Reads the focused control against its resting style; null when nothing (or the page) holds focus. */
const FOCUSED = `(() => {
  const { ratio, paint, behind, name, indicatorOf, splitTop } = window.__m;
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return null;
  const mark = indicatorOf(el);
  const rest = window.__rest.get(mark);
  if (!rest) return { what: name(el), unknown: true };
  const cs = getComputedStyle(mark);
  const outlineOn = cs.outlineStyle !== 'none' && Number.parseFloat(cs.outlineWidth) > 0;
  const restOutlineOn = rest.outlineStyle !== 'none' && Number.parseFloat(rest.outlineWidth) > 0;
  const outlineChanged = outlineOn && (!restOutlineOn || ['outlineStyle', 'outlineWidth', 'outlineColor', 'outlineOffset'].some((k) => rest[k] !== cs[k]));
  const borderChanged = !outlineChanged && cs.borderTopStyle !== 'none' && cs.borderTopColor !== rest.borderTopColor;
  const drawn = outlineChanged || borderChanged;
  const colour = outlineChanged ? cs.outlineColor : cs.borderTopColor;
  // A ring drawn outside the border box sits on what is around the control; one drawn inside sits on the control's own fill.
  const inside = outlineChanged && Number.parseFloat(cs.outlineOffset) < 0;
  // A FILLED control (the primary button) keeps a hard inset band of --surface under its inside ring (r11 S13, ui/design-system.css):
  // the ring sits on the band, not on the accent fill it is often the same colour as. The band is the shadow a viewer SEES at the
  // ring's inner edge: shadows paint first-on-top, so the FIRST inset, blur-0, zero-offset shadow whose painted depth (from the
  // padding edge, which the border pushes in) covers that edge. A shadow under it is hidden there (Gen Z lists its surface band
  // above its accent one and the ring reads on the surface), and one that stops short of the ring paints nothing behind it.
  // The ring's inner edge lies (minus the outline offset) px inside the border box; a band that is opaque is its colour, else no band.
  let band = null;
  if (inside && cs.boxShadow !== 'none') {
    const depth = -Number.parseFloat(cs.outlineOffset);
    const border = Number.parseFloat(cs.borderTopWidth) || 0;
    for (const part of splitTop(cs.boxShadow)) {
      if (!/inset/.test(part)) continue;
      const lengths = (part.match(/-?\\d*\\.?\\d+px/g) || []).map(Number.parseFloat);
      if (lengths.length < 4 || lengths[0] !== 0 || lengths[1] !== 0 || lengths[2] !== 0) continue;
      if (!(border <= depth && border + lengths[3] > depth)) continue;
      const colourPart = part.match(/(rgba?|color|hsla?|oklch|oklab|lab|lch)\\([^()]*(?:\\([^()]*\\)[^()]*)*\\)/);
      if (colourPart && window.__m.rgba(colourPart[0])[3] === 1) band = colourPart[0];
      break;
    }
  }
  const back = paint(band === null ? behind(mark, inside) : [...behind(mark, inside), band]);
  // r11 T14 probe 7 (S13's measure): the ring box is the border box inflated by what the focused state draws OUTSIDE it (an
  // outline's offset + width when it is positive, a non-inset box-shadow's spread); it must lie inside the padding box of
  // every ancestor that clips (overflow other than visible, contain: paint, a clip-path). The page's own scroll is not one.
  let reach = 0;
  if (outlineChanged) reach = Math.max(reach, Number.parseFloat(cs.outlineOffset) + Number.parseFloat(cs.outlineWidth));
  if (cs.boxShadow !== rest.boxShadow && cs.boxShadow !== 'none')
    for (const part of splitTop(cs.boxShadow)) {
      if (/inset/.test(part)) continue;
      const lengths = (part.match(/-?\\d*\\.?\\d+px/g) || []).map(Number.parseFloat);
      reach = Math.max(reach, lengths[3] || 0);
    }
  reach = Math.max(0, reach);
  mark.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const box = mark.getBoundingClientRect();
  const clipped = [];
  for (let up = mark.parentElement; up && up !== document.body && up !== document.documentElement; up = up.parentElement) {
    const ucs = getComputedStyle(up);
    const clips = ucs.overflowX !== 'visible' || ucs.overflowY !== 'visible' || /paint/.test(ucs.contain) || ucs.clipPath !== 'none';
    if (!clips) continue;
    const r = up.getBoundingClientRect();
    const left = r.left + up.clientLeft, top = r.top + up.clientTop;
    const right = left + up.clientWidth, bottom = top + up.clientHeight;
    if (box.left - reach < left - 0.5 || box.top - reach < top - 0.5 || box.right + reach > right + 0.5 || box.bottom + reach > bottom + 0.5)
      clipped.push(up.tagName.toLowerCase() + (up.getAttribute('data-probe') ? '[' + up.getAttribute('data-probe') + ']' : (up.className ? '.' + String(up.className).split(' ')[0] : '')));
  }
  return {
    clipped,
    what: name(el) + (borderChanged ? ' (border)' : ''),
    id: name(el),
    visible: el.matches(':focus-visible'),
    drawn,
    width: Number.parseFloat(outlineChanged ? cs.outlineWidth : cs.borderTopWidth) || 0,
    ratio: drawn ? ratio(paint([...(band === null ? behind(mark, inside) : [...behind(mark, inside), band]), colour]), back) : 0,
  };
})()`;

/** The r11 T14 style probes, read in the page as plain data (judged by `misses` in tests/support/theme-matrix.ts). */
const FACTS = `(() => {
  const { splitTop } = window.__m;
  const gradients = new Map();
  const add = (what, layers) => {
    const found = layers.filter((layer) => /gradient\\(/.test(layer));
    if (found.length > 0) gradients.set(what, [...(gradients.get(what) ?? []), ...found]);
  };
  // The only gradient the body may keep is a VERIFIED T2 tile: a layer that is exactly one of the pattern tokens
  // (--bg-pattern-grid, -dots, -lines or -scan, read through a probe element so the string is the browser's own), repeated, in a
  // tile-sized box. Position proves nothing: a full-page, non-repeating wash in the first layer is still a wash.
  const tiles = new Set();
  for (const kind of ['grid', 'dots', 'lines', 'scan']) {
    const probe = document.createElement('i');
    probe.style.backgroundImage = 'var(--bg-pattern-' + kind + ')';
    document.body.append(probe);
    tiles.add(getComputedStyle(probe).backgroundImage);
    probe.remove();
  }
  const bodyStyle = getComputedStyle(document.body);
  const sizes = splitTop(bodyStyle.backgroundSize);
  const repeats = splitTop(bodyStyle.backgroundRepeat);
  const isTile = (layer, index) => {
    const size = /^(\\d*\\.?\\d+)px (\\d*\\.?\\d+)px$/.exec(sizes[index % sizes.length]);
    return tiles.has(layer) && repeats[index % repeats.length] === 'repeat' && size !== null && size[1] === size[2] && Number.parseFloat(size[1]) <= 128;
  };
  add('Page', splitTop(bodyStyle.backgroundImage).filter((layer, index) => !isTile(layer, index)));
  add('Page overlay', splitTop(getComputedStyle(document.body, '::before').backgroundImage));
  // The grain is a layer of its own (body::after): a gradient substituted for the noise is a gradient background.
  add('Page grain', splitTop(getComputedStyle(document.body, '::after').backgroundImage));
  for (const [selector, what] of [['.kt-panel', 'Card'], ['.kt-panel__header', 'Panel header'], ['.kt-btn', 'Button'], ['.kt-input', 'Field'], ['.fy-cc__card', 'Choice card'], ['.kt-badge', 'Badge'], ['[role="menu"]', 'Menu']])
    for (const el of document.querySelectorAll(selector)) add(what, splitTop(getComputedStyle(el).backgroundImage));
  const radius = (el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return Math.max(...['TopLeft', 'TopRight', 'BottomLeft', 'BottomRight'].map((corner) => {
      const value = cs['border' + corner + 'Radius'].split(' ')[0];
      return value.endsWith('%') ? (Number.parseFloat(value) / 100) * Math.min(r.width, r.height) : Number.parseFloat(value) || 0;
    }));
  };
  const radii = [];
  for (const [selector, what] of [['[data-probe="textarea"]', 'Textarea radius'], ['.md pre', 'Code block radius'], ['.md table', 'Table radius'], ['[role="menu"]', 'Menu radius']]) {
    const el = document.querySelector(selector);
    if (el) radii.push({ what, px: Math.round(radius(el) * 10) / 10 });
  }
  const area = document.querySelector('[data-probe="textarea"]');
  const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  const probe = document.createElement('span');
  probe.style.fontSize = 'var(--text-display)';
  document.body.append(probe);
  const display = Math.max(Number.parseFloat(getComputedStyle(probe).fontSize), ...[...document.querySelectorAll('[data-specimen] h1, .fy-page h1')].map((h) => Number.parseFloat(getComputedStyle(h).fontSize)));
  probe.remove();
  const body = Number.parseFloat(getComputedStyle(document.querySelector('p[data-spec~="text"]')).fontSize);
  const sideBars = [];
  const bar = (el, what) => {
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const w = (side) => (cs['border' + side + 'Style'] !== 'none' ? Number.parseFloat(cs['border' + side + 'Width']) || 0 : 0);
    for (const [side, other] of [['Left', 'Right'], ['Right', 'Left']])
      if (w(side) >= 2 && w(side) > w(other) && w(side) > Math.max(w('Top'), w('Bottom'))) sideBars.push({ what, how: 'border-' + side.toLowerCase() + ' ' + w(side) + 'px' });
    if (cs.boxShadow !== 'none')
      for (const part of splitTop(cs.boxShadow)) {
        const lengths = (part.match(/-?\\d*\\.?\\d+px/g) || []).map(Number.parseFloat);
        if (/inset/.test(part) && lengths.length >= 2 && lengths[1] === 0 && Math.abs(lengths[0]) >= 2 && (lengths[2] || 0) === 0) sideBars.push({ what, how: 'inset side shadow ' + lengths[0] + 'px' });
      }
    for (const pseudo of ['::before', '::after']) {
      const p = getComputedStyle(el, pseudo);
      const width = Number.parseFloat(p.width);
      if (p.content !== 'none' && p.content !== 'normal' && p.position === 'absolute' && width >= 2 && width <= 6 && Number.parseFloat(p.height) >= rect.height * 0.7)
        sideBars.push({ what, how: pseudo + ' bar ' + width + 'px' });
    }
  };
  for (const [selector, what] of [['.fy-settings-nav .fy-tab--active', 'Selected nav item'], ['.fy-cc__card[data-selected="true"]', 'Selected choice card']]) {
    const el = document.querySelector(selector);
    if (el) bar(el, what);
  }
  return { gradients: [...gradients].map(([what, layers]) => ({ what, layers })), radii, textareaClipped: area ? area.scrollHeight > area.clientHeight + 1 : false, sizes: { display, body, rem }, sideBars };
})()`;

/**
 * The hypermedia probe's node: what the REAL renderer drew for the specimen's `FyRenderBlock` (the picture, its stage and its
 * viewport), as computed values (r11 T4's seam: `fy-render.css` consumes the `--hm-*` slots for every block it draws). The
 * declared tokens are NOT read: a token that moves with the renderer unchanged draws nothing and earns nothing. Stroke,
 * shadow and the fill's alpha are the parts a "shaped" and a "flat" style differ on. The corner RADIUS is deliberately not
 * read: until a renderer consumes `--hm-radius` (r12 H5), the only radius on the picture is the shared `--radius-sm` that
 * `.fy-render-pan` and its image take from the control scale, which every style sets for its buttons and fields and is not
 * hypermedia distinctness (r11 T14 review: five styles scored 6 of 8 on that alone). r12 H5 puts the radius back. Nothing here is a size or an
 * inherited font: those move with the page's layout and type, not with the renderer.
 */
const HYPERMEDIA_NODE = `(() => {
  const alphaOf = (value) => {
    const slash = /\\/\\s*([\\d.]+%?)\\s*\\)\$/.exec(value);
    if (slash) return slash[1];
    const comma = /^rgba?\\([^)]*,\\s*([\\d.]+)\\s*\\)\$/.exec(value);
    return comma ? comma[1] : '1';
  };
  return ['.fy-render-stage', '.fy-render-viewport', '.fy-render-pan', '.fy-render-image'].map((selector) => {
    const el = document.querySelector('[data-probe="hypermedia"] ' + selector);
    if (!el) return selector + ':absent';
    const cs = getComputedStyle(el);
    return selector + ':' + [cs.borderTopWidth, cs.borderTopStyle, cs.boxShadow.replace(/(rgba?|color)\\([^()]*\\)/g, 'C'), alphaOf(cs.backgroundColor), cs.filter, cs.clipPath, cs.outlineStyle].join('/');
  }).join('|');
})()`;

/**
 * One style's COMPONENT SIGNATURES, read in the page: for 8 probes (button, field, card, markdown h1, markdown code block,
 * spinner, hypermedia slots, background) the computed non-colour properties joined into one string. Colours are stripped, so
 * two styles that differ only in colour have the same signature (the owner: "alot of the style are color too").
 */
const SIGNATURE = `(async () => {
  // A stable clock: every transition is finished (its end value is the style's), every animation is held at the first frame
  // of its active phase. The declared durations, names and keyframes are untouched, so the signature reads the real motion.
  for (const animation of document.getAnimations()) {
    if (animation instanceof CSSTransition) animation.finish();
    else {
      animation.pause();
      animation.currentTime = animation.effect?.getComputedTiming().delay ?? 0;
    }
  }
  await new Promise((done) => requestAnimationFrame(() => done(undefined)));
  const plain = (value) => value.replace(/(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\\([^()]*\\)/g, 'C');
  const read = (el, props, pseudo) => {
    if (!el) return 'missing';
    const cs = getComputedStyle(el, pseudo);
    return props.map((prop) => prop + '=' + plain(String(cs[prop]).split(',')[0].startsWith('"') ? String(cs[prop]).split(',')[0] : String(cs[prop]))).join(';');
  };
  const frame = ['borderTopLeftRadius', 'borderTopWidth', 'borderTopStyle', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'boxShadow', 'backgroundImage', 'clipPath', 'backdropFilter'];
  const q = (selector) => document.querySelector(selector);
  const root = getComputedStyle(document.documentElement);
  const spinner = q('[data-probe="spinner"] svg');
  // EVERY rendered element of the spinner (the svg and all it draws), in document order: a part a style adds is a part measured.
  const parts = spinner ? [spinner, ...spinner.querySelectorAll('*')].map((el) => {
    const selector = el.tagName.toLowerCase() + '.' + (el.getAttribute('class') ?? '').trim().replace(/ +/g, '.');
    const cs = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    const motion = el.getAnimations().map((animation) => {
      const timing = animation.effect.getComputedTiming();
      const frames = animation.effect.getKeyframes().map((frame) => Object.entries(frame).filter(([key]) => key !== 'computedOffset' && key !== 'composite').map(([key, value]) => key + ':' + value).join(',')).join('>');
      return [animation.animationName ?? animation.transitionProperty, timing.duration, timing.iterations, timing.easing, frames].join('~');
    });
    return selector + ':' + [cs.display, cs.visibility, cs.animationName, cs.animationDuration, cs.animationTimingFunction, cs.animationIterationCount, cs.rx, cs.transform, cs.opacity, cs.strokeDasharray, Math.round(box.width * 10), Math.round(box.height * 10), motion.join('+')].join('/');
  }) : [];
  return {
    button: read(q('.kt-btn:not([data-variant])'), [...frame, 'textTransform', 'letterSpacing', 'fontWeight', 'fontFamily', 'fontSize', 'height', 'transitionDuration']),
    field: read(q('input.kt-input'), [...frame, 'fontFamily', 'height', 'fontSize']),
    card: read(q('.kt-panel'), [...frame, 'padding']),
    mdH1: read(q('.md h1'), ['fontSize', 'fontWeight', 'textTransform', 'letterSpacing', 'borderBottomWidth', 'borderBottomStyle', 'fontFamily', 'fontStyle', 'textDecorationLine']),
    mdCode: read(q('.md pre'), [...frame, 'padding', 'fontFamily', 'fontSize']),
    spinner: plain((spinner ? getComputedStyle(spinner).animationName + '|' : '') + parts.join('|')),
    hypermedia: ${HYPERMEDIA_NODE},
    background: [plain(getComputedStyle(document.body).backgroundImage), root.getPropertyValue('--bg-pattern-size').trim(), read(document.body, ['backgroundSize', 'backgroundAttachment'], '::before'), read(document.body, ['backgroundImage', 'opacity', 'mixBlendMode'], '::after'), read(document.body, ['backgroundImage', 'opacity'], '::before')].join('|'),
  };
})()`;

/** Puts the keyboard's starting point just above the first control, so the first Tab lands on it. */
const RESET_START = `(() => {
  document.activeElement?.blur?.();
  const heading = document.querySelector('[data-specimen] h1');
  heading.tabIndex = -1;
  heading.focus({ preventScroll: true });
})()`;

interface FocusRead {
  readonly what: string;
  readonly id: string;
  readonly visible: boolean;
  readonly drawn: boolean;
  readonly width: number;
  readonly ratio: number;
  readonly clipped?: readonly string[];
  readonly unknown?: true;
}

/**
 * `motion: 'frozen'` (the matrix) kills every transition and animation so a colour is read settled. `'real'` (the style
 * signature) leaves them as the style declares them: a transition duration and a spinner animation are the things the signature
 * measures, so they must not be overridden; the signature freezes the clock itself, at the first frame, when it reads.
 */
const open = async (
  viewport: (typeof VIEWPORTS)[number],
  mode: 'light' | 'dark',
  motion: 'frozen' | 'real' = 'frozen',
) => {
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
  if (reducedTransparency)
    await (await context.newCDPSession(tab)).send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
    });
  await tab.goto(`${origin}/`);
  // A colour read mid-transition is neither the old theme nor the new one: measure the settled state.
  if (motion === 'frozen')
    await tab.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });
  await tab.waitForSelector('[role="menu"] [role="menuitem"]');
  await tab.evaluate(HELPERS);
  await tab.evaluate(`window.__m.backdrop = ${BACKDROP}; window.__m.scan = ${STATIC};`);
  return { tab, close: async () => await context.close() };
};

/** Presses `key` and reads what holds focus; `moved` waits (briefly) for a handler that moves focus after the event. */
const press = async (tab: Page, key: string, previous: string | null): Promise<FocusRead | null> => {
  await tab.keyboard.press(key);
  let read = (await tab.evaluate(FOCUSED)) as FocusRead | null;
  for (let attempt = 0; attempt < 5 && read !== null && read.id === previous && key !== 'Tab'; attempt += 1) {
    await tab.waitForTimeout(10);
    read = (await tab.evaluate(FOCUSED)) as FocusRead | null;
  }
  return read;
};

/** Walks the page the way a keyboard user does: Tab through every stop, the arrows through the choice row and the menu. */
const walk = async (tab: Page): Promise<readonly FocusRead[]> => {
  await tab.evaluate(RESET_START);
  const reads: FocusRead[] = [];
  let last: FocusRead | null = null;
  const push = (read: FocusRead | null): boolean => {
    if (read === null || read.unknown === true) return false;
    reads.push(read);
    last = read;
    return true;
  };
  for (let step = 0; step < 24; step += 1) {
    const before: string | null = last === null ? null : (last as FocusRead).id;
    const read = await press(tab, 'Tab', before);
    if (read === null || read.id === before) break;
    // A stop the matrix does not measure (the textarea, the markdown link, the nav links) is walked past, not the end of the walk.
    if (!push(read)) continue;
    if (read.id.startsWith('Choice ')) {
      // The checked card is the one tab stop; the arrows move (and select) from there and back.
      for (const key of ['ArrowRight', 'ArrowLeft']) push(await press(tab, key, (last as unknown as FocusRead).id));
    }
  }
  // The menu keeps one roving tab stop; the arrows visit the rest of its rows.
  if (last !== null) {
    for (const key of ['ArrowDown', 'ArrowDown']) {
      const read = await press(tab, key, (last as FocusRead).id);
      if (read === null || read.id === (last as FocusRead).id) break;
      push(read);
    }
  }
  return reads;
};

/** Runs one of the page-side functions installed by `open` (`window.__m.<name>`) with one argument. */
const call = async (tab: Page, name: 'backdrop' | 'scan', arg: unknown): Promise<unknown> =>
  await tab.evaluate(
    ([fn, input]) =>
      (window as unknown as { __m: Record<string, (value: unknown) => unknown> }).__m[fn as string]?.(input),
    [name, arg] as const,
  );

/** Points the page at one style x palette x mode and waits until it is painted. */
const apply = async (tab: Page, style: string, palette: string, mode: string): Promise<void> => {
  await tab.evaluate(
    ([s, p, m]) => {
      const root = document.documentElement;
      root.setAttribute('data-style', s as string);
      root.setAttribute('data-palette', p as string);
      root.setAttribute('data-mode', m as string);
    },
    [style, palette, mode] as const,
  );
  // A face that arrives late re-flows the text: measure after the new style's faces are in, so a rect and a pixel agree.
  await tab.evaluate(async () => {
    document.body.getBoundingClientRect();
    await document.fonts.ready;
    await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
  });
};

const settle = async (tab: Page, style: string, palette: string, mode: string): Promise<Measured> => {
  await apply(tab, style, palette, mode);
  const { runs, wanted } = (await tab.evaluate(PREPARE)) as {
    runs: { family: string; weight: number; px: number; style: string; text: string; what: string; muted: boolean }[];
    wanted: string[];
  };
  // The backdrop: the page with its glyphs hidden, read pixel by pixel behind every text run.
  const hide = await tab.addStyleTag({ content: HIDE_TEXT });
  const png = (await tab.screenshot({ fullPage: true, scale: 'css', type: 'png' })).toString('base64');
  await hide.evaluate(node => (node as Element).remove());
  const text = (await call(tab, 'backdrop', { png, runs })) as Measured['text'];
  const fixed = (await call(tab, 'scan', { runs, device: DEVICE_FACES })) as Pick<
    Measured,
    'edge' | 'overflow' | 'fonts'
  >;
  const facts = (await tab.evaluate(FACTS)) as Facts;
  const reads = await walk(tab);
  const reached = new Set(reads.map(read => read.id));
  const focus: Measured['focus'][number][] = reads.map(read => ({ ...read, reached: true }));
  for (const what of wanted)
    if (!reached.has(what)) focus.push({ what, reached: false, visible: false, drawn: false, width: 0, ratio: 0 });
  return { text, edge: fixed.edge, overflow: fixed.overflow, fonts: fixed.fonts, focus, facts };
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
const observed = new Set<string>();
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
            const highContrast = palette.id === 'contrast';
            for (const miss of misses(measured, { style: style.id, highContrast, wide: !viewport.phone })) {
              const { verdict, key } = verdictOf(style.loud === true, where, miss, pins, highContrast);
              const row: Row = { ...where, miss };
              if (verdict === 'known') {
                usedPins.add(key);
                known.push(row);
              } else if (verdict === 'warn') warnings.push(row);
              else {
                failures.push(row);
                hard.push(miss);
              }
              observed.add(key);
            }
            expect(
              hard.map(miss => `${miss.check}: ${miss.what} ${miss.got} (need ${miss.need})`),
              `${style.id} x ${palette.id} ${mode} at ${viewport.name}`,
            ).toEqual([]);
          });
    });

/**
 * Probe 5, across styles: each style on ITS default palette, at BOTH widths in BOTH modes (the signatures carry no colour, so the
 * palette only has to be the same one the owner gets), read with the style's real motion. Every style differs from Studio on
 * >= 6 of 8 components and owns its spinner, in every variant: a phone or a dark mode that falls back to Studio is a miss.
 */
let contractMeasured = 0;
for (const viewport of VIEWPORTS)
  for (const mode of MODES)
    describe(`the style contract at ${viewport.name} in ${mode}`, () => {
      const signatures = new Map<string, Signature>();
      let session: Awaited<ReturnType<typeof open>>;
      beforeAll(async () => {
        session = await open(viewport, mode, 'real');
        for (const style of STYLES) {
          await apply(session.tab, style.id, style.defaultPalette, mode);
          signatures.set(style.id, (await session.tab.evaluate(SIGNATURE)) as Signature);
        }
      }, 120_000);
      afterAll(async () => {
        await session.close();
      });
      for (const style of STYLES)
        it(`${style.id} differs from Studio on its components and has a spinner of its own`, () => {
          contractMeasured += 1;
          const where = { viewport: viewport.name, style: style.id, palette: style.defaultPalette, mode };
          const hard: Miss[] = [];
          for (const miss of contractMisses(style.id, signatures)) {
            const { verdict, key } = verdictOf(style.loud === true, where, miss, pins);
            const row: Row = { ...where, miss };
            if (verdict === 'known') {
              usedPins.add(key);
              known.push(row);
            } else {
              failures.push(row);
              hard.push(miss);
            }
            observed.add(key);
          }
          expect(
            hard.map(miss => `${miss.check}: ${miss.what} ${miss.got} (need ${miss.need})`),
            `${style.id} contract at ${viewport.name} in ${mode}`,
          ).toEqual([]);
        });
    });

/**
 * The positive control for probe 7: the same walk, with every focus ring drawn INSIDE its control (a negative offset as deep as
 * the ring is thick), reads no clipped ring. Without it a probe that always fails would look like a probe that works.
 */
describe('the ring-clip probe can pass', () => {
  it('a ring drawn inside the control is inside the clipping scroll box', async () => {
    const session = await open(VIEWPORTS[0], 'light');
    try {
      await apply(session.tab, 'studio', 'studio', 'light');
      await session.tab.addStyleTag({
        content: ':focus-visible { outline-width: 2px !important; outline-offset: -2px !important; }',
      });
      await session.tab.evaluate(PREPARE);
      const reads = await walk(session.tab);
      const clip = reads.filter(read => read.id.startsWith('Clipped'));
      expect(clip.length).toBe(3);
      expect(clip.flatMap(read => read.clipped ?? [])).toEqual([]);
    } finally {
      await session.close();
    }
  });
});

/**
 * r11 T14, the review of PR 2226: each assert below is a real-browser measurement that FAILED on the probe it replaces.
 */
describe('the probes read the real page', () => {
  const washed = (tab: Page, css: string) => tab.addStyleTag({ content: css });
  const gone = async (style: Awaited<ReturnType<Page['addStyleTag']>>) =>
    await style.evaluate(node => (node as Element).remove());

  it('the Primary ring is read against the surface band the button draws under it, and fails where the band is gone', async () => {
    const session = await open(VIEWPORTS[0], 'light');
    try {
      const primaryRing = async () => {
        const measured = await settle(session.tab, 'studio', 'studio', 'light');
        const read = measured.focus.find(row => row.what === 'Primary');
        return {
          ratio: read?.ratio ?? 0,
          miss: misses(measured, { style: 'studio', highContrast: false, wide: true }).find(
            miss => miss.check === 'focus' && miss.what === 'Primary ring colour',
          ),
        };
      };
      const withBand = await primaryRing();
      expect(withBand.ratio, 'the ring on the surface band').toBeGreaterThanOrEqual(3);
      expect(withBand.miss).toBeUndefined();
      // Without the band the ring sits on the accent fill it is drawn in: 1:1, and the probe says so.
      const noBand = await washed(
        session.tab,
        ".kt-btn[data-variant='primary']:focus-visible { box-shadow: none !important; }",
      );
      const without = await primaryRing();
      await gone(noBand);
      expect(without.ratio, 'the ring on the accent fill').toBeLessThan(1.5);
      expect(without.miss?.got).toBeDefined();
    } finally {
      await session.close();
    }
  });

  /**
   * What a real screenshot paints across the left edge of a control: the colour on the ring, just inside it and just outside it
   * (the pixel at the middle of the outline, the first pixel past its inner edge, the first pixel past its outer edge), read at
   * mid-height. The control is focused by keyboard, so `:focus-visible` is on.
   */
  const ringPixels = async (tab: Page, selector: string) => {
    const target = tab.locator(selector).first();
    await target.scrollIntoViewIfNeeded();
    await tab.keyboard.press('Tab');
    await target.focus();
    const geometry = await target.evaluate(node => {
      const cs = getComputedStyle(node);
      const box = node.getBoundingClientRect();
      return {
        visible: node.matches(':focus-visible'),
        width: Number.parseFloat(cs.outlineWidth),
        offset: Number.parseFloat(cs.outlineOffset),
        x: box.left + window.scrollX,
        y: box.top + window.scrollY + box.height / 2,
      };
    });
    const left = Math.floor(geometry.x) - 6;
    const png = (
      await tab.screenshot({
        clip: { x: left, y: Math.floor(geometry.y), width: 24, height: 1 },
        fullPage: true,
        scale: 'css',
        type: 'png',
      })
    ).toString('base64');
    const row = (await tab.evaluate(async (data: string) => {
      const bitmap = await createImageBitmap(
        new Blob([Uint8Array.from(atob(data), c => c.charCodeAt(0))], { type: 'image/png' }),
      );
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const g = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
      g.drawImage(bitmap, 0, 0);
      const d = g.getImageData(0, 0, bitmap.width, 1).data;
      return Array.from({ length: bitmap.width }, (_, i) => [d[i * 4] ?? 0, d[i * 4 + 1] ?? 0, d[i * 4 + 2] ?? 0]);
    }, png)) as number[][];
    // Depth `d` px inside the border box is the pixel at x = box.left + d.
    const at = (depth: number) => row[Math.floor(geometry.x) - left + Math.floor(depth)] as number[];
    const inner = -geometry.offset;
    const ratio = (a: number[], b: number[]) =>
      contrastRatio(luminance(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0), luminance(b[0] ?? 0, b[1] ?? 0, b[2] ?? 0));
    const ring = at(inner - geometry.width / 2);
    return {
      visible: geometry.visible,
      inside: ratio(ring, at(inner + 0.5)),
      outside: ratio(ring, at(inner - geometry.width - 0.5)),
    };
  };
  const probeRatio = async (tab: Page, style: string, palette: string, mode: string, what: string) => {
    const measured = await settle(tab, style, palette, mode);
    return measured.focus.find(row => row.what === what)?.ratio ?? 0;
  };

  /**
   * r11 S13b, review of PR 2258: Gen Z lists two opaque inset bands, the surface FIRST (painted on top) and the accent under it.
   * The ring is read on what a viewer sees at its inner edge, the topmost band, so the probe's ratio is the screenshot's, and
   * the same page with the two bands swapped reads the accent one: the probe follows the layering, not the list's last row.
   */
  for (const viewport of VIEWPORTS)
    for (const mode of MODES)
      for (const palette of ['studio', 'mission']) {
        it(`Gen Z's Name ring is read on its topmost band, as painted (${palette}, ${mode}, ${viewport.name})`, async () => {
          const session = await open(viewport, mode);
          try {
            const name = 'input[aria-label="Name"]';
            const read = await probeRatio(session.tab, 'genz', palette, mode, 'Name');
            const pixels = await ringPixels(session.tab, name);
            expect(pixels.visible).toBe(true);
            expect(read, 'the probe on the surface band').toBeGreaterThanOrEqual(3);
            expect(Math.min(pixels.inside, pixels.outside), 'the painted ring on both sides').toBeGreaterThanOrEqual(3);
            expect(Math.abs(read - pixels.inside), 'the probe and the pixels agree').toBeLessThan(0.5);
            // The same two bands, accent on top: what the viewer sees at the ring is now the accent band.
            const swapped = await session.tab.addStyleTag({
              content: `:root[data-style='genz'] :is(select, input, textarea).kt-input:focus-visible { box-shadow: inset 0 0 0 calc(var(--focus-width) + 5px) var(--focus-color), inset 0 0 0 calc(var(--focus-width) + 2px) var(--surface) !important; }`,
            });
            const readSwapped = await probeRatio(session.tab, 'genz', palette, mode, 'Name');
            const pixelsSwapped = await ringPixels(session.tab, name);
            await gone(swapped);
            expect(Math.abs(readSwapped - pixelsSwapped.inside), 'the probe follows the top band').toBeLessThan(0.5);
          } finally {
            await session.close();
          }
        });
      }

  /**
   * r11 S13b, review of PR 2258: an inset band thick enough to match the ring is no use if it stops short of it. Studio's ring
   * at offset -8px with border 0 and a 2px surface band paints accent on accent on BOTH sides (the band is at the edge, the ring
   * 8px in): the probe must read that as a miss, as the pixels do.
   */
  it('an inset band that does not reach the ring is no band, and the probe reads the ring on the fill', async () => {
    const session = await open(VIEWPORTS[0], 'light');
    try {
      const style = await washed(
        session.tab,
        ".kt-btn[data-variant='primary']:focus-visible:not(:disabled) { outline-offset: -8px !important; border-width: 0 !important; box-shadow: inset 0 0 0 2px var(--surface) !important; }",
      );
      const read = await probeRatio(session.tab, 'studio', 'studio', 'light', 'Primary');
      const pixels = await ringPixels(session.tab, ".kt-btn[data-variant='primary']");
      await gone(style);
      expect(pixels.visible).toBe(true);
      expect(Math.max(pixels.inside, pixels.outside), 'the painted ring').toBeLessThan(1.5);
      expect(read, 'the probe').toBeLessThan(1.5);
    } finally {
      await session.close();
    }
  });

  it('the gradient probe tells a verified T2 tile from a wash on any layer, and reads the grain too', async () => {
    const session = await open(VIEWPORTS[0], 'light');
    try {
      await apply(session.tab, 'studio', 'studio', 'light');
      const read = async () => ((await session.tab.evaluate(FACTS)) as Facts).gradients.map(row => row.what).sort();
      expect(await read(), 'Studio paints no gradient').toEqual([]);
      // A verified tile: one of the pattern tokens, repeating, tile-sized.
      const tile = await washed(session.tab, ':root { --bg-pattern: var(--bg-pattern-grid) !important; }');
      expect(await read(), 'the T2 grid tile is the texture, not a wash').toEqual([]);
      // The SAME grid image, stretched over the page and not repeated, is a wash wearing a tile's name.
      const stretched = await washed(
        session.tab,
        'body { background-size: 100% 100% !important; background-repeat: no-repeat !important; }',
      );
      expect(await read(), 'a full-page, non-repeating grid is a wash').toEqual(['Page']);
      await gone(stretched);
      await gone(tile);
      // A full-page radial wash as the ONLY layer (Chromium accepted it in the first position).
      const wash = await washed(
        session.tab,
        'body { background-image: radial-gradient(circle at 50% 0%, #f00, #00f) !important; background-size: 100% 100% !important; background-repeat: no-repeat !important; }',
      );
      expect(await read(), 'a wash as the only layer').toEqual(['Page']);
      await gone(wash);
      // A gradient substituted into the grain layer.
      const grain = await washed(
        session.tab,
        'body::after { background-image: linear-gradient(#f00, #00f) !important; }',
      );
      expect(await read(), 'a gradient grain').toEqual(['Page grain']);
      await gone(grain);
      expect(await read(), 'nothing left behind').toEqual([]);
    } finally {
      await session.close();
    }
  });

  /** A grey whose contrast against the page background is as near `target` as 8-bit greys allow. */
  const greyAt = async (tab: Page, target: number) =>
    (await tab.evaluate((want: number) => {
      const m = (window as unknown as { __m: Record<string, (...args: unknown[]) => never> }).__m;
      const back = m.paint!(m.behind!(document.querySelector('p[data-spec~="text"]'), true)) as number[];
      let best = 0;
      let gap = Number.POSITIVE_INFINITY;
      for (let g = 0; g <= 255; g += 1) {
        const got = m.ratio!([g, g, g], back) as number;
        if (Math.abs(got - want) < gap) {
          gap = Math.abs(got - want);
          best = g;
        }
      }
      return best;
    }, target)) as number;

  it('the High contrast floors hold end to end: muted text 4.5:1, body text 7:1', async () => {
    const session = await open(VIEWPORTS[0], 'light');
    try {
      await apply(session.tab, 'studio', 'contrast', 'light');
      const muted = 'Muted text is the quiet line under a title.'.slice(0, 28);
      const body =
        'Body text sits on the page: a sentence long enough to wrap on a phone, so the measure is real.'.slice(0, 28);
      const textMisses = async (grey: number) => {
        const ink = await washed(
          session.tab,
          `p[data-spec~="text"] { color: rgb(${grey}, ${grey}, ${grey}) !important; }`,
        );
        const measured = await settle(session.tab, 'studio', 'contrast', 'light');
        await gone(ink);
        const all = misses(measured, { style: 'studio', highContrast: true, wide: true }).filter(
          miss => miss.check === 'text',
        );
        return {
          mutedRow: measured.text.find(row => row.what === muted),
          bodyRow: measured.text.find(row => row.what === body),
          mutedMiss: all.find(miss => miss.what === muted),
          bodyMiss: all.find(miss => miss.what === body),
        };
      };
      // 5.5:1: over the muted floor (4.5) and under the body floor (7).
      const mid = await textMisses(await greyAt(session.tab, 5.5));
      expect(mid.mutedRow?.muted, 'the browser run is flagged muted').toBe(true);
      expect(mid.bodyRow?.muted === true, 'the body run is not').toBe(false);
      expect(mid.mutedRow?.ratio ?? 0).toBeGreaterThan(4.6);
      expect(mid.mutedRow?.ratio ?? 0).toBeLessThan(6.9);
      expect(mid.mutedMiss, 'muted text at 5.5:1 passes the 4.5:1 floor').toBeUndefined();
      expect(mid.bodyMiss?.need, 'body text at 5.5:1 fails the 7:1 floor').toBe('>=7:1');
      // 3.5:1: under both floors, and the muted one says 4.5.
      const low = await textMisses(await greyAt(session.tab, 3.5));
      expect(low.mutedMiss?.need, 'muted text at 3.5:1 fails the 4.5:1 floor').toBe('>=4.5:1');
      expect(low.bodyMiss?.need).toBe('>=7:1');
    } finally {
      await session.close();
    }
  });

  for (const viewport of VIEWPORTS)
    for (const mode of MODES)
      it(`the signature reads the REAL spinner animation, on a stable clock, at ${viewport.name} in ${mode}`, async () => {
        const session = await open(viewport, mode, 'real');
        try {
          await apply(session.tab, 'studio', 'studio', mode);
          const drawn = (await session.tab.evaluate(() => {
            const svg = document.querySelector('[data-probe="spinner"] svg');
            const parts = svg === null ? [] : [svg, ...svg.querySelectorAll('*')];
            return {
              names: parts.map(part => getComputedStyle(part).animationName).filter(name => name !== 'none'),
              running: parts.reduce((count, part) => count + part.getAnimations().length, 0),
            };
          })) as { names: string[]; running: number };
          expect(drawn.names.length, "Studio's spinner has a computed animation").toBeGreaterThan(0);
          expect(drawn.running, 'and it is a running animation').toBeGreaterThan(0);
          const first = ((await session.tab.evaluate(SIGNATURE)) as Signature).spinner;
          expect(first, 'the signature carries the animation by name').toContain(drawn.names[0] as string);
          await session.tab.waitForTimeout(350);
          expect(((await session.tab.evaluate(SIGNATURE)) as Signature).spinner, 'a stable reading').toBe(first);
        } finally {
          await session.close();
        }
      });

  it('the shared --radius-sm (what .fy-render-pan reads today) is not hypermedia distinctness', async () => {
    // No renderer reads an --hm-* slot at this head (r12 H5 owns that), so the only thing a style can move on the picture is
    // the shared control radius. A probe that counts it scores every style "distinct" for a change that is not hypermedia.
    const session = await open(VIEWPORTS[0], 'light', 'real');
    try {
      await apply(session.tab, 'studio', 'studio', 'light');
      const panRadius = async () =>
        (await session.tab.evaluate(
          `getComputedStyle(document.querySelector('[data-probe="hypermedia"] .fy-render-pan')).borderTopLeftRadius`,
        )) as string;
      const probe = async () => ((await session.tab.evaluate(SIGNATURE)) as Signature).hypermedia;
      const before = { radius: await panRadius(), probe: await probe() };
      const wash = await washed(session.tab, ':root { --radius-sm: 91px !important; }');
      const after = { radius: await panRadius(), probe: await probe() };
      await gone(wash);
      expect(after.radius, 'the shared radius really changed the picture frame (the lever works)').toBe('91px');
      expect(before.radius, 'and it was not 91px before').not.toBe('91px');
      expect(after.probe, 'but the hypermedia signature does not move').toBe(before.probe);
    } finally {
      await session.close();
    }
  });

  it('a hypermedia token declared with the renderer unchanged moves nothing the probe reads', async () => {
    const session = await open(VIEWPORTS[0], 'light', 'real');
    try {
      await apply(session.tab, 'studio', 'studio', 'light');
      const node = async () => (await session.tab.evaluate(HYPERMEDIA_NODE)) as string;
      const probe = async () => ((await session.tab.evaluate(SIGNATURE)) as Signature).hypermedia;
      const before = { node: await node(), probe: await probe() };
      expect(before.node, 'the real renderer drew the specimen').not.toContain(':absent');
      const tokens = await washed(
        session.tab,
        ':root { --hm-shape: flat !important; --hm-radius: 0px !important; --hm-stroke: 3px !important; --hm-font: monospace !important; --hm-node-fill-alpha: 0.2 !important; --hm-edge: straight !important; --hm-header: none !important; }',
      );
      const after = { node: await node(), probe: await probe() };
      await gone(tokens);
      // The probe moves exactly when the rendered node moves: a disconnected consumer earns no point.
      expect(after.probe !== before.probe, "the probe moves iff the renderer's node moves").toBe(
        after.node !== before.node,
      );
    } finally {
      await session.close();
    }
  });
});

describe('the known-misses ledger', () => {
  it('pins exactly the misses that exist (a pin whose miss is gone must be deleted)', () => {
    // A filtered run (-t) measures only some combinations, so a pin can look unused; only a full run can say.
    if (measuredCombos < EXPECTED_COMBOS || contractMeasured < STYLES.length * VIEWPORTS.length * MODES.length) return;
    expect(stalePins(pins, observed)).toEqual([]);
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
