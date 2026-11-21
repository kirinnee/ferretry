/**
 * THE RETRO + PIXEL STYLE KITS (r11 T10), measured in a real browser on the theme matrix's specimen page
 * (`plugins/conversation/tests/integration/app/fixtures/theme-matrix-scene.tsx`), each style on its DEFAULT palette (Retro: Blue,
 * the `geist` palette id; Pixel: Green, the `hacker` palette id), in both modes at 1280 and 390.
 *
 * The owner's line (turn 4247, item 12): "BG and grainy-ness can help with the style too -- and ... components too, including
 * how markdown looks", "make sure things like spinner, animation all are unique to their style", "design each style to change
 * the hyper media completely", and "most of them should not have gradient background". So each style fills every slot of the
 * component style contract with its own idiom, not with a padding tweak:
 *
 *   Retro = an early-2000s desktop. A dithered page (a 4px dot lattice, no wash, no grain); an etched (groove) rule under
 *           headings, a sunken (inset) code frame, a double-rule note, a full grid table with a raised header row; a spinner
 *           that is a SEGMENTED ring (twelve ticks, a three-tick arc) stepping one tick at a time; a window manager's quick,
 *           unbouncy motion and a 1px press; hypermedia as filled windows with a title band. No gradient on any button:
 *           the bevel is shadow, and the panel's title bar is the one gradient it keeps.
 *   Pixel = a bitmap interface. A pixel grid (1px rule every 8px); dashed (stepped) rules, a hard-inset code block, a dashed
 *           quote, a ruled grid table; a spinner of FOUR BLOCKS that light in turn, clockwise, in whole frames; stepped motion
 *           and a 2px press; hypermedia as hard `block` nodes on orthogonal edges.
 *
 * Set `FY_RETRO_PIXEL_KIT_REPORT=<file>` to write the measured numbers (JSON), the values the PR body quotes.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { type ColourTools, ringOf, sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const conversationScenes = resolve(packageRoot, '../../../plugins/conversation/tests/integration/app/fixtures');
const reportFile = process.env.FY_RETRO_PIXEL_KIT_REPORT ?? '';

const MODES = ['light', 'dark'] as const;
const VIEWPORTS = [
  { name: '1280', width: 1_280, phone: false },
  { name: '390', width: 390, phone: true },
] as const;
/** The palette each style is picked with (catalog.ts `defaultPalette`): Retro Blue, Pixel Green. */
const PALETTE = {
  retro: 'geist',
  pixel: 'hacker',
  studio: 'studio',
  mission: 'mission',
  hud: 'mission',
  geist: 'geist',
};

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;
const report: Record<string, unknown> = {};

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-retro-pixel-kit-'));
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

