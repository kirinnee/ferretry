/**
 * THE LUCID + BRIEFING STYLE KITS (r11 T11), measured in a real browser on the theme matrix's specimen page
 * (`plugins/conversation/tests/integration/app/fixtures/theme-matrix-scene.tsx`), each style on its DEFAULT palette (Lucid:
 * Indigo, the `studio` palette id; Briefing: Blue, the `geist` palette id), in both modes at 1280 and 390.
 *
 * The owner's line (turn 4247, item 12): "BG and grainy-ness can help with the style too -- and ... components too, including
 * how markdown looks", "make sure things like spinner, animation all are unique to their style", "most of them should not have
 * gradient background", "affect all components please, not just a blanket CSS edit". So each style FILLS every slot of the
 * component style contract with its own idiom, and the two must not read as one another or as any other style:
 *
 *   Lucid    = a gel desktop. A fine horizontal pinstripe on the page (a tile, never a wash); every capsule control lit from above
 *              with a bright line under its top edge and a deeper lower half drawn by INSET SHADOWS (no gradient anywhere); recessed
 *              fields; markdown as a window sheet (ruled h1, recessed code well, a tinted quote block, striped table, tag links);
 *              a spinner that is a glossy BEAD rolling round a thin rail with a trailing droplet, the bead squashing as it goes;
 *              springy motion; hypermedia `shaped`.
 *   Briefing = a printed report. Paper grain on the page; Gelasio serif headings over thin Poppins, a double rule under h1, a ruled
 *              code box, a ledger table (rules only, no grid), a pull-quote block; a spinner that is FOUR LINES OF TEXT being
 *              written one after another; calm eased motion; hypermedia `ink`.
 *
 * The STYLE KITS rules from the six earlier reviews (T5-T10) are asserted here too, each against the real engine:
 *   - the spinner's live animations, their delays (the base `animation` shorthand resets a part's stagger, so each part restates
 *     it) and their PHASE at fixed times; every one of those asserts also runs with `animation-name: none` injected and must throw;
 *   - a swatch of ANOTHER style on a page of either style paints exactly as on its own page, for the spinner AND for the controls
 *     (tick, card, input, badge, segmented, quiet and primary button, panel header, striped rows, label), and a swatch of THIS
 *     style paints the same wherever it sits;
 *   - the focus ring on a filled control (Send, the selected Settings link) keeps >= 3:1 against that fill, is drawn inside the
 *     control (never clipped), and the busy mark on a filled Send keeps the button's own foreground.
 *
 * Set `FY_LUCID_BRIEFING_KIT_REPORT=<file>` to write the measured numbers (JSON), the values the PR body quotes, and
 * `FY_LUCID_BRIEFING_KIT_SHOTS=<dir>` for the fake-data shots.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { COLOUR_TOOLS, sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const conversationScenes = resolve(packageRoot, '../../../plugins/conversation/tests/integration/app/fixtures');
const reportFile = process.env.FY_LUCID_BRIEFING_KIT_REPORT ?? '';

const MODES = ['light', 'dark'] as const;
const VIEWPORTS = [
  { name: '1280', width: 1_280, phone: false },
  { name: '390', width: 390, phone: true },
] as const;
/** Each style's own default palette (T1's table): what a person gets when they pick it. */
const DEFAULT_PALETTE = {
  lucid: 'studio',
  briefing: 'geist',
  studio: 'studio',
  neo: 'neo',
  mission: 'mission',
} as const;
type PageStyle = keyof typeof DEFAULT_PALETTE;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;
const report: Record<string, unknown> = {};

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-lucid-briefing-kit-'));
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
  if (reportFile !== '') await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
});

/** One style on its default palette (or `palette`), drawn with its real motion (a spinner's animation is read, not frozen). */
const open = async (
  viewport: (typeof VIEWPORTS)[number],
  mode: 'light' | 'dark',
  style: PageStyle,
  palette: string = DEFAULT_PALETTE[style],
): Promise<{ tab: Page; close: () => Promise<void> }> => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: 2_400 },
    colorScheme: mode,
    hasTouch: viewport.phone,
    isMobile: viewport.phone,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  await tab.goto(`${origin}/`);
  await tab.waitForSelector('[role="menu"] [role="menuitem"]');
  await tab.evaluate(
    ([s, p, m]) => {
      const root = document.documentElement;
      root.setAttribute('data-style', s as string);
      root.setAttribute('data-palette', p as string);
      root.setAttribute('data-mode', m as string);
    },
    [style, palette, mode] as const,
  );
  await tab.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
  });
  // Let every colour transition the style switch started settle (a read taken mid-transition shows the previous mode's colours).
  await tab.waitForTimeout(500);
  return { tab, close: async () => await context.close() };
};

