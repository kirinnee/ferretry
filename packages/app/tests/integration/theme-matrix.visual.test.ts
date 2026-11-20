/**
 * THE THEME MATRIX: every STYLE x every PALETTE x both MODES x two WIDTHS (6 x 17 x 2 x 2 = 408 combinations today), measured
 * in a real browser on one fixed specimen page (`fixtures/theme-matrix-scene.tsx`). The catalogue is the list (`STYLES`,
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
  contrastRatio,
  type Known,
  luminance,
  type Measured,
  type Miss,
  misses,
  pinnedMisses,
  stalePins,
  verdictOf,
} from '../support/theme-matrix.ts';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_THEME_MATRIX_SHOTS_DIR ?? '';
const reportFile = process.env.FY_THEME_MATRIX_REPORT ?? '';
/** Set to `1` to run the whole matrix with the OS "reduce transparency" setting emulated (every surface must stay readable opaque). */
const reducedTransparency = process.env.FY_THEME_MATRIX_REDUCED_TRANSPARENCY === '1';

const MODES = ['light', 'dark'] as const;
const VIEWPORTS = [
  { name: '1280', width: 1_280, height: 1_200, phone: false },
  { name: '390', width: 390, height: 1_200, phone: true },
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
];

/**
 * Misses that exist TODAY and are not this test's to fix: EMPTY, every earlier pin (text-field focus ring, unselected choice
 * card edge, Ledger dark status inks) has been fixed in the CSS. A row is the cross product of the lists it names, every list
 * explicit (never `PALETTES.map(...)`: a palette added to the catalogue is in no pin until somebody reads what it misses), and
 * says why; the identity of a miss is (width, style, palette, mode, check, what). The observed misses are compared with these
 * pins both ways, so fixing a cause means deleting its row.
 */
const KNOWN: readonly Known[] = [];
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
  window.__m = { paint, rgba, ratio, behind, name, indicatorOf };
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
  const keys = ['outlineStyle', 'outlineWidth', 'outlineColor', 'outlineOffset', 'borderTopStyle', 'borderTopColor', 'borderTopWidth'];
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
    return { what, text, rects, ink: cs.color, px: Number.parseFloat(cs.fontSize), weight: Number.parseInt(cs.fontWeight, 10) || 400, style: cs.fontStyle, family: cs.fontFamily };
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
    if (worst !== Number.POSITIVE_INFINITY) out.push({ what: run.what, ratio: worst, px: run.px, weight: run.weight });
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
  const { ratio, paint, behind, name, indicatorOf } = window.__m;
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
  const back = paint(behind(mark, inside));
  return {
    what: name(el) + (borderChanged ? ' (border)' : ''),
    id: name(el),
    visible: el.matches(':focus-visible'),
    drawn,
    width: Number.parseFloat(outlineChanged ? cs.outlineWidth : cs.borderTopWidth) || 0,
    ratio: drawn ? ratio(paint([...behind(mark, inside), colour]), back) : 0,
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
  readonly unknown?: true;
}

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
  if (reducedTransparency)
    await (await context.newCDPSession(tab)).send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
    });
  await tab.goto(`${origin}/`);
  // A colour read mid-transition is neither the old theme nor the new one: measure the settled state.
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
  for (let step = 0; step < 14; step += 1) {
    const before: string | null = last === null ? null : (last as FocusRead).id;
    const read = await press(tab, 'Tab', before);
    if (read === null || read.id === before || !push(read)) break;
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
  // A face that arrives late re-flows the text: measure after the new style's faces are in, so a rect and a pixel agree.
  await tab.evaluate(async () => {
    document.body.getBoundingClientRect();
    await document.fonts.ready;
    await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
  });
  const { runs, wanted } = (await tab.evaluate(PREPARE)) as {
    runs: { family: string; weight: number; px: number; style: string; text: string; what: string }[];
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
  const reads = await walk(tab);
  const reached = new Set(reads.map(read => read.id));
  const focus: Measured['focus'][number][] = reads.map(read => ({ ...read, reached: true }));
  for (const what of wanted)
    if (!reached.has(what)) focus.push({ what, reached: false, visible: false, drawn: false, width: 0, ratio: 0 });
  return { text, edge: fixed.edge, overflow: fixed.overflow, fonts: fixed.fonts, focus };
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
            for (const miss of misses(measured)) {
              const { verdict, key } = verdictOf(style.loud === true, where, miss, pins);
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

describe('the known-misses ledger', () => {
  it('pins exactly the misses that exist (a pin whose miss is gone must be deleted)', () => {
    // A filtered run (-t) measures only some combinations, so a pin can look unused; only a full run can say.
    if (measuredCombos < EXPECTED_COMBOS) return;
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