/** One style on its default palette, drawn with its real motion (a spinner's animation is read, not frozen). */
const open = async (
  viewport: (typeof VIEWPORTS)[number],
  mode: 'light' | 'dark',
  style: keyof typeof PALETTE,
  scale = 1,
): Promise<{ tab: Page; close: () => Promise<void> }> => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: 2_400 },
    colorScheme: mode,
    deviceScaleFactor: scale,
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
    [style, PALETTE[style], mode] as const,
  );
  await tab.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
  });
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
  const track = cs(q('[data-probe="spinner"] .fy-spinner-track'));
  const arc = cs(q('[data-probe="spinner"] .fy-spinner-arc'));
  const h1 = cs(q('.md h1'));
  const pre = cs(q('.md pre'));
  const quote = cs(q('.md blockquote'));
  const th = cs(q('.md th'));
  const td = cs(q('.md td'));
  const a = cs(q('.md a'));
  return {
    layers: body.backgroundImage.split(/,(?![^()]*\\))/).map((layer) => layer.trim()),
    bgSize: body.backgroundSize,
    bgRepeat: body.backgroundRepeat,
    grain: { opacity: cs(document.body, '::after').opacity },
    panelTexture: cs(q('.kt-panel')).backgroundImage,
    h1: { case: h1.textTransform, rule: h1.borderBottomWidth + ' ' + h1.borderBottomStyle, weight: h1.fontWeight },
    pre: { radius: pre.borderTopLeftRadius, shadow: pre.boxShadow !== 'none', border: pre.borderTopWidth + ' ' + pre.borderTopStyle },
    quote: { left: quote.borderLeftStyle + ' ' + quote.borderLeftWidth, bg: quote.backgroundColor !== 'rgba(0, 0, 0, 0)' },
    th: { case: th.textTransform, weight: th.fontWeight },
    td: { left: td.borderLeftStyle, bottom: td.borderBottomStyle },
    link: { decoration: a.textDecorationLine + ' ' + a.textDecorationStyle + ' ' + a.textDecorationThickness, weight: a.fontWeight },
    spinner: {
      animation: cs(spinner).animationName + ' ' + cs(spinner).animationDuration + ' ' + cs(spinner).animationTimingFunction,
      ring: ring.display,
      parts: [1, 2, 3, 4].map((n) => part(n).display),
      trackDash: track.strokeDasharray,
      arcDash: arc.strokeDasharray,
      p1Fill: part(1).fill,
    },
    hm: { shape: token('--hm-shape'), edge: token('--hm-edge'), radius: token('--hm-radius'), stroke: token('--hm-stroke'), header: token('--hm-header') },
    motion: { fast: token('--motion-fast'), base: token('--motion-base'), slow: token('--motion-slow'), ease: token('--ease-standard'), press: token('--press-translate') },
    gradients: [...document.querySelectorAll('.kt-panel, .kt-btn, .kt-input, .kt-badge')].filter((el) => /gradient/.test(getComputedStyle(el).backgroundImage)).length,
    titleBar: [...document.querySelectorAll('.kt-panel__header')].some((el) => /gradient/.test(getComputedStyle(el).backgroundImage)),
    panelEdge: token('--panel-edge'),
  };
})()`;

/** A custom property is read back as authored or as the browser normalises it (`120ms` or `.12s`): compare the time. */
const milliseconds = (value: string): number =>
  value.endsWith('ms') ? Number.parseFloat(value) : Math.round(Number.parseFloat(value) * 1_000);

type Read = {
  layers: string[];
  bgSize: string;
  bgRepeat: string;
  grain: { opacity: string };
  panelTexture: string;
  h1: { case: string; rule: string; weight: string };
  pre: { radius: string; shadow: boolean; border: string };
  quote: { left: string; bg: boolean };
  th: { case: string; weight: string };
  td: { left: string; bottom: string };
  link: { decoration: string; weight: string };
  spinner: {
    animation: string;
    ring: string;
    parts: string[];
    trackDash: string;
    arcDash: string;
    p1Fill: string;
  };
  hm: { shape: string; edge: string; radius: string; stroke: string; header: string };
  motion: { fast: string; base: string; slow: string; ease: string; press: string };
  gradients: number;
  titleBar: boolean;
  panelEdge: string;
};

for (const style of ['retro', 'pixel'] as const)
  for (const viewport of VIEWPORTS)
    for (const mode of MODES)
      describe(`the ${style} kit at ${viewport.name} in ${mode}`, () => {
        it('fills every slot of the component style contract with its own idiom', async () => {
          const { tab, close } = await open(viewport, mode, style);
          try {
            const read = (await tab.evaluate(READ)) as Read;
            report[`${style}:${viewport.name}:${mode}`] = read;
            // BACKGROUND: the contract's own tile is the first layer; no wash, no grain, no panel texture, no gradient on a control.
            expect(read.layers[0], 'the first layer is the style contract tile').toMatch(/gradient\(/u);
            expect(
              read.layers.slice(1).filter(layer => /gradient\(/u.test(layer)),
              'no wash under it',
            ).toEqual([]);
            expect(read.bgSize.split(',')[0]).toBe(style === 'retro' ? '4px 4px' : '8px 8px');
            expect(read.bgRepeat.split(',')[0]).toBe('repeat');
            expect(Number(read.grain.opacity), 'no grain').toBe(0);
            expect(read.panelTexture).toBe('none');
            expect(read.gradients, 'no gradient on a panel, button, field or badge').toBe(0);
            // MOTION.
            expect(read.motion.press).toBe(style === 'retro' ? '1px' : '2px');
            expect(milliseconds(read.motion.base)).toBe(style === 'retro' ? 110 : 150);
            expect(read.motion.ease).toBe(style === 'retro' ? 'cubic-bezier(0, 0, .2, 1)' : 'steps(3, end)');
            // HYPERMEDIA slots (read by r12 H5).
            expect(read.hm.shape).toBe(style === 'retro' ? 'shaped' : 'block');
            expect(read.hm.edge).toBe(style === 'retro' ? 'straight' : 'orthogonal');
            expect(read.hm.radius).toBe(style === 'retro' ? '3px' : '0px');
            expect(read.hm.stroke).toBe(style === 'retro' ? '1px' : '2px');
            expect(read.hm.header).toBe('band');
            expect(read.panelEdge).toBe(style === 'retro' ? 'bevel' : 'offset');
            // MARKDOWN.
            if (style === 'retro') {
              expect(read.titleBar, 'the title bar is the one gradient Retro keeps').toBe(true);
              expect(read.h1.rule, 'an etched rule').toBe('2px groove');
              expect(read.h1.case).toBe('none');
              expect(read.pre.border, 'a sunken code frame').toBe('2px inset');
              expect(read.pre.radius).toBe('2px');
              expect(read.quote.left, 'a double-rule note').toBe('double 4px');
              expect(read.quote.bg).toBe(true);
              expect(read.td.left, 'a full grid table').toBe('solid');
              expect(read.th.weight).toBe('700');
              expect(read.link.decoration).toContain('underline solid');
            } else {
              expect(read.titleBar, 'no gradient anywhere on a pixel panel').toBe(false);
              expect(read.h1.rule, 'a stepped (dashed) rule').toBe('4px dashed');
              expect(read.pre.border).toBe('2px solid');
              expect(read.pre.radius, 'a square code frame').toBe('0px');
              expect(read.pre.shadow, 'a hard inset shadow').toBe(true);
              expect(read.quote.left, 'a dashed block quote').toBe('dashed 4px');
              expect(read.quote.bg).toBe(true);
              expect(read.td.left, 'a ruled grid table').toBe('solid');
              expect(read.th.weight).toBe('700');
              expect(read.link.decoration).toContain('underline solid 2px');
            }
            // SPINNER (the declarations; the next block reads what the engine is DOING).
            if (style === 'retro') {
              expect(read.spinner.ring, 'a ring, drawn in ticks').not.toBe('none');
              expect(read.spinner.parts).toEqual(['none', 'none', 'none', 'none']);
              expect(read.spinner.trackDash).not.toBe('none');
              expect(read.spinner.arcDash.split(',').length, 'three lit ticks and the gap').toBe(6);
              expect(read.spinner.animation).toContain('1.2s');
              expect(read.spinner.animation).toContain('steps(12');
            } else {
              expect(read.spinner.ring).toBe('none');
              expect(read.spinner.parts).toEqual(['inline', 'inline', 'inline', 'inline']);
              expect(read.spinner.p1Fill, 'four solid blocks').not.toBe('none');
              expect(read.spinner.animation.startsWith('none '), 'the figure does not turn: the blocks chase').toBe(
                true,
              );
            }
          } finally {
            await close();
          }
        });
      });

/**
 * The pattern is really PAINTED, not only declared: with the specimen's own opaque page cover taken off, a 96 x 96 corner of the
 * page screenshot (device scale 1) is read pixel by pixel. Retro: a dot lattice at a 4px period (every 4 x 4 cell holds the same
 * few ink pixels); Pixel: 1px rules every 8px in both directions (12 vertical rules in 96px). Each step from the ground is
 * visible but quiet (a few levels of 255, never a wash).
 */
describe('the field pattern is painted', () => {
  for (const style of ['retro', 'pixel'] as const)
    for (const mode of MODES)
      it(`${style} in ${mode}`, async () => {
        const { tab, close } = await open(VIEWPORTS[0], mode, style);
        try {
          await tab.addStyleTag({
            content:
              '[data-specimen] { background: transparent !important; } [data-specimen] * { visibility: hidden !important; }',
          });
          const png = (await tab.screenshot({ clip: { x: 0, y: 0, width: 96, height: 96 }, type: 'png' })).toString(
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
            const w = bitmap.width;
            const lum = (x: number, y: number) =>
              (d[(y * w + x) * 4] ?? 0) + (d[(y * w + x) * 4 + 1] ?? 0) + (d[(y * w + x) * 4 + 2] ?? 0);
            // The ground is the most common level; ink is any pixel that is not the ground.
            const counts = new Map<number, number>();
            for (let y = 0; y < 96; y += 1)
              for (let x = 0; x < 96; x += 1) counts.set(lum(x, y), (counts.get(lum(x, y)) ?? 0) + 1);
            let ground = 0;
            let most = 0;
            for (const [level, n] of counts)
              if (n > most) {
                most = n;
                ground = level;
              }
            let span = 0;
            for (const level of counts.keys()) span = Math.max(span, Math.abs(level - ground));
            const ink = (x: number, y: number) => lum(x, y) !== ground;
            // Retro: every 4x4 cell holds ink, and the cells are the same (a lattice at a 4px period).
            const cells = new Set<string>();
            let emptyCell = false;
            for (let cy = 0; cy < 96; cy += 4)
              for (let cx = 0; cx < 96; cx += 4) {
                let key = '';
                for (let y = 0; y < 4; y += 1) for (let x = 0; x < 4; x += 1) key += ink(cx + x, cy + y) ? '1' : '0';
                if (!key.includes('1')) emptyCell = true;
                cells.add(key);
              }
            // Pixel: a vertical rule is a column that is ink on most of its rows.
            const columns: number[] = [];
            for (let x = 0; x < 96; x += 1) {
              let n = 0;
              for (let y = 0; y < 96; y += 1) if (ink(x, y)) n += 1;
              if (n >= 80) columns.push(x);
            }
            return { span, distinct: counts.size, latticeCells: cells.size, emptyCell, columns };
          }, png)) as { span: number; distinct: number; latticeCells: number; emptyCell: boolean; columns: number[] };
          report[`pattern:${style}:${mode}`] = painted;
          expect(painted.distinct, 'the corner holds more than one level: ink on a ground').toBeGreaterThanOrEqual(2);
          // Three channels summed: at least 6 (about 2 of 255 each) and at most 120 (about 40 each).
          expect(painted.span).toBeGreaterThanOrEqual(6);
          expect(painted.span).toBeLessThanOrEqual(120);
          if (style === 'retro') {
            expect(painted.emptyCell, 'every 4px cell carries a dot').toBe(false);
            expect(painted.latticeCells, 'one lattice: every cell identical').toBe(1);
          } else {
            expect(painted.columns.length, '12 rules across 96px (one per 8px)').toBe(12);
            for (const [index, column] of painted.columns.entries())
              expect(column - (painted.columns[0] ?? 0), 'rules 8px apart').toBe(index * 8);
          }
        } finally {
          await close();
        }
      });
});

/**
 * THE SPINNERS ARE REALLY MOVING (STYLE KITS rule, from the T5 and T6 reviews). The computed `animation-duration` and
 * `animation-timing-function` read above are DECLARATIONS: forcing `animation-name: none !important` on the mark left every one
 * of them passing. These read what the engine is DOING: the live CSS animations on the mark and its parts, then every one
 * paused at the same fixed times and the mark's rotation (from its computed matrix) and each part's opacity read back. Each
 * test also runs with `animation-name: none` injected and proves its own expectation throws.
 */
interface MarkRead {
  /** Every running CSS animation on the mark: the svg itself (`mark`) and its parts (`p1`..`p4`). */
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
  /** The mark's own opacity at each sample time. */
  readonly markOpacity: readonly number[];
  /** Each part's opacity at each sample time. */
  readonly opacity: Readonly<Record<string, readonly number[]>>;
  /** Each part's computed display. */
  readonly display: readonly string[];
}

const KILL_ANIMATIONS =
  ".fy-spinner.fy-spinner.fy-spinner, .fy-spinner.fy-spinner [class*='fy-spinner__p'] { animation-name: none !important; }";

/** What the mark at `selector` is DOING in the real engine: its live animation list, and rotation + opacities at fixed times. */
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
      // CSS animations only (a CSS transition is not the mark's motion).
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
      const angleOf = (transform: string): number => {
        if (transform === 'none') return 0;
        const m = /matrix\(([^)]+)\)/u.exec(transform);
        const [a = 1, b = 0] = (m?.[1] ?? '1,0').split(',').map(Number);
        return ((((Math.atan2(b, a) * 180) / Math.PI) % 360) + 360) % 360;
      };
      const angle: number[] = [];
      const markOpacity: number[] = [];
      const opacity: Record<string, number[]> = { p1: [], p2: [], p3: [], p4: [] };
      for (const time of sampleAt as readonly number[]) {
        for (const animation of owned) {
          animation.pause();
          animation.currentTime = time;
        }
        angle.push(angleOf(getComputedStyle(svg).transform));
        markOpacity.push(Number.parseFloat(getComputedStyle(svg).opacity));
        for (const [index, part] of parts.entries())
          (opacity[`p${index + 1}`] as number[]).push(Number.parseFloat(getComputedStyle(part).opacity));
      }
      for (const animation of owned) animation.play();
      const display = parts.map(part => getComputedStyle(part).display);
      injected?.remove();
      return { active, angle, markOpacity, opacity, display };
    },
    [selector, times, disable, KILL_ANIMATIONS] as const,
  );

const PROBE = '[data-probe="spinner"] svg';
const near = (actual: number | undefined, expected: number, digits = 1): void =>
  expect(actual ?? Number.NaN).toBeCloseTo(expected, digits);

// RETRO: the ring turns in whole twelfths (30deg every 100ms of the 1200ms turn): one tick at a time, never a smooth turn.
const RETRO_TIMES = [50, 150, 450, 1_150] as const;
const expectRetroStepping = (read: MarkRead): void => {
  const marks = read.active.filter(animation => animation.target === 'mark');
  expect(marks.length, 'the mark runs one animation').toBe(1);
  expect(marks[0]).toMatchObject({
    name: 'fy-spinner-turn',
    state: 'running',
    duration: 1_200,
    iterations: 'Infinity',
  });
  expect(
    read.active.filter(animation => animation.target !== 'mark'),
    'the ticks run no animation of their own: the ring moves',
  ).toEqual([]);
  // Held at 0deg for the first 100ms, then 30deg per step. A smooth turn would read 15, 45, 135, 345.
  const expected = [0, 30, 120, 330];
  for (const [index, degrees] of expected.entries()) near(read.angle[index], degrees, 0);
};

// PIXEL: four blocks light in turn, clockwise (top-left, top-right, bottom-right, bottom-left = p1, p2, p4, p3), a quarter turn
// of the 1000ms cycle apart. The figure itself does not turn. Staggered delays are RESTATED in the style (the base shorthand
// resets them), so the delays read back are the stagger.
const PIXEL_TIMES = [100, 350, 600, 850, 1_100] as const;
const PIXEL_LIT = ['p1', 'p2', 'p4', 'p3', 'p1'] as const;
const expectPixelChasing = (read: MarkRead): void => {
  expect(
    read.active.filter(animation => animation.target === 'mark'),
    'the figure does not turn',
  ).toEqual([]);
  const parts = read.active.filter(animation => animation.target !== 'mark');
  expect(parts.map(animation => animation.target).sort(), 'all four blocks animate').toEqual(['p1', 'p2', 'p3', 'p4']);
  for (const animation of parts)
    expect(animation, `${animation.target} runs the chase`).toMatchObject({
      name: 'fy-pixel-chase',
      state: 'running',
      duration: 1_000,
      iterations: 'Infinity',
    });
  const delayOf = (target: string): number | undefined => parts.find(animation => animation.target === target)?.delay;
  expect(['p1', 'p2', 'p4', 'p3'].map(delayOf), 'staggered a quarter turn apart, clockwise').toEqual([
    0, 250, 500, 750,
  ]);
  // Exactly one block is lit at each sample, and it is the one whose quarter it is; the rest are held dim, in whole frames.
  for (const [index, lit] of PIXEL_LIT.entries())
    for (const part of ['p1', 'p2', 'p3', 'p4']) near(read.opacity[part]?.[index], part === lit ? 1 : 0.25, 2);
};

describe('the Retro and Pixel spinners are really moving (live animations and phase, not declarations)', () => {
  for (const mode of MODES) {
    it(`Retro in ${mode}: a segmented ring stepping one tick at a time`, async () => {
      const { tab, close } = await open(VIEWPORTS[0], mode, 'retro');
      try {
        const live = await readMark(tab, PROBE, RETRO_TIMES, false);
        report[`motion:retro:${mode}`] = live;
        expect(live.display, 'the ticks are the ring: no parts drawn').toEqual(['none', 'none', 'none', 'none']);
        expectRetroStepping(live);
        const dead = await readMark(tab, PROBE, RETRO_TIMES, true);
        expect(dead.active, 'animation-name: none stops every animation').toEqual([]);
        expect(() => expectRetroStepping(dead), 'the assert fails when the mark does not move').toThrow();
      } finally {
        await close();
      }
    });

    it(`Pixel in ${mode}: four blocks lit in turn, clockwise, in whole frames`, async () => {
      const { tab, close } = await open(VIEWPORTS[0], mode, 'pixel');
      try {
        const live = await readMark(tab, PROBE, PIXEL_TIMES, false);
        report[`motion:pixel:${mode}`] = live;
        expect(live.display).toEqual(['inline', 'inline', 'inline', 'inline']);
        expectPixelChasing(live);
        const dead = await readMark(tab, PROBE, PIXEL_TIMES, true);
        expect(dead.active, 'animation-name: none stops every animation').toEqual([]);
        expect(() => expectPixelChasing(dead), 'the assert fails when the blocks do not move').toThrow();
      } finally {
        await close();
      }
    });

    it(`Retro in ${mode}, reduced motion: the whole ring pulses and the arc is a full ring`, async () => {
      const { tab, close } = await open(VIEWPORTS[0], mode, 'retro');
      try {
        await tab.emulateMedia({ reducedMotion: 'reduce' });
        // A transition on the arc's dash and the parts' opacity is in flight for a moment after the switch: read it settled.
        await tab.waitForTimeout(600);
        const expectPulse = (read: MarkRead): void => {
          expect(read.active.map(animation => animation.name)).toEqual(['fy-spinner-pulse']);
          expect(read.active[0]).toMatchObject({ target: 'mark', state: 'running', duration: 1_600 });
          near(read.markOpacity[0], 1, 2);
          near(read.markOpacity[1], 0.72, 2);
          near(read.markOpacity[2], 1, 2);
        };
        const live = await readMark(tab, PROBE, [0, 800, 1_600], false);
        report[`motion:retro-reduced:${mode}`] = live;
        expectPulse(live);
        const dash = await tab.evaluate(
          selector =>
            getComputedStyle(document.querySelector(`${selector} .fy-spinner-arc`) as Element).strokeDasharray,
          PROBE,
        );
        expect(dash, 'a full ring (the segmenting is a moving figure; a pulse has none)').toBe('100px, 0px');
        const dead = await readMark(tab, PROBE, [0, 800, 1_600], true);
        expect(() => expectPulse(dead), 'the assert fails when the mark does not pulse').toThrow();
      } finally {
        await close();
      }
    });

    it(`Pixel in ${mode}, reduced motion: four solid blocks, the mark pulses in place`, async () => {
      const { tab, close } = await open(VIEWPORTS[0], mode, 'pixel');
      try {
        await tab.emulateMedia({ reducedMotion: 'reduce' });
        // A transition on the arc's dash and the parts' opacity is in flight for a moment after the switch: read it settled.
        await tab.waitForTimeout(600);
        const expectPulse = (read: MarkRead): void => {
          expect(read.display, 'the blocks stay drawn').toEqual(['inline', 'inline', 'inline', 'inline']);
          expect(read.active.map(animation => animation.name)).toEqual(['fy-spinner-pulse']);
          expect(read.active[0]).toMatchObject({ target: 'mark', state: 'running', duration: 1_600 });
          near(read.markOpacity[0], 1, 2);
          near(read.markOpacity[1], 0.72, 2);
          for (const part of ['p1', 'p2', 'p3', 'p4']) expect(read.opacity[part]).toEqual([1, 1, 1]);
        };
        const live = await readMark(tab, PROBE, [0, 800, 1_600], false);
        report[`motion:pixel-reduced:${mode}`] = live;
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
 * A swatch draws ITS OWN style's mark, whatever the page is wearing (the T6 review's item 3, which the T5 spinner rules had
 * missed). Every page style x every swatch style: a MIXED page x swatch matrix, each swatch's mark read back whole, including
 * the ring's dash (a Studio swatch on a Retro page must keep Studio's plain arc) and the live animations (a Pixel swatch under a
 * Studio page keeps its four chasing blocks, a Retro swatch under Pixel keeps its turning ring).
 */
const ARC = '32px, 100px';
const SIGNATURE = {
  studio: {
    ring: 'inline',
    parts: ['none', 'none', 'none', 'none'],
    animations: ['mark:fy-spinner-turn:900'],
    arc: ARC,
  },
  mission: {
    ring: 'none',
    parts: ['inline', 'inline', 'inline', 'inline'],
    animations: ['mark:fy-spinner-turn:2400'],
    arc: undefined,
  },
  hud: {
    ring: 'inline',
    parts: ['inline', 'none', 'none', 'none'],
    animations: ['mark:fy-spinner-turn:1400', 'p1:fy-spinner-part:1400'],
    arc: '16px, 100px',
  },
  geist: {
    ring: 'none',
    parts: ['inline', 'inline', 'inline', 'inline'],
    animations: [
      'p1:fy-spinner-part:1000',
      'p2:fy-spinner-part:1000',
      'p3:fy-spinner-part:1000',
      'p4:fy-spinner-part:1000',
    ],
    arc: undefined,
  },
  retro: {
    ring: 'inline',
    parts: ['none', 'none', 'none', 'none'],
    animations: ['mark:fy-spinner-turn:1200'],
    arc: '5.83px, 2.5px, 5.83px, 2.5px, 5.83px, 100px',
  },
  pixel: {
    ring: 'none',
    parts: ['inline', 'inline', 'inline', 'inline'],
    animations: [
      'p1:fy-pixel-chase:1000',
      'p2:fy-pixel-chase:1000',
      'p3:fy-pixel-chase:1000',
      'p4:fy-pixel-chase:1000',
    ],
    arc: undefined,
  },
} as const;
type StyleId = keyof typeof SIGNATURE;

describe('a swatch draws its own style’s spinner, on a page of any style', () => {
  for (const pageStyle of ['studio', 'retro', 'pixel', 'mission'] as const)
    it(`on a ${pageStyle} page: Studio, Mission, HUD, Geist, Retro and Pixel swatches each keep their own mark`, async () => {
      const { tab, close } = await open(VIEWPORTS[0], 'light', pageStyle);
      try {
        for (const swatch of Object.keys(SIGNATURE) as StyleId[]) {
          const selector = `[data-swatch][data-style="${swatch}"] svg`;
          await tab.evaluate(
            ([style, source]) => {
              const holder = document.createElement('div');
              holder.setAttribute('data-swatch', '');
              holder.setAttribute('data-style', style as string);
              holder.setAttribute('data-palette', 'mission');
              holder.setAttribute('data-mode', 'light');
              holder.innerHTML = source as string;
              document.body.append(holder);
            },
            [
              swatch,
              await tab.evaluate(selector => (document.querySelector(selector) as Element).outerHTML, PROBE),
            ] as const,
          );
          const read = await readMark(tab, selector, [0], false);
          const got = read.active
            .map(animation => `${animation.target}:${animation.name}:${animation.duration}`)
            .sort();
          const probe = (await tab.evaluate(
            sel => ({
              ring: getComputedStyle(document.querySelector(`${sel} .fy-spinner-ring`) as Element).display,
              arc: getComputedStyle(document.querySelector(`${sel} .fy-spinner-arc`) as Element).strokeDasharray,
            }),
            selector,
          )) as { ring: string; arc: string };
          report[`swatch:${pageStyle}:${swatch}`] = { ...probe, parts: read.display, animations: got };
          const want = SIGNATURE[swatch];
          expect(probe.ring, `${swatch} swatch on a ${pageStyle} page: ring`).toBe(want.ring);
          expect(read.display, `${swatch} swatch on a ${pageStyle} page: parts`).toEqual(want.parts);
          expect(got, `${swatch} swatch on a ${pageStyle} page: live animations`).toEqual([...want.animations].sort());
          if (want.arc !== undefined)
            expect(probe.arc, `${swatch} swatch on a ${pageStyle} page: arc dash`).toBe(want.arc);
          await tab.evaluate(sel => document.querySelector(sel)?.parentElement?.remove(), selector);
        }
      } finally {
        await close();
      }
    });
});

/**
 * A swatch's CONTROLS are its own style's too (the T10 review's item 2: the mixed-swatch matrix mounted only SVGs). The same
 * control set is mounted as a `[data-swatch][data-style=S]` preview on a STUDIO page (the neutral baseline: nothing of Retro or
 * Pixel is on the page) and on a RETRO and on a PIXEL page. A control's computed look must not differ between the baseline and
 * either kit's page: whatever differs is a Retro or Pixel page rule reaching into another style's preview. The baseline carries
 * every OTHER seam's own noise (a HUD swatch's transitions, say), so the assert isolates what this unit's two files do. `color`
 * is left out (a preview inherits its ink from the page unless a rule sets it, which is the shell's, not a kit's).
 */
const CONTROLS = `
  <button class="kt-btn" data-probe-control="button" data-variant="primary" type="button">Send</button>
  <button class="kt-btn" data-probe-control="ghost" type="button">Cancel</button>
  <label class="fy-cc__card" data-probe-control="card" data-selected="true"><input type="radio" class="sr-only" name="s" checked><span class="fy-cc__line">Left</span></label>
  <label class="fy-cc__card" data-probe-control="card-idle"><input type="radio" class="sr-only" name="s"><span class="fy-cc__line">Right</span></label>
  <div class="kt-panel" data-probe-control="panel"><div class="kt-panel__header" data-probe-control="header">Title</div><div>Body</div></div>
  <input class="kt-input" data-probe-control="input" aria-label="Name" value="Name">
  <span class="kt-badge" data-probe-control="badge">ok</span>`;
const CONTROL_PROPS = [
  'backgroundColor',
  'backgroundImage',
  'borderTopColor',
  'borderTopStyle',
  'borderTopWidth',
  'borderTopLeftRadius',
  'boxShadow',
  'fontWeight',
  'textTransform',
  'transitionDuration',
  'transitionProperty',
  'translate',
] as const;
const readControls = async (tab: Page, host: string): Promise<Record<string, Record<string, string>>> =>
  (await tab.evaluate(
    ([selector, props]) => {
      const out: Record<string, Record<string, string>> = {};
      for (const el of document.querySelectorAll(`${selector} [data-probe-control]`)) {
        const style = getComputedStyle(el);
        out[(el as HTMLElement).dataset.probeControl as string] = Object.fromEntries(
          (props as readonly string[]).map(prop => [prop, style[prop as keyof CSSStyleDeclaration] as string]),
        );
      }
      return out;
    },
    [host, CONTROL_PROPS] as const,
  )) as Record<string, Record<string, string>>;

describe('a swatch’s controls are drawn in the swatch’s own style, on a page of any style', () => {
  const swatches = ['studio', 'mission', 'hud', 'geist'] as const;
  const mount = async (tab: Page, style: string): Promise<Record<string, Record<string, string>>> => {
    await tab.evaluate(
      ([s, p, source]) => {
        const holder = document.createElement('div');
        holder.setAttribute('data-swatch', '');
        holder.setAttribute('data-style', s as string);
        holder.setAttribute('data-palette', p as string);
        holder.setAttribute('data-mode', 'light');
        holder.innerHTML = source as string;
        document.body.append(holder);
      },
      [style, PALETTE[style as keyof typeof PALETTE], CONTROLS] as const,
    );
    const got = await readControls(tab, `[data-swatch][data-style="${style}"]`);
    await tab.evaluate(sel => document.querySelector(sel)?.remove(), `[data-swatch][data-style="${style}"]`);
    return got;
  };
  it('on a Retro and a Pixel page, the Studio, Mission, HUD and Geist swatches keep the controls they have on a Studio page', async () => {
    const baseline = {} as Record<string, Record<string, Record<string, string>>>;
    const studio = await open(VIEWPORTS[0], 'light', 'studio');
    try {
      for (const style of swatches) baseline[style] = await mount(studio.tab, style);
    } finally {
      await studio.close();
    }
    const leaks: string[] = [];
    for (const pageStyle of ['retro', 'pixel'] as const) {
      const { tab, close } = await open(VIEWPORTS[0], 'light', pageStyle);
      try {
        for (const style of swatches) {
          const got = await mount(tab, style);
          for (const [control, props] of Object.entries(baseline[style] ?? {}))
            for (const prop of CONTROL_PROPS)
              if (got[control]?.[prop] !== props[prop])
                leaks.push(
                  `${pageStyle} page, ${style} swatch, ${control}.${prop}: ${got[control]?.[prop]} (a studio page: ${props[prop]})`,
                );
        }
      } finally {
        await close();
      }
    }
    report['swatch-controls'] = leaks;
    expect(leaks).toEqual([]);
  });
});

/**
 * REDUCED MOTION READS THE ROOT (the T10 review's item 2). Settings > Appearance > Motion sets `data-motion="reduced"` on
 * `<html>`, never on a swatch, so a Retro swatch's segmented arc has to answer to the root: the whole ring (`100px, 0px`).
 */
describe('a Retro swatch under app-level reduced motion draws the plain full ring', () => {
  for (const pageStyle of ['studio', 'retro', 'pixel'] as const)
    it(`on a ${pageStyle} page`, async () => {
      const { tab, close } = await open(VIEWPORTS[0], 'light', pageStyle);
      try {
        const source = await tab.evaluate(selector => (document.querySelector(selector) as Element).outerHTML, PROBE);
        await tab.evaluate(
          ([html]) => {
            const holder = document.createElement('div');
            holder.setAttribute('data-swatch', '');
            holder.setAttribute('data-style', 'retro');
            holder.setAttribute('data-palette', 'geist');
            holder.setAttribute('data-mode', 'light');
            holder.innerHTML = html as string;
            document.body.append(holder);
          },
          [source] as const,
        );
        const dash = async (): Promise<string> =>
          await tab.evaluate(
            () => getComputedStyle(document.querySelector('[data-swatch] .fy-spinner-arc') as Element).strokeDasharray,
          );
        expect(await dash(), 'motion on: the segmented arc').toBe('5.83px, 2.5px, 5.83px, 2.5px, 5.83px, 100px');
        await tab.evaluate(() => document.documentElement.setAttribute('data-motion', 'reduced'));
        await tab.waitForTimeout(600);
        expect(await dash(), 'app-level reduced motion: the full ring').toBe('100px, 0px');
      } finally {
        await close();
      }
    });
});

/**
 * THE PIXEL CHOICE CARD'S KEYBOARD RING (r11 S13, the T10 review's item 1). The card's ring used to be drawn 3px outside the
 * card with a 3px offset, so it reached 6px beyond the card and a zero-padding overflow container cut it. It is now drawn
 * INSIDE the card's border (reach 0, nothing can clip it) over a contrasting inset band, so on the selected (inverted) fill, where the
 * ring colour alone gives 1.65:1 in High contrast dark, the ring still stands off its neighbours by >= 3:1.
 * The choice cards sit in a `padding: 0; overflow: auto` holder, the worst case an ancestor can be.
 */
describe('the Pixel choice card keeps its keyboard ring whole and legible', () => {
  for (const palette of ['hacker', 'contrast'])
    for (const mode of MODES)
      for (const viewport of VIEWPORTS)
        it(`${palette} in ${mode} at ${viewport.name}: reach 0, no clipping ancestor, ring >= 3:1 against both neighbours`, async () => {
          const { tab, close } = await open(viewport, mode, 'pixel');
          try {
            await tab.evaluate(p => document.documentElement.setAttribute('data-palette', p), palette);
            await tab.evaluate(() => {
              const grid = document.querySelector('.fy-cc') as HTMLElement;
              const holder = document.createElement('div');
              holder.setAttribute('data-probe', 'cc-clip');
              holder.style.cssText = 'overflow: auto; padding: 0;';
              grid.replaceWith(holder);
              holder.append(grid);
            });
            const stop = await ringOf(tab, '.fy-cc input:checked');
            expect(stop, 'Tab reaches the chosen card').not.toBeNull();
            const read = await tab.evaluate(() => {
              const colour = (window as unknown as { __colour: ColourTools }).__colour;
              const card = (document.activeElement as HTMLElement).closest('.fy-cc__card') as HTMLElement;
              const style = getComputedStyle(card);
              const ring = colour.rgba(style.outlineColor);
              const fill = colour.backdrop(card);
              const inset = style.boxShadow.split(/,(?![^()]*\))/).find(part => part.includes('inset'));
              const paint = inset === undefined ? null : /(rgba?\([^)]*\))/.exec(inset);
              const band = paint === null ? fill : colour.over(colour.rgba(paint[1] as string), [...fill, 1]);
              const edge = colour.over(colour.rgba(style.borderTopColor), [
                ...colour.backdrop(card.parentElement as HTMLElement),
                1,
              ]);
              // What sits just OUTSIDE the ring: the band's outer gap when the ring is set in from the border, else the border.
              const gap =
                -Number.parseFloat(style.outlineOffset) -
                Number.parseFloat(style.borderTopWidth) -
                Number.parseFloat(style.outlineWidth);
              const border = gap > 0 ? band : edge;
              const lit = (below: readonly number[]) => colour.over(ring, [...below, 1]);
              return {
                offset: Number.parseFloat(style.outlineOffset),
                width: Number.parseFloat(style.outlineWidth),
                inside: colour.ratio(lit(band), band),
                outside: colour.ratio(lit(border), border),
                bandDrawn: inset !== undefined,
                gap,
                paint: { ring, fill, band, edge, shadow: style.boxShadow },
              };
            });
            report[`pixel-card-ring:${palette}:${mode}:${viewport.name}`] = { reach: stop?.reach, ...read };
            expect(stop?.violations, 'a clipping ancestor cuts the ring').toEqual([]);
            expect(stop?.reach, 'the ring reaches 0px outside the card').toBe(0);
            expect(read.inside, 'ring against the band just inside it').toBeGreaterThanOrEqual(3);
            expect(
              read.outside,
              'ring against what sits just outside it (the band gap, or the border)',
            ).toBeGreaterThanOrEqual(3);
          } finally {
            await close();
          }
        });
});

/**
 * Set `FY_RETRO_PIXEL_KIT_SHOTS_DIR=<dir>` to keep, on fake data: `<style>-<width>-<mode>.png` (the whole specimen page),
 * `<style>-corner-<mode>.png` (the top-left 200 x 120 of the page at 4x: the field pattern, close up) and
 * `<style>-md-<mode>.png` (the markdown block at 2x), and `pixel-card-ring-<width>-<mode>.png` (the choice cards with the keyboard ring on the chosen one, at 2x).
 */
const shotsDir = process.env.FY_RETRO_PIXEL_KIT_SHOTS_DIR ?? '';
describe.skipIf(shotsDir === '')('the kits, photographed', () => {
  for (const style of ['retro', 'pixel'] as const)
    for (const mode of MODES) {
      for (const viewport of VIEWPORTS)
        it(`${style} at ${viewport.name} in ${mode}`, async () => {
          const { mkdir } = await import('node:fs/promises');
          await mkdir(shotsDir, { recursive: true });
          const { tab, close } = await open(viewport, mode, style);
          try {
            await tab.screenshot({ fullPage: true, path: join(shotsDir, `${style}-${viewport.name}-${mode}.png`) });
          } finally {
            await close();
          }
        });
      if (style === 'pixel')
        for (const viewport of VIEWPORTS)
          it(`pixel choice card, keyboard ring, at ${viewport.name} in ${mode}`, async () => {
            const { mkdir } = await import('node:fs/promises');
            await mkdir(shotsDir, { recursive: true });
            const { tab, close } = await open(viewport, mode, style, 2);
            try {
              await ringOf(tab, '.fy-cc input:checked');
              const grid = await tab.$('.fy-cc');
              await grid?.screenshot({ path: join(shotsDir, `pixel-card-ring-${viewport.name}-${mode}.png`) });
            } finally {
              await close();
            }
          });
      it(`${style} close up in ${mode}`, async () => {
        const { mkdir } = await import('node:fs/promises');
        await mkdir(shotsDir, { recursive: true });
        const { tab, close } = await open(VIEWPORTS[0], mode, style, 4);
        try {
          await tab.addStyleTag({
            content:
              '[data-specimen] { background: transparent !important; } [data-specimen] * { visibility: hidden !important; }',
          });
          await tab.screenshot({
            clip: { x: 0, y: 0, width: 200, height: 120 },
            path: join(shotsDir, `${style}-corner-${mode}.png`),
          });
        } finally {
          await close();
        }
        const second = await open(VIEWPORTS[0], mode, style, 2);
        try {
          await (await second.tab.$('.md[data-probe="md"]'))?.screenshot({
            path: join(shotsDir, `${style}-md-${mode}.png`),
          });
        } finally {
          await second.close();
        }
      });
    }
});