/** Everything the two kits claim, as computed values. */
const READ = `(() => {
  const q = (selector) => document.querySelector(selector);
  const cs = (el, pseudo) => (el ? getComputedStyle(el, pseudo) : null);
  const root = getComputedStyle(document.documentElement);
  const token = (name) => root.getPropertyValue(name).trim();
  const body = cs(document.body);
  const spinner = q('[data-probe="spinner"] svg');
  const part = (n) => cs(q('[data-probe="spinner"] .fy-spinner__p' + n));
  const ring = cs(q('[data-probe="spinner"] .fy-spinner-ring'));
  const arc = cs(q('[data-probe="spinner"] .fy-spinner-arc'));
  const track = cs(q('[data-probe="spinner"] .fy-spinner-track'));
  const h1 = cs(q('.md h1'));
  const pre = cs(q('.md pre'));
  const quote = cs(q('.md blockquote'));
  const th = cs(q('.md th'));
  const td = cs(q('.md td'));
  const a = cs(q('.md a'));
  const li = cs(q('.md ul'));
  const btn = cs(q('.kt-btn:not([data-variant])'));
  const primary = cs(q('.kt-btn[data-variant="primary"]'));
  const field = cs(q('input.kt-input'));
  const insets = (shadow) => shadow.split(/,(?![^()]*\\))/).filter((layer) => /inset/.test(layer)).length;
  return {
    layers: body.backgroundImage.split(/,(?![^()]*\\))/).map((layer) => layer.trim()),
    bgSize: body.backgroundSize,
    grain: { image: cs(document.body, '::after').backgroundImage, opacity: cs(document.body, '::after').opacity, blend: cs(document.body, '::after').mixBlendMode },
    panelTexture: cs(q('.kt-panel')).backgroundImage,
    h1: { case: h1.textTransform, rule: h1.borderBottomWidth + ' ' + h1.borderBottomStyle, weight: h1.fontWeight, size: h1.fontSize, family: h1.fontFamily },
    pre: { radius: pre.borderTopLeftRadius, shadow: pre.boxShadow, border: pre.borderTopWidth + ' ' + pre.borderTopStyle },
    quote: { left: quote.borderLeftStyle + ' ' + quote.borderLeftWidth, bg: quote.backgroundColor !== 'rgba(0, 0, 0, 0)', pad: quote.paddingLeft },
    th: { case: th.textTransform, weight: th.fontWeight, bg: th.backgroundColor !== 'rgba(0, 0, 0, 0)' },
    td: { left: td.borderLeftStyle + ' ' + td.borderLeftWidth, bottom: td.borderBottomStyle + ' ' + td.borderBottomWidth },
    link: { decoration: a.textDecorationLine, weight: a.fontWeight, bg: a.backgroundColor !== 'rgba(0, 0, 0, 0)' },
    marker: li.listStyleType,
    button: { image: btn.backgroundImage, insets: insets(btn.boxShadow), radius: Number.parseFloat(btn.borderTopLeftRadius), height: Number.parseFloat(btn.height) },
    primary: { image: primary.backgroundImage, insets: insets(primary.boxShadow) },
    field: { image: field.backgroundImage, insets: insets(field.boxShadow) },
    spinner: {
      ring: ring.display,
      arc: arc.display,
      track: track.display,
      parts: [1, 2, 3, 4].map((n) => part(n).display),
      markAnimation: cs(spinner).animationName,
    },
    hm: { shape: token('--hm-shape'), edge: token('--hm-edge'), radius: token('--hm-radius'), stroke: token('--hm-stroke'), header: token('--hm-header'), fill: token('--hm-node-fill-alpha') },
    motion: { fast: token('--motion-fast'), base: token('--motion-base'), pop: token('--motion-pop'), press: token('--press-translate'), pick: token('--select-pop') },
    focusOffset: token('--focus-offset'),
    gradients: [...document.querySelectorAll('.kt-panel, .kt-panel__header, .kt-btn, .kt-input, .kt-badge')].filter((el) => /gradient/.test(getComputedStyle(el).backgroundImage)).length,
  };
})()`;

/** A custom property is read back as authored or as the browser normalises it (`120ms` or `.12s`): compare the time. */
const milliseconds = (value: string): number =>
  value.endsWith('ms') ? Number.parseFloat(value) : Math.round(Number.parseFloat(value) * 1_000);

type Read = {
  layers: string[];
  bgSize: string;
  grain: { image: string; opacity: string; blend: string };
  panelTexture: string;
  h1: { case: string; rule: string; weight: string; size: string; family: string };
  pre: { radius: string; shadow: string; border: string };
  quote: { left: string; bg: boolean; pad: string };
  th: { case: string; weight: string; bg: boolean };
  td: { left: string; bottom: string };
  link: { decoration: string; weight: string; bg: boolean };
  marker: string;
  button: { image: string; insets: number; radius: number; height: number };
  primary: { image: string; insets: number };
  field: { image: string; insets: number };
  spinner: { ring: string; arc: string; track: string; parts: string[]; markAnimation: string };
  hm: { shape: string; edge: string; radius: string; stroke: string; header: string; fill: string };
  motion: { fast: string; base: string; pop: string; press: string; pick: string };
  focusOffset: string;
  gradients: number;
};

for (const style of ['lucid', 'briefing'] as const)
  for (const viewport of VIEWPORTS)
    for (const mode of MODES)
      describe(`the ${style} kit at ${viewport.name} in ${mode}`, () => {
        it('fills every slot of the component style contract with its own idiom', async () => {
          const { tab, close } = await open(viewport, mode, style);
          try {
            const read = (await tab.evaluate(READ)) as Read;
            report[`${style}:${viewport.name}:${mode}`] = read;
            // No gradient on any surface; no panel texture. (The page's first layer may be the contract's pattern TILE.)
            expect(read.gradients, 'no gradient on a panel, header, button, field or badge').toBe(0);
            expect(read.panelTexture).toBe('none');
            // The focus ring is drawn inside the control (a negative offset), so no ancestor can clip it.
            expect(read.focusOffset).toMatch(/^calc\(-1 \* /u);
            expect(read.pre.radius, 'a code block is at most 16px').toMatch(/^(\d|1[0-6])(\.\d+)?px$/u);
            if (style === 'lucid') {
              // BACKGROUND: a fine horizontal pinstripe, one 4px tile; nothing else is a gradient layer; no grain.
              expect(read.layers[0], 'the first layer is the pinstripe tile').toMatch(/linear-gradient\(/u);
              expect(read.bgSize.split(',')[0]).toBe('4px 4px');
              expect(read.layers.slice(1).filter(layer => /gradient\(/u.test(layer))).toEqual([]);
              expect(Number(read.grain.opacity), 'no grain').toBe(0);
              // CONTROLS: lit by inset shadows (a bright line, a deeper lower half), never by a gradient.
              expect(read.button.image).toBe('none');
              expect(read.button.insets, 'a quiet button is lit by at least two inset shadows').toBeGreaterThanOrEqual(
                2,
              );
              expect(read.button.radius, 'a capsule').toBeGreaterThanOrEqual(read.button.height / 2 - 1);
              expect(read.primary.image).toBe('none');
              expect(read.primary.insets).toBeGreaterThanOrEqual(2);
              expect(read.field.image).toBe('none');
              expect(read.field.insets, 'a recessed well').toBeGreaterThanOrEqual(2);
              // MOTION: springy.
              expect(milliseconds(read.motion.base)).toBe(240);
              expect(milliseconds(read.motion.pop)).toBe(220);
              expect(read.motion.press).toBe('1px');
              expect(Number(read.motion.pick)).toBeGreaterThan(1.05);
              // HYPERMEDIA slots: shaped, glassy.
              expect(read.hm.shape).toBe('shaped');
              expect(read.hm.edge).toBe('curve');
              expect(read.hm.header).toBe('band');
              expect(read.hm.radius).toBe('14px');
              expect(Number(read.hm.fill)).toBeCloseTo(0.95, 2);
              // MARKDOWN: a window sheet. A ruled h1; a recessed code well; a tinted quote block (no bar); a striped table; tag links.
              expect(read.h1.rule).toBe('1px solid');
              expect(read.h1.weight).toBe('700');
              expect(read.pre.radius).toBe('12px');
              expect(read.pre.shadow, 'a recessed well').toMatch(/inset/u);
              expect(read.quote.left, 'no side bar').toBe('none 0px');
              expect(read.quote.bg, 'a tinted block instead').toBe(true);
              expect(read.td.left, 'rules only, no grid').toBe('none 0px');
              expect(read.td.bottom).toBe('solid 1px');
              expect(read.link.bg, 'a tag behind a link').toBe(true);
              expect(read.link.decoration).toBe('none');
              expect(read.link.weight).toBe('600');
              // SPINNER: the rail (track) stays, the arc goes; a bead and its droplet are the two parts.
              expect(read.spinner.ring).toBe('inline');
              expect(read.spinner.arc).toBe('none');
              expect(read.spinner.track).toBe('inline');
              expect(read.spinner.parts).toEqual(['inline', 'inline', 'none', 'none']);
              expect(read.spinner.markAnimation).toBe('fy-spinner-turn');
            } else {
              // BACKGROUND: paper. No pattern, no wash; fine grain over the page (a data URI, no request).
              expect(read.layers.filter(layer => layer !== 'none')).toEqual([]);
              expect(read.grain.image).toMatch(/^url\("data:image\/svg\+xml/u);
              expect(Number(read.grain.opacity), 'a visible but faint grain').toBeGreaterThan(0.02);
              expect(Number(read.grain.opacity)).toBeLessThanOrEqual(0.08);
              expect(read.grain.blend).toBe(mode === 'light' ? 'multiply' : 'screen');
              // TYPE: Gelasio serif headings over the thin Poppins body.
              expect(read.h1.family).toMatch(/^Gelasio/u);
              expect(read.h1.weight).toBe('700');
              // MOTION: calm and eased; nothing presses, nothing pops.
              expect(milliseconds(read.motion.base)).toBe(320);
              expect(milliseconds(read.motion.pop)).toBe(260);
              expect(read.motion.press).toBe('0px');
              expect(Number(read.motion.pick)).toBeCloseTo(1.02, 2);
              // HYPERMEDIA slots: ink on paper.
              expect(read.hm.shape).toBe('ink');
              expect(read.hm.edge).toBe('straight');
              expect(read.hm.header).toBe('label');
              expect(read.hm.radius).toBe('2px');
              expect(read.hm.stroke).toBe('1px');
              expect(Number(read.hm.fill)).toBe(0);
              // MARKDOWN: a printed page. A double rule under h1; a ruled box for code; a pull-quote block (no bar); a ledger
              // (rules between rows, none between columns) under an uppercase header; bold underlined links; square bullets.
              expect(read.h1.rule).toBe('3px double');
              expect(read.pre.border).toBe('1px solid');
              expect(read.pre.radius).toBe('4px');
              expect(read.quote.left, 'no side bar').toBe('none 0px');
              expect(read.quote.bg).toBe(true);
              expect(read.td.left, 'a ledger: no column rules').toBe('none 0px');
              expect(read.td.bottom).toBe('solid 1px');
              expect(read.th.case).toBe('uppercase');
              expect(read.link.decoration).toBe('underline');
              expect(read.link.weight).toBe('600');
              expect(read.marker).toBe('square');
              // SPINNER: the ring is hidden; four lines of text (parts) are written one after another.
              expect(read.spinner.ring).toBe('none');
              expect(read.spinner.parts).toEqual(['inline', 'inline', 'inline', 'inline']);
              expect(read.spinner.markAnimation).toBe('none');
            }
          } finally {
            await close();
          }
        });
      });

/**
 * The pattern and the grain are really PAINTED, not only declared: with the specimen's own opaque page cover taken off, a 100 x 100
 * corner of the page screenshot holds Lucid's pinstripe (rows of two alternating levels, period 4px) and Briefing's grain (many
 * levels, a stable mean, no pattern period).
 */
describe('the field is painted as declared', () => {
  for (const style of ['lucid', 'briefing'] as const)
    for (const mode of MODES)
      it(`${style} in ${mode}`, async () => {
        const { tab, close } = await open(VIEWPORTS[0], mode, style);
        try {
          await tab.addStyleTag({
            content:
              '[data-specimen] { background: transparent !important; } [data-specimen] * { visibility: hidden !important; }',
          });
          const png = (await tab.screenshot({ clip: { x: 0, y: 0, width: 100, height: 100 }, type: 'png' })).toString(
            'base64',
          );
          const painted = (await tab.evaluate(async (data: string) => {
            const bitmap = await createImageBitmap(
              new Blob([Uint8Array.from(atob(data), c => c.charCodeAt(0))], { type: 'image/png' }),
            );
            const canvas = document.createElement('canvas');
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            const g = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
            g.drawImage(bitmap, 0, 0);
            const d = g.getImageData(0, 0, bitmap.width, bitmap.height).data;
            const scale = bitmap.width / 100;
            const lum = (x: number, y: number): number => {
              const i = (Math.round(y * scale) * bitmap.width + Math.round(x * scale)) * 4;
              return (d[i] ?? 0) + (d[i + 1] ?? 0) + (d[i + 2] ?? 0);
            };
            const levels = new Set<number>();
            for (let y = 0; y < 100; y += 1) for (let x = 0; x < 100; x += 1) levels.add(lum(x, y));
            // One column down the page: the pinstripe is a line every 4px, so row 0, 4, 8... share a level that rows 2, 6... do not.
            const column = Array.from({ length: 24 }, (_, row) => lum(50, row));
            const onLine = new Set(column.filter((_, row) => row % 4 === 0));
            const offLine = new Set(column.filter((_, row) => row % 4 === 2));
            // Grain: the variation between neighbouring pixels along one row.
            const row = Array.from({ length: 100 }, (_, x) => lum(x, 50));
            const steps = row.slice(1).filter((value, x) => value !== row[x]).length;
            return {
              distinct: levels.size,
              onLine: [...onLine],
              offLine: [...offLine],
              ground: lum(0, 2),
              steps,
            };
          }, png)) as { distinct: number; onLine: number[]; offLine: number[]; ground: number; steps: number };
          report[`pattern:${style}:${mode}`] = painted;
          if (style === 'lucid') {
            expect(painted.onLine.length, 'every 4th row paints one level').toBe(1);
            expect(painted.offLine.length, 'and the rows between paint another').toBe(1);
            expect(painted.onLine[0], 'a visible stripe').not.toBe(painted.offLine[0]);
            expect(Math.abs((painted.onLine[0] as number) - (painted.offLine[0] as number))).toBeLessThanOrEqual(150);
          } else {
            expect(painted.distinct, 'grain: several levels over one ground').toBeGreaterThanOrEqual(4);
            expect(painted.steps, 'a different level between most neighbours along a row').toBeGreaterThan(30);
          }
        } finally {
          await close();
        }
      });
});

/**
 * THE SPINNERS ARE REALLY MOVING (the STYLE KITS rule). The computed values above are DECLARATIONS: forcing
 * `animation-name: none !important` on the mark left every one of them passing. These read what the engine is DOING: the live
 * CSS animations on the mark and its parts (name, delay, duration, iterations), then every one paused at the same fixed times
 * and the mark's rotation (from its computed matrix) and each part's scale and opacity read back. Each test also runs with
 * `animation-name: none` injected and proves its own expectation throws.
 */
interface MarkRead {
  readonly active: readonly {
    readonly target: string;
    readonly name: string;
    readonly state: string;
    readonly delay: number;
    readonly duration: number;
    readonly iterations: string;
  }[];
  /** The mark's rotation in degrees at each sample time (0..360). */
  readonly angle: readonly number[];
  readonly markOpacity: readonly number[];
  /** Each part's opacity and horizontal scale at each sample time. */
  readonly opacity: Readonly<Record<string, readonly number[]>>;
  readonly scale: Readonly<Record<string, readonly number[]>>;
  /** Each part's computed display and its box (x, y, width, height) at rest (time 0). */
  readonly display: readonly string[];
  readonly box: Readonly<Record<string, readonly number[]>>;
}

const KILL_ANIMATIONS =
  ".fy-spinner.fy-spinner.fy-spinner, .fy-spinner.fy-spinner [class*='fy-spinner__p'] { animation-name: none !important; }";

const readMark = (tab: Page, selector: string, times: readonly number[], disable: boolean): Promise<MarkRead> =>
  tab.evaluate(
    ([target, sampleAt, kill, css]) => {
      let injected: HTMLStyleElement | undefined;
      if (kill) {
        injected = document.createElement('style');
        injected.textContent = css as string;
        document.head.append(injected);
      }
      const svg = document.querySelector(target as string) as SVGElement;
      const parts = [1, 2, 3, 4].map(n => svg.querySelector(`.fy-spinner__p${n}`) as SVGElement);
      const owned = document.getAnimations().filter(animation => {
        const element = (animation.effect as KeyframeEffect).target as Element;
        return animation instanceof CSSAnimation && (element === svg || svg.contains(element));
      });
      const label = (element: Element): string =>
        element === svg ? 'mark' : `p${parts.indexOf(element as SVGElement) + 1}`;
      const active = owned.map(animation => {
        const timing = animation.effect?.getTiming();
        return {
          target: label((animation.effect as KeyframeEffect).target as Element),
          name: (animation as Animation & { animationName?: string }).animationName ?? 'none',
          state: animation.playState,
          delay: Number(timing?.delay ?? -1),
          duration: Number(timing?.duration ?? -1),
          iterations: String(timing?.iterations ?? 'none'),
        };
      });
      const matrix = (transform: string): number[] => {
        if (transform === 'none') return [1, 0, 0, 1, 0, 0];
        const m = /matrix\(([^)]+)\)/u.exec(transform);
        return (m?.[1] ?? '1,0,0,1,0,0').split(',').map(Number);
      };
      const angle: number[] = [];
      const markOpacity: number[] = [];
      const opacity: Record<string, number[]> = { p1: [], p2: [], p3: [], p4: [] };
      const scale: Record<string, number[]> = { p1: [], p2: [], p3: [], p4: [] };
      const box: Record<string, number[]> = {};
      for (const [slot, time] of (sampleAt as readonly number[]).entries()) {
        for (const animation of owned) {
          animation.pause();
          animation.currentTime = time;
        }
        const [a = 1, b = 0] = matrix(getComputedStyle(svg).transform);
        angle.push(((((Math.atan2(b, a) * 180) / Math.PI) % 360) + 360) % 360);
        markOpacity.push(Number.parseFloat(getComputedStyle(svg).opacity));
        for (const [index, part] of parts.entries()) {
          opacity[`p${index + 1}`]?.push(Number.parseFloat(getComputedStyle(part).opacity));
          scale[`p${index + 1}`]?.push(matrix(getComputedStyle(part).transform)[0] ?? 1);
          if (slot === 0) {
            const cs = getComputedStyle(part);
            box[`p${index + 1}`] = [cs.x, cs.y, cs.width, cs.height].map(v => Number.parseFloat(v));
          }
        }
      }
      for (const animation of owned) animation.play();
      const display = parts.map(part => getComputedStyle(part).display);
      injected?.remove();
      return { active, angle, markOpacity, opacity, scale, display, box };
    },
    [selector, times, disable, KILL_ANIMATIONS] as const,
  );

const PROBE = '[data-probe="spinner"] svg';
const near = (actual: number | undefined, expected: number, digits = 1): void =>
  expect(actual ?? Number.NaN).toBeCloseTo(expected, digits);

// LUCID: the whole mark turns once in 1200ms on `ease-in-out` (cubic-bezier(.42,0,.58,1), symmetric: half the time is half the turn),
// and the bead squashes 1 -> 1.35 -> 1 over the same 1200ms (`ease-in-out` on each half: the quarter marks are the half-way values).
const LUCID_TIMES = [0, 300, 600, 900] as const;
const expectLucidRolling = (read: MarkRead): void => {
  const marks = read.active.filter(animation => animation.target === 'mark');
  expect(marks.length, 'the mark runs one turning animation').toBe(1);
  expect(marks[0]).toMatchObject({
    name: 'fy-spinner-turn',
    state: 'running',
    delay: 0,
    duration: 1_200,
    iterations: 'Infinity',
  });
  const bead = read.active.filter(animation => animation.target === 'p1');
  expect(bead.length, 'the bead squashes').toBe(1);
  expect(bead[0], 'the base stagger delay is reset, so the bead starts with the mark').toMatchObject({
    name: 'fy-lucid-bead',
    state: 'running',
    delay: 0,
    duration: 1_200,
    iterations: 'Infinity',
  });
  expect(
    read.active.filter(animation => animation.target !== 'mark' && animation.target !== 'p1'),
    'the droplet rides the mark: it animates nothing of its own',
  ).toEqual([]);
  near(read.angle[0], 0, 0);
  // ease-in-out at a quarter of the time is ~0.129 of the turn (46.5deg), at half time exactly half, at three quarters ~0.871 (313.5deg).
  expect(read.angle[1] ?? Number.NaN).toBeGreaterThan(40);
  expect(read.angle[1] ?? Number.NaN).toBeLessThan(55);
  near(read.angle[2], 180, 0);
  expect(read.angle[3] ?? Number.NaN).toBeGreaterThan(305);
  expect(read.angle[3] ?? Number.NaN).toBeLessThan(320);
  const squash = [1, 1.175, 1.35, 1.175];
  for (const [index, want] of squash.entries()) near(read.scale.p1?.[index], want, 2);
};

// BRIEFING: four lines are written (scaleX 0 -> 1 over the first 45% of 1600ms, held to 85%, faded to 0 by 100%), each
// starting 20% of the turn after the one above it (320ms steps: 0, 320, 640, 960). `fill-mode: backwards` holds a line at 0 until its
// turn. The sample times and the values they must read, per line, are computed from that.
const BRIEF_TIMES = [160, 480, 800, 1_200, 1_500] as const;
const BRIEF_SCALE = {
  // local time / 1600 / 0.45 while the line is still being written (linear), 1 once it is written (the grow ends at 45% of the loop)
  p1: [2 / 9, 6 / 9, 1, 1, 1],
  p2: [0, 2 / 9, 6 / 9, 1, 1],
  p3: [0, 0, 2 / 9, 7 / 9, 1],
  p4: [0, 0, 0, 3 / 9, 0.75],
} as const;
const BRIEF_OPACITY = {
  p1: [1, 1, 1, 1, 0.4167],
  p2: [1, 1, 1, 1, 1],
  p3: [1, 1, 1, 1, 1],
  p4: [1, 1, 1, 1, 1],
} as const;
const expectBriefingWriting = (read: MarkRead): void => {
  expect(
    read.active.filter(animation => animation.target === 'mark'),
    'the mark itself does not turn',
  ).toEqual([]);
  const parts = read.active.filter(animation => animation.target !== 'mark');
  expect(parts.map(animation => animation.target).sort()).toEqual(['p1', 'p2', 'p3', 'p4']);
  for (const [index, animation] of parts.sort((a, b) => a.target.localeCompare(b.target)).entries()) {
    expect(animation, `${animation.target}: running, one 1600ms loop`).toMatchObject({
      name: 'fy-brief-write',
      state: 'running',
      duration: 1_600,
      iterations: 'Infinity',
    });
    // The stagger is restated (the base shorthand resets it): line N starts (N-1) x 320ms in (a calc() leaves float dust).
    expect(animation.delay, `${animation.target}: line ${index + 1} starts ${index * 320}ms in`).toBeCloseTo(
      index * 320,
      3,
    );
  }
  for (const part of ['p1', 'p2', 'p3', 'p4'] as const)
    for (const [index, want] of BRIEF_SCALE[part].entries()) {
      near(read.scale[part]?.[index], want, 2);
      near(read.opacity[part]?.[index], BRIEF_OPACITY[part][index] ?? 1, 2);
    }
};

describe('the Lucid and Briefing spinners are really moving (live animations and phase, not declarations)', () => {
  for (const mode of MODES) {
    it(`Lucid in ${mode}: a glossy bead rolls round a rail, squashing as it goes`, async () => {
      const { tab, close } = await open(VIEWPORTS[0], mode, 'lucid');
      try {
        const live = await readMark(tab, PROBE, LUCID_TIMES, false);
        report[`motion:lucid:${mode}`] = live;
        expect(live.display).toEqual(['inline', 'inline', 'none', 'none']);
        expectLucidRolling(live);
        // The droplet trails the bead: smaller, and counter-clockwise of it (left of the top of the rail).
        const [bx, by, bw] = live.box.p1 as number[];
        const [dx, dy, dw] = live.box.p2 as number[];
        expect(dw as number, 'the droplet is smaller than the bead').toBeLessThan(bw as number);
        expect((dx as number) + (dw as number) / 2, 'and sits behind it').toBeLessThan(
          (bx as number) + (bw as number) / 2,
        );
        expect(dy as number, 'and lower on the rail').toBeGreaterThan(by as number);
        const dead = await readMark(tab, PROBE, LUCID_TIMES, true);
        expect(dead.active, 'animation-name: none stops every animation').toEqual([]);
        expect(() => expectLucidRolling(dead), 'the assert fails when the mark does not move').toThrow();
      } finally {
        await close();
      }
    });

    it(`Briefing in ${mode}: four lines of text are written one after another`, async () => {
      const { tab, close } = await open(VIEWPORTS[0], mode, 'briefing');
      try {
        const live = await readMark(tab, PROBE, BRIEF_TIMES, false);
        report[`motion:briefing:${mode}`] = live;
        expect(live.display).toEqual(['inline', 'inline', 'inline', 'inline']);
        expectBriefingWriting(live);
        // Four lines, stacked: each below the one above; the last is the short one.
        const [, y1, w1] = live.box.p1 as number[];
        const [, y2, w2] = live.box.p2 as number[];
        const [, y3] = live.box.p3 as number[];
        const [, y4, w4] = live.box.p4 as number[];
        expect(y1 as number).toBeLessThan(y2 as number);
        expect(y2 as number).toBeLessThan(y3 as number);
        expect(y3 as number).toBeLessThan(y4 as number);
        expect(w1).toBe(w2);
        expect(w4 as number, 'the last line is short, like a paragraph end').toBeLessThan(w1 as number);
        const dead = await readMark(tab, PROBE, BRIEF_TIMES, true);
        expect(dead.active).toEqual([]);
        expect(() => expectBriefingWriting(dead), 'the assert fails when the mark does not move').toThrow();
      } finally {
        await close();
      }
    });

    for (const style of ['lucid', 'briefing'] as const)
      it(`${style} in ${mode}, reduced motion: the mark pulses in place and no part moves`, async () => {
        const { tab, close } = await open(VIEWPORTS[0], mode, style);
        try {
          await tab.emulateMedia({ reducedMotion: 'reduce' });
          const expectPulse = (read: MarkRead): void => {
            expect(read.active.map(animation => `${animation.target}:${animation.name}`)).toEqual([
              'mark:fy-spinner-pulse',
            ]);
            near(read.markOpacity[0], 1, 2);
            near(read.markOpacity[1], 0.72, 2);
            near(read.markOpacity[2], 1, 2);
            for (const part of ['p1', 'p2']) {
              expect(read.opacity[part], `${part} stays drawn`).toEqual(
                [1, 1, 1].map((v, i) => (part === 'p2' && style === 'lucid' ? (read.opacity[part]?.[i] ?? v) : v)),
              );
              expect(read.scale[part], `${part} stays at rest`).toEqual([1, 1, 1]);
            }
          };
          const live = await readMark(tab, PROBE, [0, 800, 1_600], false);
          report[`motion:${style}-reduced:${mode}`] = live;
          expectPulse(live);
          const dead = await readMark(tab, PROBE, [0, 800, 1_600], true);
          expect(() => expectPulse(dead), 'the assert fails when the mark does not pulse').toThrow();
        } finally {
          await close();
        }
      });
  }
});

/**
 * A swatch draws ITS OWN style's mark, whatever the page is wearing. Every page style x every swatch style, each swatch's mark
 * read back whole (ring, parts, and the live animations by target:name:duration).
 */
const SIGNATURE = {
  studio: { ring: 'inline', parts: ['none', 'none', 'none', 'none'], animations: ['mark:fy-spinner-turn:900'] },
  mission: {
    ring: 'none',
    parts: ['inline', 'inline', 'inline', 'inline'],
    animations: ['mark:fy-spinner-turn:2400'],
  },
  neo: {
    ring: 'none',
    parts: ['inline', 'inline', 'none', 'none'],
    animations: ['p1:fy-neo-hop:800', 'p2:fy-neo-hop:800'],
  },
  lucid: {
    ring: 'inline',
    parts: ['inline', 'inline', 'none', 'none'],
    animations: ['mark:fy-spinner-turn:1200', 'p1:fy-lucid-bead:1200'],
  },
  briefing: {
    ring: 'none',
    parts: ['inline', 'inline', 'inline', 'inline'],
    animations: [
      'p1:fy-brief-write:1600',
      'p2:fy-brief-write:1600',
      'p3:fy-brief-write:1600',
      'p4:fy-brief-write:1600',
    ],
  },
} as const;
type SwatchId = keyof typeof SIGNATURE;

describe('a swatch draws its own style’s spinner, on a page of any style', () => {
  for (const pageStyle of ['studio', 'lucid', 'briefing', 'neo'] as const)
    it(`on a ${pageStyle} page: Studio, Mission, Neo, Lucid and Briefing swatches each keep their own mark`, async () => {
      const { tab, close } = await open(VIEWPORTS[0], 'light', pageStyle);
      try {
        const source = await tab.evaluate(selector => (document.querySelector(selector) as Element).outerHTML, PROBE);
        for (const swatch of Object.keys(SIGNATURE) as SwatchId[]) {
          const selector = `[data-swatch][data-style="${swatch}"] svg`;
          await tab.evaluate(
            ([style, markup]) => {
              const holder = document.createElement('div');
              holder.setAttribute('data-swatch', '');
              holder.setAttribute('data-style', style as string);
              holder.setAttribute('data-palette', 'studio');
              holder.setAttribute('data-mode', 'light');
              holder.innerHTML = markup as string;
              document.body.append(holder);
            },
            [swatch, source] as const,
          );
          const read = await readMark(tab, selector, [0], false);
          const got = read.active
            .map(animation => `${animation.target}:${animation.name}:${animation.duration}`)
            .sort();
          const ring = await tab.evaluate(
            sel => getComputedStyle(document.querySelector(`${sel} .fy-spinner-ring`) as Element).display,
            selector,
          );
          report[`swatch:${pageStyle}:${swatch}`] = { ring, parts: read.display, animations: got };
          const want = SIGNATURE[swatch];
          expect(ring, `${swatch} swatch on a ${pageStyle} page: ring`).toBe(want.ring);
          expect(read.display, `${swatch} swatch on a ${pageStyle} page: parts`).toEqual(want.parts);
          expect(got, `${swatch} swatch on a ${pageStyle} page: live animations`).toEqual([...want.animations].sort());
          await tab.evaluate(sel => document.querySelector(sel)?.parentElement?.remove(), selector);
        }
      } finally {
        await close();
      }
    });
});

/**
 * THE CONTROLS, page x swatch (T6 review, "every NEW page rule, not only spinner"). One set of real controls (quiet and primary
 * button, badge, field, a selected choice card with its tick, a segmented control, a panel header, striped rows, a label) is
 * mounted in a `[data-swatch]` and read back as computed values. A Studio swatch on a Lucid or Briefing page must read exactly as
 * on a Studio page (the page's rules stop at the swatch boundary), and a Lucid or Briefing swatch must read exactly as on its own
 * page (the swatch twin of every rule exists) wherever it sits.
 */
const CONTROLS = `<div data-ctl style="padding:16px;display:grid;gap:12px;width:420px">
  <button class="kt-btn" data-c="quiet" type="button">Quiet</button>
  <button class="kt-btn" data-c="primary" data-variant="primary" type="button">Primary</button>
  <button class="kt-btn" data-c="ghost" data-variant="ghost" type="button">Ghost</button>
  <span class="kt-badge" data-c="badge">Badge</span>
  <input class="kt-input" data-c="input" value="field" aria-label="field" />
  <div class="fy-cc"><div class="fy-cc__grid">
    <label class="fy-cc__card" data-c="card" data-selected="true"><span class="fy-cc__check" data-c="tick">v</span><span class="fy-cc__title" data-c="title">Title</span><span class="fy-cc__line" data-c="line">line</span></label>
    <label class="fy-cc__card" data-c="card-off"><span class="fy-cc__title">Other</span></label>
  </div></div>
  <div role="radiogroup" data-neo-segmented="" data-c="seg" aria-label="seg" class="relative flex gap-1 rounded-control bg-surface-2 p-1">
    <label data-c="seg-on" class="flex rounded-tab px-3 py-1 border border-transparent bg-accent-soft font-semibold text-accent"><input type="radio" class="sr-only" checked name="seg" />One</label>
    <label data-c="seg-off" class="flex rounded-tab px-3 py-1 border border-transparent text-muted"><input type="radio" class="sr-only" name="seg" />Two</label>
  </div>
  <div class="kt-panel" data-c="panel"><div class="kt-panel__header" data-c="header"><span class="kt-label" data-c="label">Head</span></div>
    <div class="kt-row" data-c="row1">first</div><div class="kt-row" data-c="row2">second</div></div>
  <ul class="md" style="margin:0"><li data-c="md-li">item</li></ul>
</div>`;

const CONTROLS_READ = `((scope) => {
  const props = ['backgroundColor', 'backgroundImage', 'boxShadow', 'textShadow', 'borderTopWidth', 'borderTopStyle', 'borderTopColor', 'borderLeftWidth', 'borderTopLeftRadius', 'fontFamily', 'fontWeight', 'textTransform', 'letterSpacing', 'color', 'translate', 'transform', 'outlineStyle', 'outlineOffset', 'display', 'paddingLeft'];
  const out = {};
  for (const el of scope.querySelectorAll('[data-c]')) {
    const c = getComputedStyle(el);
    out[el.getAttribute('data-c')] = Object.fromEntries(props.map((p) => [p, c[p]]));
  }
  for (const [name, pseudo] of [['label-before', '::before'], ['header-before', '::before']]) {
    const el = scope.querySelector(name === 'label-before' ? '[data-c="label"]' : '[data-c="header"]');
    const c = getComputedStyle(el, pseudo);
    out[name] = { content: c.content, display: c.display, width: c.width, backgroundColor: c.backgroundColor };
  }
  return out;
})`;

type Controls = Record<string, Record<string, string>>;

/** The controls inside a swatch (`style` on `palette`, same mode as the page) mounted on a page of `page`. */
const readControls = async (
  viewport: (typeof VIEWPORTS)[number],
  mode: 'light' | 'dark',
  page: PageStyle,
  swatch: PageStyle,
): Promise<Controls> => {
  const { tab, close } = await open(viewport, mode, page, DEFAULT_PALETTE[swatch]);
  try {
    await tab.evaluate(
      ([style, palette, m, markup]) => {
        const holder = document.createElement('div');
        holder.id = 'swatch-controls';
        holder.setAttribute('data-swatch', '');
        holder.setAttribute('data-style', style as string);
        holder.setAttribute('data-palette', palette as string);
        holder.setAttribute('data-mode', m as string);
        holder.style.cssText = 'background:var(--bg);color:var(--fg);font-family:var(--font-body)';
        holder.innerHTML = markup as string;
        document.body.append(holder);
      },
      [swatch, DEFAULT_PALETTE[swatch], mode, CONTROLS] as const,
    );
    await tab.waitForTimeout(500);
    return (await tab.evaluate(`${CONTROLS_READ}(document.querySelector('#swatch-controls'))`)) as Controls;
  } finally {
    await close();
  }
};

const differing = (a: Controls, b: Controls): string[] =>
  Object.keys(a).flatMap(name =>
    Object.keys(a[name] ?? {})
      .filter(prop => a[name]?.[prop] !== b[name]?.[prop])
      .map(prop => `${name}.${prop}: ${a[name]?.[prop]} <> ${b[name]?.[prop]}`),
  );

describe('the page rules of Lucid and Briefing stop at a swatch boundary, and a swatch of either paints the same anywhere', () => {
  for (const style of ['lucid', 'briefing'] as const)
    for (const mode of MODES) {
      it(`on a ${style} page (${mode}): a Studio swatch's controls read exactly as on a Studio page`, async () => {
        const home = await readControls(VIEWPORTS[0], mode, 'studio', 'studio');
        const mixed = await readControls(VIEWPORTS[0], mode, style, 'studio');
        report[`swatch-controls:studio-on-${style}:${mode}`] = { diff: differing(home, mixed) };
        expect(differing(home, mixed), `a Studio swatch on a ${style} page`).toEqual([]);
      });

      it(`a ${style} swatch (${mode}) paints the same on a Studio page as on its own page, and is not Studio's look`, async () => {
        const own = await readControls(VIEWPORTS[0], mode, style, style);
        const onStudio = await readControls(VIEWPORTS[0], mode, 'studio', style);
        const plain = await readControls(VIEWPORTS[0], mode, 'studio', 'studio');
        expect(differing(own, onStudio), `a ${style} swatch on a Studio page`).toEqual([]);
        // The swatch really draws the style: the controls Studio draws one way are drawn another.
        const unlike = ['quiet', 'primary', 'badge', 'input', 'card', 'seg-on', 'header', 'row2'].filter(name =>
          Object.keys(own[name] ?? {}).some(prop => own[name]?.[prop] !== plain[name]?.[prop]),
        );
        expect(unlike, `controls a ${style} swatch draws differently from Studio`).toEqual([
          'quiet',
          'primary',
          'badge',
          'input',
          'card',
          'seg-on',
          'header',
          'row2',
        ]);
      });
    }

  it('on a Lucid page, a Briefing swatch and a Lucid swatch each keep their own controls (a mixed pair both ways)', async () => {
    const briefOnBrief = await readControls(VIEWPORTS[0], 'light', 'briefing', 'briefing');
    const briefOnLucid = await readControls(VIEWPORTS[0], 'light', 'lucid', 'briefing');
    const lucidOnLucid = await readControls(VIEWPORTS[0], 'light', 'lucid', 'lucid');
    const lucidOnBrief = await readControls(VIEWPORTS[0], 'light', 'briefing', 'lucid');
    expect(differing(briefOnBrief, briefOnLucid)).toEqual([]);
    expect(differing(lucidOnLucid, lucidOnBrief)).toEqual([]);
  });
});

/**
 * FILLED CONTROLS (the style-kit rule from the T7 review). A style that moves its focus ring INSIDE a filled control must keep the
 * ring >= 3:1 against that fill (a ring in the fill's own colour is 1:1 and invisible); the ring is drawn inside the control (never
 * clipped by an ancestor); the busy mark on a filled Send keeps the button's foreground; and none of it leaks into a `[data-swatch]`
 * preview of another style. Measured on the REAL composer Send (`.fy-composer-send`, the shipped chat stylesheet) and the REAL
 * selected Settings link, keyboard-focused, on EVERY palette in both modes.
 */
const FILLED_HOLDER = `<div data-filled-fix style="padding:16px;display:flex;gap:16px;align-items:center">
  <button class="fy-composer-send" data-fix="send" type="button">Send</button>
  <button class="fy-composer-send" data-fix="busy" data-sending type="button">__SPINNER__</button>
  <nav class="fy-settings-nav" style="width:200px"><a aria-current="page" class="fy-tab fy-tab--active" data-fix="nav" href="#fix-current">Selected</a></nav>
</div>`;

const FILLED_READ = `((scope) => {
  const tools = window.__colour;
  const holder = scope.querySelector('[data-filled-fix]');
  const sel = (n) => holder.querySelector('[data-fix="' + n + '"]');
  const ringOf = (el) => {
    el.focus();
    const c = getComputedStyle(el);
    const fill = tools.backdrop(el);
    const ring = tools.rgba(c.outlineColor);
    const composed = tools.over(ring, [...fill, 1]);
    return {
      focusVisible: el.matches(':focus-visible'),
      style: c.outlineStyle, width: parseFloat(c.outlineWidth), offset: parseFloat(c.outlineOffset),
      ringColour: c.outlineColor, fillColour: 'rgb(' + fill.map(Math.round).join(',') + ')',
      ratio: tools.ratio(composed, fill),
      background: c.backgroundColor, shadow: c.boxShadow,
    };
  };
  const send = ringOf(sel('send'));
  const nav = ringOf(sel('nav'));
  sel('nav').blur(); sel('send').blur();
  const busyButton = sel('busy');
  const fill = tools.backdrop(busyButton);
  const marks = [...busyButton.querySelectorAll('[class*="fy-spinner__p"]')]
    .filter(el => getComputedStyle(el).display !== 'none')
    .map(el => {
      const c = getComputedStyle(el);
      const paint = c.fill !== 'none' && tools.rgba(c.fill)[3] > 0 ? c.fill : c.stroke;
      return { part: el.getAttribute('class'), paint, ratio: tools.ratio(tools.over(tools.rgba(paint), [...fill, 1]), fill) };
    });
  return { send, nav, busy: { fill: 'rgb(' + fill.map(Math.round).join(',') + ')', marks } };
})`;

const mountFilled = async (tab: Page, scope: string): Promise<void> => {
  await tab.evaluate(COLOUR_TOOLS);
  const spinner = await tab.evaluate(
    selector =>
      (document.querySelector(selector) as Element).outerHTML.replace(
        'class="fy-spinner',
        'class="fy-spinner fy-spinner--on-accent',
      ),
    PROBE,
  );
  await tab.evaluate(
    ([where, template, mark]) => {
      const parent = document.querySelector(where as string) as Element;
      const holder = document.createElement('div');
      holder.innerHTML = (template as string).replace('__SPINNER__', mark as string);
      parent.append(holder.firstElementChild as Element);
    },
    [scope, FILLED_HOLDER, spinner] as const,
  );
};

interface Stop {
  ratio: number;
  focusVisible: boolean;
  offset: number;
  width: number;
  [field: string]: unknown;
}
interface FilledRead {
  send: Stop;
  nav: Stop;
  busy: { fill: string; marks: { part: string; paint: string; ratio: number }[] };
}
const readFilled = async (tab: Page, scope: string): Promise<FilledRead> => {
  await tab.keyboard.press('Tab'); // a real key press, so a script focus() draws :focus-visible
  return (await tab.evaluate(`${FILLED_READ}(document.querySelector(${JSON.stringify(scope)}))`)) as FilledRead;
};

const EVERY_PALETTE = ['studio', 'geist', 'mission', 'neo', 'hacker', 'vintage', 'vaporwave', 'contrast'] as const;

describe('a style that moves its focus ring inside a filled control keeps the ring and the busy mark visible', () => {
  for (const style of ['lucid', 'briefing'] as const)
    for (const mode of MODES)
      it(`${style} in ${mode}: on every palette, keyboard focus on Send and the selected Settings link is >= 3:1 on its fill, drawn inside; the busy mark keeps the button's ink`, async () => {
        const { tab, close } = await open(VIEWPORTS[0], mode, style);
        try {
          await mountFilled(tab, 'body');
          const failures: string[] = [];
          for (const palette of EVERY_PALETTE) {
            await tab.evaluate(p => document.documentElement.setAttribute('data-palette', p), palette);
            await tab.waitForTimeout(450);
            const read = await readFilled(tab, 'body');
            report[`filled:${style}:${palette}:${mode}`] = read;
            for (const [name, stop] of [
              ['Send', read.send],
              ['selected Settings link', read.nav],
            ] as const) {
              if (!stop.focusVisible) failures.push(`${palette} ${name}: no :focus-visible`);
              if (stop.ratio < 3) failures.push(`${palette} ${name}: ring ${stop.ratio.toFixed(2)}:1 on its fill`);
              if (stop.offset > -stop.width + 0.001)
                failures.push(
                  `${palette} ${name}: ring offset ${stop.offset} is outside the box (width ${stop.width})`,
                );
            }
            if (read.busy.marks.length === 0) failures.push(`${palette}: the busy mark draws no parts`);
            for (const mark of read.busy.marks)
              if (mark.ratio < 3)
                failures.push(`${palette} busy ${mark.part}: ${mark.ratio.toFixed(2)}:1 on the Send fill`);
            await tab.keyboard.press('Escape');
            await tab.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
          }
          expect(failures).toEqual([]);
        } finally {
          await close();
        }
      });
});

describe('the filled-control rules do not leak into a swatch of another style', () => {
  for (const pageStyle of ['lucid', 'briefing'] as const)
    for (const mode of MODES)
      it(`on a ${pageStyle} page (${mode}): a Studio swatch's Send, busy mark and selected link paint exactly as on a Studio page`, async () => {
        const reads: Record<string, FilledRead> = {};
        for (const page of ['studio', pageStyle] as const) {
          const { tab, close } = await open(VIEWPORTS[0], mode, page, 'studio');
          try {
            await tab.evaluate(() => {
              const holder = document.createElement('div');
              holder.id = 'swatch-fix';
              holder.setAttribute('data-swatch', '');
              holder.setAttribute('data-style', 'studio');
              holder.setAttribute('data-palette', 'studio');
              holder.setAttribute('data-mode', document.documentElement.getAttribute('data-mode') as string);
              holder.style.cssText = 'background:var(--bg);color:var(--fg)';
              document.body.append(holder);
            });
            await mountFilled(tab, '#swatch-fix');
            reads[page] = await readFilled(tab, '#swatch-fix');
          } finally {
            await close();
          }
        }
        report[`swatch-filled:${pageStyle}:${mode}`] = reads;
        const base = reads.studio as FilledRead;
        const mixed = reads[pageStyle] as FilledRead;
        for (const key of ['send', 'nav'] as const)
          for (const field of ['background', 'shadow', 'ringColour', 'offset', 'width'])
            expect(mixed[key][field], `${key}.${field} in a Studio swatch on a ${pageStyle} page`).toEqual(
              base[key][field],
            );
        expect(mixed.busy, 'the busy mark in a Studio swatch').toEqual(base.busy);
      });
});

/**
 * Optional: `FY_LUCID_BRIEFING_KIT_SHOTS=<dir>` writes the fake-data specimen (the theme matrix scene) of each style, 1280 + 390,
 * light + dark, on its default palette, plus a close crop of each spinner at four fixed times: the shots the PR's verdict reads.
 * Nothing is written otherwise.
 */
const shotsDirectory = process.env.FY_LUCID_BRIEFING_KIT_SHOTS ?? '';
describe.skipIf(shotsDirectory === '')('shots', () => {
  for (const style of ['studio', 'lucid', 'briefing'] as const)
    for (const viewport of VIEWPORTS)
      for (const mode of MODES)
        it(`${style} ${viewport.name} ${mode}`, async () => {
          const { tab, close } = await open(viewport, mode, style);
          try {
            await tab.screenshot({
              fullPage: false,
              path: join(shotsDirectory, `${style}-${viewport.name}-${mode}.png`),
            });
            if (viewport.name === '1280') {
              const handle = await tab.$(PROBE);
              await tab.evaluate(selector => {
                const svg = document.querySelector(selector) as SVGElement;
                svg.setAttribute('width', '96');
                svg.setAttribute('height', '96');
              }, PROBE);
              for (const time of [100, 400, 700, 1_000]) {
                await tab.evaluate(
                  ([selector, at]) => {
                    const svg = document.querySelector(selector as string) as SVGElement;
                    for (const animation of document.getAnimations()) {
                      const target = (animation.effect as KeyframeEffect).target as Element;
                      if (animation instanceof CSSAnimation && (target === svg || svg.contains(target))) {
                        animation.pause();
                        animation.currentTime = at as number;
                      }
                    }
                  },
                  [PROBE, time] as const,
                );
                await handle?.screenshot({ path: join(shotsDirectory, `spinner-${style}-${mode}-${time}.png`) });
              }
            }
          } finally {
            await close();
          }
        });
});
