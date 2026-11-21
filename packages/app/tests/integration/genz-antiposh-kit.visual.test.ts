/**
 * THE GEN Z MAXIMALISM + ANTI-POSH STYLE KITS (r11 T12), measured in a real browser on the theme matrix's specimen page
 * (`plugins/conversation/tests/integration/app/fixtures/theme-matrix-scene.tsx`), each style on its DEFAULT palette (Gen Z: Magenta,
 * the `vaporwave` palette id; Anti-Posh: Rust, the `vintage` id), in both modes at 1280 and 390.
 *
 * The owner's line (turn 4247, item 12): "BG and grainy-ness can help with the style too -- and ... components too, including how
 * markdown looks", "make sure things like spinner, animation all are unique to their style", "design each style to change the hyper
 * media completely", "most of them should not have gradient background", "alot of the super rounded ones are broken". So each
 * style must FILL every slot of the component style contract with its own idiom:
 *
 *   Gen Z     = a sticker sheet. A field of accent dots under fine grain (no colour blast, no panel texture); a fat display h1 over a
 *               dotted accent rule, a sticker box for code with a stacked accent shadow, tinted quote and pill-highlighted links;
 *               a spinner that is a SPARKLE (four fat bars as an eight-ray star, spinning on a springy ease, each ray twinkling a
 *               quarter-beat apart); bouncy motion; hypermedia `shaped`. Pills only for buttons, chips and badges; fields, code,
 *               menus and tables stop at 16px.
 *   Anti-Posh = a photocopied zine. Graph paper under photocopier grain; a squashed all-caps h1 under a double ink rule, dashed
 *               code with a mis-registered hard shadow, a highlighted pasted-in note, a dashed grid table; a spinner that is a
 *               TYPEWRITER FLIPBOOK (`| / - \`, one stroke at a time, in whole steps); stepped motion; hypermedia `ink`.
 *
 * And the rules the earlier kits' reviews added: every component rule is scoped to the page or a swatch of its own style (a mixed
 * page x swatch test reads a swatch of one style on a page of another, controls and spinner both), the filled Send and the selected
 * Settings link keep a >= 3:1 keyboard ring inside the control, the busy mark on a filled button keeps its foreground, no ring
 * sticks out of its control, and nothing is see-through when the OS asks for no transparency.
 *
 * Set `FY_GENZ_ANTIPOSH_KIT_REPORT=<file>` to write the measured numbers (JSON), the values the PR body quotes, and
 * `FY_GENZ_ANTIPOSH_KIT_SHOTS=<dir>` to write the specimen shots.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { COLOUR_TOOLS, type ColourTools, sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const conversationScenes = resolve(packageRoot, '../../../plugins/conversation/tests/integration/app/fixtures');
const reportFile = process.env.FY_GENZ_ANTIPOSH_KIT_REPORT ?? '';
const shotsDirectory = process.env.FY_GENZ_ANTIPOSH_KIT_SHOTS ?? '';

const MODES = ['light', 'dark'] as const;
const VIEWPORTS = [
  { name: '1280', width: 1_280, phone: false },
  { name: '390', width: 390, phone: true },
] as const;
/** The default palette of each style (T1's table): the ids the catalogue keeps for Magenta and Rust. */
const PALETTE = { genz: 'vaporwave', antiposh: 'vintage' } as const;
type Kit = keyof typeof PALETTE;
const KITS = ['genz', 'antiposh'] as const;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;
const report: Record<string, unknown> = {};

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-genz-antiposh-kit-'));
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

/** One style on a palette (its own default unless named), drawn with its real motion (a spinner's animation is read, not frozen). */
const open = async (
  viewport: (typeof VIEWPORTS)[number],
  mode: 'light' | 'dark',
  style: string,
  palette: string = PALETTE[style as Kit] ?? 'studio',
): Promise<{ tab: Page; refused: string[]; close: () => Promise<void> }> => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: 2_400 },
    colorScheme: mode,
    hasTouch: viewport.phone,
    isMobile: viewport.phone,
  });
  const origin = server?.url.origin ?? '';
  // Every request that is not the page's own is refused: the grain is an inline data URI, so it must need none.
  const refused: string[] = [];
  await context.route('**/*', async route => {
    if (new URL(route.request().url()).origin === origin) return await route.continue();
    refused.push(route.request().url());
    return await route.abort();
  });
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
  await tab.waitForTimeout(600);
  return { tab, refused, close: async () => await context.close() };
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
  const h1 = cs(q('.md h1'));
  const pre = cs(q('.md pre'));
  const quote = cs(q('.md blockquote'));
  const th = cs(q('.md th'));
  const td = cs(q('.md td'));
  const a = cs(q('.md a'));
  const panel = cs(q('.kt-panel'));
  const menu = cs(q('[role="menu"]'));
  const area = cs(q('[data-probe="textarea"]'));
  const button = cs(q('.kt-btn:not([data-variant])'));
  const input = cs(q('input.kt-input'));
  const box = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10]; };
  const split = (value) => {
    const out = [];
    let depth = 0;
    let from = 0;
    for (let i = 0; i < value.length; i += 1) {
      if (value[i] === '(') depth += 1;
      else if (value[i] === ')') depth -= 1;
      else if (value[i] === ',' && depth === 0) {
        out.push(value.slice(from, i).trim());
        from = i + 1;
      }
    }
    out.push(value.slice(from).trim());
    return out;
  };
  const layers = (value) => split(value).filter((layer) => layer !== 'none');
  const gradientsOn = (selector) => [...document.querySelectorAll(selector)].filter((el) => /gradient/.test(getComputedStyle(el).backgroundImage)).length;
  return {
    layers: split(body.backgroundImage),
    bgSize: body.backgroundSize,
    bgRepeat: body.backgroundRepeat,
    grain: { image: cs(document.body, '::after').backgroundImage.slice(0, 40), opacity: cs(document.body, '::after').opacity, blend: cs(document.body, '::after').mixBlendMode },
    panel: { layers: layers(panel.backgroundImage), shadow: panel.boxShadow !== 'none', radius: panel.borderTopLeftRadius, style: panel.borderTopStyle },
    menu: { radius: menu.borderTopLeftRadius },
    textarea: { radius: area.borderTopLeftRadius },
    button: { radius: button.borderTopLeftRadius, gradient: /gradient/.test(button.backgroundImage), shadow: button.boxShadow !== 'none', style: button.borderTopStyle },
    field: { gradient: /gradient/.test(input.backgroundImage), radius: input.borderTopLeftRadius, style: input.borderTopStyle },
    h1: { case: h1.textTransform, rule: h1.borderBottomWidth + ' ' + h1.borderBottomStyle, weight: h1.fontWeight },
    h2: { rule: token('--md-h2-rule') },
    pre: { radius: pre.borderTopLeftRadius, shadow: pre.boxShadow, border: pre.borderTopWidth + ' ' + pre.borderTopStyle },
    quote: { left: quote.borderLeftStyle + ' ' + quote.borderLeftWidth, bg: quote.backgroundColor !== 'rgba(0, 0, 0, 0)', radius: quote.borderTopLeftRadius },
    th: { case: th.textTransform, weight: th.fontWeight, bg: th.backgroundColor !== 'rgba(0, 0, 0, 0)' },
    td: { left: td.borderLeftStyle, bottom: td.borderBottomStyle },
    link: { decoration: a.textDecorationLine, weight: a.fontWeight, bg: a.backgroundColor !== 'rgba(0, 0, 0, 0)', radius: a.borderTopLeftRadius },
    spinner: {
      animation: cs(spinner).animationName + ' ' + cs(spinner).animationDuration + ' ' + cs(spinner).animationTimingFunction,
      ring: ring.display,
      parts: [1, 2, 3, 4].map((n) => part(n).display),
      sizes: [1, 2, 3, 4].map((n) => part(n).width + 'x' + part(n).height),
      rx: part(1).rx,
      size: box(spinner),
    },
    hm: { shape: token('--hm-shape'), edge: token('--hm-edge'), radius: token('--hm-radius'), stroke: token('--hm-stroke'), header: token('--hm-header'), alpha: token('--hm-node-fill-alpha') },
    motion: { fast: token('--motion-fast'), base: token('--motion-base'), slow: token('--motion-slow'), ease: token('--ease-standard'), press: token('--press-translate') },
    gradients: { button: gradientsOn('.kt-btn'), field: gradientsOn('.kt-input, .kt-composer'), badge: gradientsOn('.kt-badge'), choice: gradientsOn('.fy-cc__card'), panels: gradientsOn('.kt-panel') },
  };
})()`;

/** A custom property is read back as authored or as the browser normalises it (`120ms` or `.12s`): compare the time. */
const milliseconds = (value: string): number =>
  value.endsWith('ms') ? Number.parseFloat(value) : Math.round(Number.parseFloat(value) * 1_000);
const px = (value: string): number => Number.parseFloat(value);

interface Read {
  layers: string[];
  bgSize: string;
  bgRepeat: string;
  grain: { image: string; opacity: string; blend: string };
  panel: { layers: string[]; shadow: boolean; radius: string; style: string };
  menu: { radius: string };
  textarea: { radius: string };
  button: { radius: string; gradient: boolean; shadow: boolean; style: string };
  field: { gradient: boolean; radius: string; style: string };
  h1: { case: string; rule: string; weight: string };
  h2: { rule: string };
  pre: { radius: string; shadow: string; border: string };
  quote: { left: string; bg: boolean; radius: string };
  th: { case: string; weight: string; bg: boolean };
  td: { left: string; bottom: string };
  link: { decoration: string; weight: string; bg: boolean; radius: string };
  spinner: { animation: string; ring: string; parts: string[]; sizes: string[]; rx: string; size: number[] };
  hm: { shape: string; edge: string; radius: string; stroke: string; header: string; alpha: string };
  motion: { fast: string; base: string; slow: string; ease: string; press: string };
  gradients: { button: number; field: number; badge: number; choice: number; panels: number };
}

for (const style of KITS)
  for (const viewport of VIEWPORTS)
    for (const mode of MODES)
      describe(`the ${style} kit at ${viewport.name} in ${mode}`, () => {
        it('fills every slot of the component style contract with its own idiom', async () => {
          const { tab, refused, close } = await open(viewport, mode, style);
          try {
            const read = (await tab.evaluate(READ)) as Read;
            report[`${style}:${viewport.name}:${mode}`] = read;
            // BACKGROUND: the contract tile is the page's one gradient layer (never a wash); the grain is a real, inline layer.
            expect(
              read.layers.filter(layer => /gradient\(/u.test(layer)).length,
              'the page paints exactly the style contract tile, never a wash',
            ).toBe(1);
            expect(read.bgRepeat.split(',')[0]).toBe('repeat');
            expect(Number(read.grain.opacity), 'a grain').toBeGreaterThan(0);
            expect(Number(read.grain.opacity), 'a soft grain, never a wash').toBeLessThanOrEqual(0.08);
            expect(read.grain.image, 'the grain is an inline SVG data URI (no request)').toStartWith(
              'url("data:image/svg+xml',
            );
            // NO gradient on a panel, a control, a field, a badge or a choice card.
            expect(read.panel.layers, 'a flat panel').toEqual([]);
            expect(read.gradients.button + read.gradients.field + read.gradients.badge + read.gradients.choice).toBe(0);
            expect(read.gradients.panels).toBe(0);
            // RADIUS: a multi-line field, a code block, a menu are capped at 16px.
            expect(px(read.textarea.radius)).toBeLessThanOrEqual(16);
            expect(px(read.menu.radius)).toBeLessThanOrEqual(16);
            expect(px(read.pre.radius)).toBeLessThanOrEqual(16);
            expect(read.panel.shadow, 'a panel casts its hard shadow').toBe(true);
            if (style === 'genz') {
              expect(read.layers[0], 'the first layer is the style contract dot tile').toMatch(/radial-gradient\(/u);
              expect(read.bgSize.split(',')[0]).toBe('22px 22px');
              expect(read.grain.blend).toBe(mode === 'light' ? 'soft-light' : 'normal');
              expect(px(read.button.radius), 'a button is a pill').toBeGreaterThan(100);
              expect(px(read.field.radius), 'a field is NOT a pill').toBeLessThanOrEqual(16);
              expect(milliseconds(read.motion.base)).toBe(260);
              expect(milliseconds(read.motion.slow)).toBe(460);
              expect(read.motion.ease, 'a spring that overshoots').toContain('1.56');
              expect(read.motion.press).toBe('3px');
              expect(read.hm).toEqual({
                shape: 'shaped',
                edge: 'curve',
                radius: '14px',
                stroke: '3px',
                header: 'band',
                alpha: '1',
              });
              // MARKDOWN: a sticker sheet.
              expect(read.h1.case).toBe('none');
              expect(read.h1.rule, 'a dotted accent rule under the h1').toBe('4px dotted');
              expect(read.h1.weight).toBe('400');
              expect(read.pre.radius).toBe('14px');
              expect(read.pre.shadow, 'a sticker shadow on the code').toContain('4px 4px 0px');
              expect(read.pre.border).toBe('2px solid');
              expect(read.quote.left, 'no bar: a tinted block').toBe('none 0px');
              expect(read.quote.bg).toBe(true);
              expect(read.quote.radius).toBe('14px');
              expect(read.th.case).toBe('lowercase');
              expect(read.th.weight).toBe('800');
              expect(read.th.bg).toBe(true);
              expect(read.td.left, 'a ruled grid').toBe('solid');
              expect(read.link.decoration).toBe('none');
              expect(read.link.bg, 'a link is a pill highlight').toBe(true);
              expect(px(read.link.radius)).toBeGreaterThan(100);
              // SPINNER: a sparkle of four fat bars; the ring is hidden; the star turns on a spring.
              expect(read.spinner.ring).toBe('none');
              expect(read.spinner.parts).toEqual(['inline', 'inline', 'inline', 'inline']);
              expect(new Set(read.spinner.sizes)).toEqual(new Set(['2.8px x 13px'.replace(' x ', 'x')]));
              expect(read.spinner.rx).toBe('1.4px');
              expect(read.spinner.animation).toBe('fy-spinner-turn 1.1s cubic-bezier(0.34, 1.56, 0.64, 1)');
            } else {
              expect(read.layers[0], 'the first layer is the style contract grid tile').toMatch(/conic-gradient\(/u);
              expect(read.bgSize.split(',')[0]).toBe('28px 28px');
              expect(read.grain.blend).toBe(mode === 'light' ? 'soft-light' : 'normal');
              expect(read.panel.style, 'a dashed coupon').toBe('dashed');
              expect(read.button.style, 'an outset slab').toBe('outset');
              expect(read.field.style, 'a sunken box').toBe('inset');
              expect(milliseconds(read.motion.base)).toBe(160);
              expect(milliseconds(read.motion.slow)).toBe(280);
              expect(read.motion.ease, 'a flipbook: whole steps').toBe('steps(4, end)');
              expect(read.motion.press).toBe('3px');
              expect({ ...read.hm, alpha: String(Number(read.hm.alpha)) }).toEqual({
                shape: 'ink',
                edge: 'straight',
                radius: '3px',
                stroke: '2px',
                header: 'label',
                alpha: '0.12',
              });
              // MARKDOWN: a typed zine.
              expect(read.h1.case).toBe('uppercase');
              expect(read.h1.rule, 'a double ink rule under the h1').toBe('4px double');
              expect(read.h1.weight).toBe('800');
              expect(read.h2.rule, 'a dashed rule under an h2').toMatch(/^2px dashed /u);
              expect(read.pre.border).toBe('2px dashed');
              expect(read.pre.shadow, 'a mis-registered hard shadow').toContain('5px 4px 0px');
              expect(read.quote.left).toBe('none 0px');
              expect(read.quote.bg, 'a highlighted pasted-in note').toBe(true);
              expect(read.th.case).toBe('uppercase');
              expect(read.th.bg).toBe(true);
              expect(read.td.left).toBe('dashed');
              expect(read.td.bottom).toBe('dashed');
              expect(read.link.decoration).toBe('underline');
              expect(read.link.weight).toBe('700');
              expect(read.link.bg, 'a highlighted underline').toBe(true);
              // SPINNER: a flipbook of four strokes; the ring is hidden; the mark itself does not turn.
              expect(read.spinner.ring).toBe('none');
              expect(read.spinner.parts).toEqual(['inline', 'inline', 'inline', 'inline']);
              expect(new Set(read.spinner.sizes)).toEqual(new Set(['1.8px x 12px'.replace(' x ', 'x')]));
              expect(read.spinner.rx).toBe('0px');
              expect(read.spinner.animation.startsWith('none ')).toBe(true);
            }
            expect(refused, 'the page asked for nothing outside itself').toEqual([]);
          } finally {
            await close();
          }
        });
      });

/**
 * The surface is really PAINTED, not only declared: with the specimen's own opaque page cover taken off and every glyph hidden, a
 * 96 x 96 corner of the page screenshot holds more than one level (dots or grid lines on a ground, under grain), each a quiet step
 * from the ground, never a wash.
 */
describe('the field and its grain are painted', () => {
  for (const style of KITS)
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
            const levels = new Set<number>();
            let low = Number.POSITIVE_INFINITY;
            let high = 0;
            for (let i = 0; i < d.length; i += 4) {
              const v = (d[i] ?? 0) + (d[i + 1] ?? 0) + (d[i + 2] ?? 0);
              levels.add(v);
              low = Math.min(low, v);
              high = Math.max(high, v);
            }
            return { levels: levels.size, span: high - low };
          }, png)) as { levels: number; span: number };
          report[`painted:${style}:${mode}`] = painted;
          expect(painted.levels, 'more than one level: a texture on a ground').toBeGreaterThanOrEqual(3);
          expect(painted.span).toBeGreaterThanOrEqual(2);
          expect(painted.span, 'a quiet step, never a wash').toBeLessThanOrEqual(400);
        } finally {
          await close();
        }
      });
});

/** A hand-held reader of what the engine is DOING, not what the sheet declares. */
interface MarkRead {
  readonly active: readonly {
    readonly target: string;
    readonly name: string;
    readonly state: string;
    readonly delay: number;
    readonly duration: number;
    readonly iterations: string;
    readonly easing: string;
  }[];
  readonly angle: readonly number[];
  readonly markOpacity: readonly number[];
  readonly opacity: Readonly<Record<string, readonly number[]>>;
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
          delay: Math.round(Number(timing?.delay ?? -1)),
          duration: Number(timing?.duration ?? -1),
          iterations: String(timing?.iterations ?? 'none'),
          easing: String(timing?.easing ?? ''),
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

/** The progress of a CSS `cubic-bezier(x1, y1, x2, y2)` at time fraction `t`, solved by bisection on x. */
const bezier = (x1: number, y1: number, x2: number, y2: number, t: number): number => {
  const at = (s: number, a: number, b: number): number => 3 * (1 - s) ** 2 * s * a + 3 * (1 - s) * s * s * b + s ** 3;
  let low = 0;
  let high = 1;
  for (let i = 0; i < 60; i += 1) {
    const mid = (low + high) / 2;
    if (at(mid, x1, x2) < t) low = mid;
    else high = mid;
  }
  return at((low + high) / 2, y1, y2);
};

// GEN Z: the star turns 360deg over 1100ms on cubic-bezier(.34, 1.56, .64, 1) (it overshoots, so the angle passes 360 and settles);
// each ray shrinks and fades 1 -> .3 over 1100ms, a quarter-beat behind the one before (negative delays: p1 0, p4 -275, p2 -550, p3 -825).
const GENZ_TIMES = [100, 275, 550, 900, 1_050] as const;
const GENZ_DELAY = { p1: 0, p4: -275, p2: -550, p3: -825 } as const;
const sparkle = (time: number, delay: number): number => 1 - 0.7 * (((time - delay) % 1_100) / 1_100);
const expectGenzSparkling = (read: MarkRead): void => {
  const marks = read.active.filter(animation => animation.target === 'mark');
  expect(marks.length, 'the star is one turning animation').toBe(1);
  expect(marks[0]).toMatchObject({
    name: 'fy-spinner-turn',
    state: 'running',
    duration: 1_100,
    iterations: 'Infinity',
  });
  const parts = read.active.filter(animation => animation.target !== 'mark');
  expect(parts.map(animation => `${animation.target}:${animation.delay}`).sort()).toEqual(
    ['p1:0', 'p2:-550', 'p3:-825', 'p4:-275'].sort(),
  );
  for (const animation of parts)
    expect(animation).toMatchObject({
      name: 'fy-genz-sparkle',
      state: 'running',
      duration: 1_100,
      iterations: 'Infinity',
    });
  for (const [index, time] of GENZ_TIMES.entries()) {
    const sprung = bezier(0.34, 1.56, 0.64, 1, time / 1_100) * 360;
    near(read.angle[index], ((sprung % 360) + 360) % 360, 0);
  }
  // The spring overshoots: late in the turn the star is past a full turn (reads as a small positive angle), not still short of one.
  expect(read.angle[4] as number, 'overshoot: past 360 by a little').toBeLessThan(20);
  for (const [part, delay] of Object.entries(GENZ_DELAY))
    for (const [index, time] of GENZ_TIMES.entries()) near(read.opacity[part]?.[index], sparkle(time, delay), 2);
  // At one instant the four rays are at four different brightnesses, not in unison.
  for (const index of [0, 1, 2])
    expect(new Set(['p1', 'p2', 'p3', 'p4'].map(part => read.opacity[part]?.[index]?.toFixed(2))).size).toBe(4);
};

// ANTI-POSH: the mark does not turn; four bars are drawn ONE AT A TIME, a quarter of 800ms each, in whole steps
// (negative delays: p1 0, p2 -600, p3 -400, p4 -200); at each sample exactly one bar is on, in the order p1 p2 p3 p4 p1.
const POSH_TIMES = [50, 250, 450, 650, 850] as const;
const POSH_ORDER = ['p1', 'p2', 'p3', 'p4', 'p1'] as const;
const expectPoshFlipping = (read: MarkRead): void => {
  expect(
    read.active.filter(animation => animation.target === 'mark'),
    'the mark itself does not turn',
  ).toEqual([]);
  const parts = read.active;
  expect(parts.map(animation => `${animation.target}:${animation.delay}`).sort()).toEqual(
    ['p1:0', 'p2:-600', 'p3:-400', 'p4:-200'].sort(),
  );
  for (const animation of parts)
    expect(animation).toMatchObject({
      name: 'fy-antiposh-flip',
      state: 'running',
      duration: 800,
      iterations: 'Infinity',
    });
  for (const [index, on] of POSH_ORDER.entries())
    for (const part of ['p1', 'p2', 'p3', 'p4'])
      expect(read.opacity[part]?.[index], `at ${POSH_TIMES[index]}ms only ${on} is drawn (${part})`).toBe(
        part === on ? 1 : 0,
      );
};

describe('the Gen Z and Anti-Posh spinners are really moving (live animations and phase, not declarations)', () => {
  for (const mode of MODES) {
    it(`Gen Z in ${mode}: a star turning on a spring, its four rays twinkling a quarter-beat apart`, async () => {
      const { tab, close } = await open(VIEWPORTS[0], mode, 'genz');
      try {
        const live = await readMark(tab, PROBE, GENZ_TIMES, false);
        report[`motion:genz:${mode}`] = live;
        expect(live.display, 'all four rays drawn').toEqual(['inline', 'inline', 'inline', 'inline']);
        expectGenzSparkling(live);
        const dead = await readMark(tab, PROBE, GENZ_TIMES, true);
        expect(dead.active, 'animation-name: none stops every animation').toEqual([]);
        expect(() => expectGenzSparkling(dead), 'the assert fails when the mark does not move').toThrow();
      } finally {
        await close();
      }
    });

    it(`Anti-Posh in ${mode}: a flipbook of | / - \\, one stroke at a time, in whole steps`, async () => {
      const { tab, close } = await open(VIEWPORTS[0], mode, 'antiposh');
      try {
        const live = await readMark(tab, PROBE, POSH_TIMES, false);
        report[`motion:antiposh:${mode}`] = live;
        expect(live.display).toEqual(['inline', 'inline', 'inline', 'inline']);
        expectPoshFlipping(live);
        const dead = await readMark(tab, PROBE, POSH_TIMES, true);
        expect(dead.active, 'animation-name: none stops every animation').toEqual([]);
        expect(() => expectPoshFlipping(dead), 'the assert fails when the mark does not move').toThrow();
      } finally {
        await close();
      }
    });

    for (const style of KITS)
      it(`${style} in ${mode}, reduced motion: every bar is drawn and the whole mark pulses in place`, async () => {
        const { tab, close } = await open(VIEWPORTS[0], mode, style);
        try {
          await tab.emulateMedia({ reducedMotion: 'reduce' });
          await tab.waitForTimeout(800);
          const expectPulse = (read: MarkRead): void => {
            expect(read.display, 'the bars stay drawn').toEqual(['inline', 'inline', 'inline', 'inline']);
            expect(read.active.map(animation => animation.name)).toEqual(['fy-spinner-pulse']);
            expect(read.active[0]).toMatchObject({ target: 'mark', state: 'running', duration: 1_600 });
            near(read.markOpacity[0], 1, 2);
            near(read.markOpacity[1], 0.72, 2);
            near(read.markOpacity[2], 1, 2);
            for (const part of ['p1', 'p2', 'p3', 'p4']) expect(read.opacity[part]).toEqual([1, 1, 1]);
          };
          const live = await readMark(tab, PROBE, [0, 800, 1_600], false);
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
 * A swatch draws ITS OWN style's mark, whatever the page is wearing: every swatch style is read on its OWN page (the reference), then
 * on a page of each of the others, and the two must match whole (ring, parts, every animation, every part's geometry). So the two
 * new styles' page rules must not reach a swatch of another style, and a swatch of theirs must draw whole on another style's page.
 */
const FINGERPRINT = `((selector) => {
  const svg = document.querySelector(selector);
  const props = (el) => { const c = getComputedStyle(el); return [c.display, c.animationName, c.animationDuration, c.animationDelay, c.animationTimingFunction, c.width, c.height, c.rx, c.transform, c.strokeWidth, c.strokeDasharray, c.scale, c.transformOrigin].join('/'); };
  return [props(svg), ...[...svg.querySelectorAll('*')].map((el) => (el.getAttribute('class') ?? '') + ':' + props(el))].join('|');
})`;
const SWATCH_STYLES = [
  'studio',
  'geist',
  'mission',
  'hud',
  'neo',
  'raw',
  'swiss',
  'exaggerated',
  'genz',
  'antiposh',
] as const;
const MIX_PAGES = ['studio', 'neo', 'genz', 'antiposh'] as const;

const fingerprintSwatches = async (page: string): Promise<Record<string, string>> => {
  const { tab, close } = await open(VIEWPORTS[0], 'light', page);
  try {
    const source = await tab.evaluate(selector => (document.querySelector(selector) as Element).outerHTML, PROBE);
    const out: Record<string, string> = {};
    for (const swatch of SWATCH_STYLES) {
      await tab.evaluate(
        ([style, markup]) => {
          const holder = document.createElement('div');
          holder.setAttribute('data-swatch', '');
          holder.setAttribute('data-style', style as string);
          holder.setAttribute('data-palette', 'studio');
          holder.setAttribute('data-mode', 'light');
          holder.id = `swatch-${style}`;
          holder.innerHTML = markup as string;
          document.body.append(holder);
        },
        [swatch, source] as const,
      );
      out[swatch] = (await tab.evaluate(`${FINGERPRINT}('#swatch-${swatch} svg')`)) as string;
    }
    return out;
  } finally {
    await close();
  }
};

describe('a swatch draws its own style’s spinner, on a page of any style (mixed page x swatch)', () => {
  it('every swatch style reads the same on a Studio, Neo, Gen Z and Anti-Posh page as on its own page', async () => {
    const own: Record<string, string> = {};
    for (const style of SWATCH_STYLES) own[style] = (await fingerprintSwatches(style))[style] as string;
    for (const page of MIX_PAGES) {
      const mixed = await fingerprintSwatches(page);
      for (const swatch of SWATCH_STYLES)
        expect(mixed[swatch], `${swatch} swatch on a ${page} page`).toBe(own[swatch] as string);
    }
    // The two new marks really are in the references (the comparison is not between two blanks).
    expect(own.genz).toContain('fy-genz-sparkle');
    expect(own.antiposh).toContain('fy-antiposh-flip');
    expect(own.studio).not.toContain('fy-genz-sparkle');
    expect(own.studio).not.toContain('fy-antiposh-flip');
  });
});

/**
 * EVERY CONTROL, mixed (the T6 / T9 reviews): a swatch of one style, put on a page of another, paints exactly as it does on a page of its
 * own style. The controls are the ones a kit styles: the button family, field, textarea, composer, menu, panel, tab and nav, badge, choice
 * card with its tick, segmented control, switch, progress, details and sheet. A Studio swatch on a Gen Z or Anti-Posh page must read as on
 * a Studio page, and a Gen Z or Anti-Posh swatch must read as on its own page (the own-swatch twin of each rule).
 */
const SWATCH_CONTROLS = `
  <button class="kt-btn" data-probe="btn">Outline</button>
  <button class="kt-btn" data-variant="primary" data-probe="btn-primary">Primary</button>
  <button class="kt-btn" data-variant="danger" data-probe="btn-danger">Danger</button>
  <button class="kt-btn" data-variant="ghost" data-probe="btn-ghost">Ghost</button>
  <input class="kt-input" data-probe="input">
  <textarea class="kt-input" data-probe="textarea-input"></textarea>
  <div class="kt-composer" data-probe="composer">Composer</div>
  <div class="kt-popover" role="menu" data-probe="menu"><div class="kt-menu-item" role="menuitem" data-probe="menu-item">Item</div></div>
  <section class="kt-panel" data-probe="panel"><header class="kt-panel__header"><span class="kt-label" data-probe="panel-label">Head</span></header><div class="kt-row" data-probe="row">Row</div></section>
  <div class="kt-tabbar" data-probe="tabbar"><button class="kt-tab" aria-selected="true" data-probe="tab">Tab</button><button class="kt-tab" aria-pressed="true" data-probe="chip">Chip</button></div>
  <span class="kt-badge" data-probe="badge">Badge</span>
  <div class="fy-cc__card" data-probe="card"><span class="fy-cc__title" data-probe="card-title">Card</span><span class="fy-cc__line" data-probe="card-line">line</span></div>
  <div class="fy-cc__card" data-selected="true" data-probe="card-selected"><span class="fy-cc__check" data-probe="tick"></span><span class="fy-cc__line" data-probe="card-selected-line">line</span></div>
  <div data-neo-segmented data-probe="segmented"><label data-probe="seg-off"><input type="radio" name="seg"><span>One</span></label><label data-probe="seg-on"><input type="radio" name="seg" checked><span>Two</span></label></div>
  <button role="switch" aria-checked="true" data-probe="switch"><span data-neo-switch-track data-probe="switch-track"><span data-neo-switch-thumb data-probe="switch-thumb"></span></span></button>
  <div class="fy-sp-progress__bar"><span class="fy-sp-progress__segment" data-state="done" data-probe="seg-done"></span><span class="fy-sp-progress__segment" data-state="current" data-probe="seg-current"></span></div>
  <div data-option-bar-track data-probe="bar"></div>
  <nav class="fy-settings-nav"><a class="fy-tab fy-tab--active" aria-current="page" href="#x" data-probe="nav-active"><span class="fy-icon" data-probe="nav-icon"></span>Active</a><a class="fy-tab" href="#y" data-probe="nav">Other</a></nav>
  <a href="#z" data-probe="link">link</a>
  <div class="kt-details" data-probe="details">Details</div>
  <div class="kt-sheet" data-probe="sheet">Sheet</div>`;

const readSwatchControls = (
  tab: Page,
  style: string,
  mode: 'light' | 'dark',
): Promise<Record<string, Record<string, string>>> =>
  tab.evaluate(
    ([markup, swatchStyle, swatchMode]) => {
      const holder = document.createElement('div');
      holder.setAttribute('data-swatch', '');
      holder.setAttribute('data-style', swatchStyle as string);
      holder.setAttribute('data-palette', 'studio');
      holder.setAttribute('data-mode', swatchMode as string);
      holder.style.cssText = 'background:var(--bg);color:var(--fg);font-family:var(--font-body)';
      holder.innerHTML = markup as string;
      document.body.append(holder);
      const out: Record<string, Record<string, string>> = {};
      for (const node of Array.from(holder.querySelectorAll<HTMLElement>('[data-probe]'))) {
        const css = getComputedStyle(node);
        out[node.dataset.probe as string] = {
          background: css.backgroundColor,
          image: css.backgroundImage,
          shadow: css.boxShadow,
          blur: css.backdropFilter,
          radius: css.borderTopLeftRadius,
          border: `${css.borderTopStyle} ${css.borderTopWidth} ${css.borderTopColor}`,
          borderBottom: `${css.borderBottomStyle} ${css.borderBottomWidth}`,
          weight: css.fontWeight,
          family: css.fontFamily,
          tracking: css.letterSpacing,
          transform: css.textTransform,
          padding: css.padding,
          transition: css.transitionProperty,
          rotate: css.rotate,
          translate: css.translate,
          outlineOffset: css.outlineOffset,
          colour: css.color,
          opacity: css.opacity,
        };
      }
      holder.remove();
      return out;
    },
    [SWATCH_CONTROLS, style, mode] as const,
  );

const readOnPage = async (
  page: string,
  swatch: string,
  mode: 'light' | 'dark',
  viewport: (typeof VIEWPORTS)[number] = VIEWPORTS[0],
): Promise<Record<string, Record<string, string>>> => {
  const { tab, close } = await open(viewport, mode, page);
  try {
    return await readSwatchControls(tab, swatch, mode);
  } finally {
    await close();
  }
};

describe('a swatch keeps its own control paint on a page of another style (mixed page x swatch, controls)', () => {
  for (const mode of MODES)
    it(`${mode}: Studio, Gen Z and Anti-Posh swatches each read the same on Studio, Gen Z and Anti-Posh pages as on their own`, async () => {
      for (const swatch of ['studio', 'genz', 'antiposh'] as const) {
        const want = await readOnPage(swatch, swatch, mode);
        for (const page of ['studio', 'genz', 'antiposh'] as const) {
          if (page === swatch) continue;
          const got = await readOnPage(page, swatch, mode);
          const drifted: string[] = [];
          for (const [control, props] of Object.entries(want))
            for (const [prop, value] of Object.entries(props))
              if (got[control]?.[prop] !== value)
                drifted.push(`${control}.${prop}: own page ${value} | ${page} page ${got[control]?.[prop]}`);
          report[`swatch-controls:${mode}:${swatch}-on-${page}`] = { controls: Object.keys(want).length, drifted };
          expect(drifted, `a ${swatch} swatch on a ${page} page (${mode}) drifted`).toEqual([]);
        }
      }
      // The controls are really styled by each kit (the comparison is not between three identical Studios).
      const studio = await readOnPage('studio', 'studio', mode);
      const genz = await readOnPage('genz', 'genz', mode);
      const posh = await readOnPage('antiposh', 'antiposh', mode);
      for (const probe of [
        'btn',
        'input',
        'card',
        'badge',
        'menu',
        'segmented',
        'tick',
        'switch-track',
        'nav-active',
      ]) {
        expect(JSON.stringify(genz[probe]), `genz ${probe} differs from Studio`).not.toBe(
          JSON.stringify(studio[probe]),
        );
        expect(JSON.stringify(posh[probe]), `antiposh ${probe} differs from Studio`).not.toBe(
          JSON.stringify(studio[probe]),
        );
      }
    });
});

/**
 * THE PHONE TILT (PR 2279 review). The Gen Z badge tilts -3deg and sits straight at 390. That phone rule was written for the page alone, so
 * at 390 a Gen Z swatch read -3deg on a Studio page and straight on a Gen Z one. Read at 390 (and at 1280, where the tilt is the style's
 * own and must stay), the Gen Z swatch's badge reads the same on a page of every style, and a Studio swatch never takes the tilt.
 */
describe('the Gen Z badge tilt at 390 follows the swatch, not the page (mixed page x swatch)', () => {
  for (const viewport of VIEWPORTS)
    for (const mode of MODES)
      it(`${viewport.name} ${mode}`, async () => {
        const want = viewport.phone ? 'none' : '-3deg';
        const tilts: Record<string, string> = {};
        for (const page of ['studio', 'genz', 'antiposh'] as const) {
          const genz = await readOnPage(page, 'genz', mode, viewport);
          const studio = await readOnPage(page, 'studio', mode, viewport);
          tilts[`genz swatch on ${page}`] = genz.badge?.rotate ?? '';
          tilts[`studio swatch on ${page}`] = studio.badge?.rotate ?? '';
        }
        report[`badge-tilt:${viewport.name}:${mode}`] = tilts;
        for (const page of ['studio', 'genz', 'antiposh'])
          expect(tilts[`genz swatch on ${page}`], `a Gen Z swatch badge on a ${page} page at ${viewport.name}`).toBe(
            want,
          );
        for (const page of ['studio', 'genz', 'antiposh'])
          expect(tilts[`studio swatch on ${page}`], `a Studio swatch badge on a ${page} page`).toBe('none');
      });
});

/**
 * FILLED CONTROLS (the T7 review). A style that moves its focus ring INSIDE a filled control must keep the ring >= 3:1 against that
 * fill; the busy mark on a filled Send keeps the button's foreground; the ring never sticks out of its control. Measured on the REAL
 * composer Send (`.fy-composer-send`, the shipped chat stylesheet) and the REAL selected Settings link, keyboard-focused, on the style's
 * default palette and on High contrast.
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
  width: number;
  offset: number;
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

describe('the filled Send and the selected Settings link keep a visible keyboard ring inside the control; the busy mark keeps its ink', () => {
  for (const style of KITS)
    for (const mode of MODES)
      for (const palette of [PALETTE[style], 'contrast'])
        it(`${style} in ${mode} on ${palette}: Send and the selected link are >= 3:1 on their fill, ring inside, busy mark >= 3:1`, async () => {
          const { tab, close } = await open(VIEWPORTS[0], mode, style, palette);
          try {
            await mountFilled(tab, 'body');
            const read = await readFilled(tab, 'body');
            report[`filled:${style}:${mode}:${palette}`] = read;
            for (const [name, stop] of [
              ['Send', read.send],
              ['selected Settings link', read.nav],
            ] as const) {
              expect(stop.focusVisible, `${name}: the keyboard focus draws :focus-visible`).toBe(true);
              expect(stop.ratio, `${name} ring vs its fill (${JSON.stringify(stop)})`).toBeGreaterThanOrEqual(3);
              expect(stop.offset + stop.width, `${name}: the ring never overhangs`).toBeLessThanOrEqual(0);
            }
            expect(read.busy.marks.length, 'the busy mark draws parts').toBeGreaterThan(0);
            // The mark is one figure (every bar is the button's own ink): its brightest bar must clear 3:1 on the fill.
            expect(
              Math.max(...read.busy.marks.map(mark => mark.ratio)),
              `busy mark vs the Send fill (${JSON.stringify(read.busy)})`,
            ).toBeGreaterThanOrEqual(3);
          } finally {
            await close();
          }
        });

  for (const style of KITS)
    it(`${style}: the filled-control rules do not leak into a Studio swatch (Send, busy mark and selected link paint as on a Studio page)`, async () => {
      for (const mode of MODES) {
        const reads: Record<string, FilledRead> = {};
        for (const page of ['studio', style] as const) {
          const { tab, close } = await open(VIEWPORTS[0], mode, page);
          try {
            await tab.evaluate(() => {
              const holder = document.createElement('div');
              holder.id = 'swatch-fix';
              holder.setAttribute('data-swatch', '');
              holder.setAttribute('data-style', 'studio');
              holder.setAttribute('data-palette', 'neo');
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
        const base = reads.studio as FilledRead;
        const mixed = reads[style] as FilledRead;
        for (const key of ['send', 'nav'] as const)
          for (const field of ['background', 'shadow', 'ringColour', 'offset', 'width'])
            expect(mixed[key][field], `${key}.${field} in a Studio swatch on a ${style} page (${mode})`).toEqual(
              base[key][field],
            );
        expect(mixed.busy, `the busy mark in a Studio swatch (${mode})`).toEqual(base.busy);
      }
    });
});

/**
 * RINGS NEVER CLIPPED (S13): every control a kit restyles is keyboard-focused inside a TIGHT clipping box (overflow hidden, no
 * padding), and its ring (outline, plus any outset box-shadow spread) lies inside that box. A positive offset or a shadow ring would be cut.
 */
const RING_CONTROLS = `
  <button class="kt-btn" data-ring="btn">Outline</button>
  <button class="kt-btn" data-variant="primary" data-ring="primary">Primary</button>
  <button class="kt-btn" data-variant="ghost" data-ring="ghost">Ghost</button>
  <input class="kt-input" data-ring="input">
  <textarea class="kt-input" data-ring="textarea"></textarea>
  <label class="fy-cc__card" data-ring="card"><input class="sr-only" type="radio" name="r1" data-ring-focus><span class="fy-cc__title">Card</span></label>
  <label class="fy-cc__card" data-selected="true" data-ring="card-selected"><input class="sr-only" type="radio" name="r2" checked data-ring-focus><span class="fy-cc__title">Card</span></label>
  <label class="fy-cc__card" data-ring="style-card"><input class="sr-only" type="radio" name="r3" data-ring-focus><span class="fy-ap-mini"><span class="fy-ap-mini__top"><b class="fy-ap-mini__type">Ag</b></span><span class="fy-ap-mini__bottom"><i class="fy-ap-mini__button"></i><i class="fy-ap-mini__card"></i></span></span><span class="fy-cc__title">Style</span></label>
  <label class="fy-cc__card" data-selected="true" data-ring="style-card-selected"><input class="sr-only" type="radio" name="r4" checked data-ring-focus><span class="fy-ap-mini"><span class="fy-ap-mini__top"><b class="fy-ap-mini__type">Ag</b></span><span class="fy-ap-mini__bottom"><i class="fy-ap-mini__button"></i><i class="fy-ap-mini__card"></i></span></span><span class="fy-cc__title">Style</span></label>
  <label class="fy-ap-chip" data-ring="chip"><input class="sr-only" type="radio" name="r5" data-ring-focus><span class="fy-ap-chip__name">Magenta</span></label>
  <label class="fy-ap-chip" data-selected="true" data-ring="chip-selected"><input class="sr-only" type="radio" name="r6" checked data-ring-focus><span class="fy-ap-chip__name">Magenta</span></label>
  <button class="kt-tab" aria-selected="true" data-ring="tab">Tab</button>
  <button class="fy-composer-send" data-ring="send">Send</button>
  <nav class="fy-settings-nav"><a class="fy-tab fy-tab--active" aria-current="page" href="#x" data-ring="nav">Active</a></nav>
  <div data-neo-segmented data-ring="segmented"><label><input type="radio" name="s" data-ring-focus><span>One</span></label></div>`;

describe('no focus ring of a kit sticks out of its control (a tight clipping box cuts nothing)', () => {
  for (const style of KITS)
    for (const mode of MODES)
      it(`${style} in ${mode}`, async () => {
        const { tab, close } = await open(VIEWPORTS[0], mode, style);
        try {
          await tab.evaluate(COLOUR_TOOLS);
          await tab.evaluate(async markup => {
            const clip = document.createElement('div');
            clip.id = 'ring-clip';
            clip.style.cssText = 'overflow:hidden;width:max-content;padding:0;display:flex;flex-direction:column;gap:0';
            clip.innerHTML = markup;
            document.body.prepend(clip);
          }, RING_CONTROLS);
          await tab.keyboard.press('Tab');
          const rows = (await tab.evaluate(() => {
            const out: { id: string; visible: boolean; reach: number; clipped: boolean; ratio: number }[] = [];
            const tools = (window as unknown as { __colour: ColourTools }).__colour;
            for (const holder of Array.from(document.querySelectorAll<HTMLElement>('#ring-clip [data-ring]'))) {
              const focusable = (holder.querySelector('[data-ring-focus]') ?? holder) as HTMLElement;
              focusable.focus({ focusVisible: true } as FocusOptions);
              const css = getComputedStyle(
                holder.matches(':has(:focus-visible)') && holder !== focusable ? holder : focusable,
              );
              const own = getComputedStyle(focusable);
              const drawn = css.outlineStyle !== 'none' ? css : own;
              const spread = (shadow: string): number => {
                let reach = 0;
                for (const part of shadow.split(/,(?![^(]*\))/u)) {
                  if (/inset/u.test(part)) continue;
                  const lengths = (part.match(/-?\d*\.?\d+px/gu) ?? []).map(Number.parseFloat);
                  reach = Math.max(reach, lengths[3] ?? 0);
                }
                return reach;
              };
              // The ring's outward reach beyond the border box: outline offset + width (when drawn), and any outset shadow spread that FOCUS adds.
              const outline =
                drawn.outlineStyle === 'none'
                  ? 0
                  : Number.parseFloat(drawn.outlineOffset) + Number.parseFloat(drawn.outlineWidth);
              const reach = Math.max(0, outline, spread(drawn.boxShadow) > 0 ? spread(drawn.boxShadow) : 0);
              const clipBox = (document.querySelector('#ring-clip') as HTMLElement).getBoundingClientRect();
              const box = holder.getBoundingClientRect();
              const clipped =
                box.left - reach < clipBox.left - 0.5 ||
                box.right + reach > clipBox.right + 0.5 ||
                box.top - reach < clipBox.top - 0.5 ||
                box.bottom + reach > clipBox.bottom + 0.5;
              const fill = tools.backdrop(holder);
              const ring = tools.rgba(drawn.outlineColor);
              out.push({
                id: holder.dataset.ring as string,
                visible: focusable.matches(':focus-visible'),
                reach,
                clipped,
                ratio: tools.ratio(tools.over(ring, [...fill, 1]), fill),
              });
            }
            return out;
          })) as { id: string; visible: boolean; reach: number; clipped: boolean; ratio: number }[];
          report[`ring:${style}:${mode}`] = rows;
          for (const row of rows) {
            expect(row.visible, `${row.id}: keyboard focus draws :focus-visible`).toBe(true);
            expect(row.reach, `${row.id}: the ring reaches 0px beyond its control`).toBe(0);
            expect(row.clipped, `${row.id}: the ring is inside the clipping box`).toBe(false);
            // A card (the Appearance style cards included), a palette chip and a field: the ring reads >= 3:1 on the control it is drawn on.
            if (/^(card|style-card|chip|input|textarea)/u.test(row.id))
              expect(row.ratio, `${row.id}: the ring is >= 3:1 on its control`).toBeGreaterThanOrEqual(3);
          }
        } finally {
          await close();
        }
      });
});

/**
 * THE CHOSEN CONTROLS' RING IS PAINTED CLEAR OF THEIR RULE AND READS >= 3:1 (the PR 2279 review + the T13 recheck). The shell's focus
 * colour is the accent, and the chosen segment of the Appearance Colour mode control and the chosen style card are filled with the
 * selection colour and ruled in ink: a ring in the focus colour over that fill measured 1.00:1 (Neo dark) to 1.98:1 / 1.65:1 (High
 * contrast light / dark), and a Gen Z style card's ring set on its own 3px rule measured 2.42:1 light. So each is read the way a viewer sees
 * it: a real key press focuses it, a real screenshot row across its left edge gives the pixel ON the ring, the pixel just inside it and the
 * pixel just outside it (grain held out of the sample, as in the theme matrix), and the ring must be 2px+, start 1px past the rule, and
 * read >= 3:1 on BOTH sides. Both viewports, both modes, the style's default palette, Neo and High contrast.
 */
const SEGMENTED = `<div data-neo-segmented role="radiogroup" aria-label="Colour mode" style="display:inline-flex">
  <label data-own><input class="sr-only" type="radio" name="cm" checked><span>Dark</span></label>
  <label><input class="sr-only" type="radio" name="cm"><span>Light</span></label></div>`;
const CHOSEN_CARD = `<label class="fy-cc__card" data-selected="true" data-own style="display:flex;width:160px"><input class="sr-only" type="radio" name="sc" checked><span class="fy-ap-mini"><span class="fy-ap-mini__top"><b class="fy-ap-mini__type">Ag</b></span><span class="fy-ap-mini__bottom"><i class="fy-ap-mini__button"></i><i class="fy-ap-mini__card"></i></span></span><span class="fy-cc__title">Style</span></label>`;
const PLAIN_CARD = CHOSEN_CARD.replace(' data-selected="true"', '').replace(' checked', '');

interface PaintedRing {
  visible: boolean;
  width: number;
  offset: number;
  rule: number;
  inside: number;
  outside: number;
  ring: string;
  gap: number;
}
const paintedRing = async (tab: Page, markup: string): Promise<PaintedRing> => {
  await tab.evaluate(m => {
    document.getElementById('paint-ring')?.remove();
    const holder = document.createElement('div');
    holder.id = 'paint-ring';
    holder.style.cssText = 'position:absolute;left:24px;top:24px;padding:24px;background:var(--surface);z-index:9';
    holder.innerHTML = m;
    document.body.append(holder);
  }, markup);
  await tab.keyboard.press('Tab'); // a real key press, so a focus() draws :focus-visible
  const geometry = await tab.evaluate(() => {
    const owner = document.querySelector('#paint-ring [data-own]') as HTMLElement;
    (owner.querySelector('input') as HTMLElement).focus({ focusVisible: true } as FocusOptions);
    const css = getComputedStyle(owner);
    const box = owner.getBoundingClientRect();
    return {
      visible: (owner.querySelector('input') as HTMLElement).matches(':focus-visible'),
      width: Number.parseFloat(css.outlineWidth),
      offset: Number.parseFloat(css.outlineOffset),
      rule: Number.parseFloat(css.borderLeftWidth),
      x: box.left + window.scrollX,
      y: box.top + window.scrollY + box.height / 2,
    };
  });
  expect(Math.abs(geometry.x - Math.round(geometry.x)), 'the control sits on a whole pixel').toBeLessThan(0.05);
  const left = Math.round(geometry.x) - 4;
  const png = (
    await tab.screenshot({
      clip: { x: left, y: Math.floor(geometry.y), width: 24, height: 1 },
      fullPage: true,
      scale: 'css',
      type: 'png',
    })
  ).toString('base64');
  const read = await tab.evaluate(
    async ([data, inner, width]) => {
      const bitmap = await createImageBitmap(
        new Blob([Uint8Array.from(atob(data as string), c => c.charCodeAt(0))], { type: 'image/png' }),
      );
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const g = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
      g.drawImage(bitmap, 0, 0);
      const d = g.getImageData(0, 0, bitmap.width, 1).data;
      // Depth `n` px inside the border box is the pixel at 4 + n.
      const at = (depth: number): number[] => {
        const i = (4 + Math.floor(depth)) * 4;
        return [d[i] ?? 0, d[i + 1] ?? 0, d[i + 2] ?? 0];
      };
      const tools = (window as unknown as { __colour: ColourTools }).__colour;
      const ring = at((inner as number) - (width as number) / 2);
      const near = at(inner as number);
      const far = at((inner as number) - (width as number) - 1);
      return {
        ring: `rgb(${ring.join(',')})`,
        inside: tools.ratio(ring, near),
        outside: tools.ratio(ring, far),
      };
    },
    [png, -geometry.offset, geometry.width] as const,
  );
  return {
    ...geometry,
    ...read,
    gap: -geometry.offset - geometry.width - geometry.rule,
  };
};

describe('the focused chosen segment and style card draw a ring clear of their rule that reads >= 3:1 on both sides', () => {
  for (const style of KITS)
    for (const viewport of VIEWPORTS)
      for (const mode of MODES)
        for (const palette of [PALETTE[style], 'neo', 'contrast'])
          it(`${style} ${viewport.name} ${mode} on ${palette}`, async () => {
            const { tab, close } = await open(viewport, mode, style, palette);
            try {
              await tab.evaluate(COLOUR_TOOLS);
              await tab.addStyleTag({ content: 'body::after { display: none !important; }' });
              const reads: Record<string, PaintedRing> = {};
              reads['chosen segment'] = await paintedRing(tab, SEGMENTED);
              reads['chosen card'] = await paintedRing(tab, CHOSEN_CARD);
              reads.card = await paintedRing(tab, PLAIN_CARD);
              report[`painted-ring:${style}:${viewport.name}:${mode}:${palette}`] = reads;
              for (const [name, read] of Object.entries(reads)) {
                const said = `${style} ${viewport.name} ${mode} ${palette} ${name} (${JSON.stringify(read)})`;
                expect(read.visible, `${said}: the keyboard focus draws :focus-visible`).toBe(true);
                expect(read.width, `${said}: the ring is >= 2px`).toBeGreaterThanOrEqual(2);
                // Gen Z's ring is clear of every rule it sits in; Anti-Posh's chosen segment too. Its cards keep the ring on their dashed
                // ink rule (the page's own ring, read >= 3:1 on both sides below), so only the segment's clearance is pinned there.
                if (style === 'genz' || name === 'chosen segment')
                  expect(read.gap, `${said}: the ring starts 1px past the rule, never on it`).toBeGreaterThanOrEqual(1);
                expect(read.inside, `${said}: the ring vs what is just inside it`).toBeGreaterThanOrEqual(3);
                expect(read.outside, `${said}: the ring vs what is just outside it`).toBeGreaterThanOrEqual(3);
              }
            } finally {
              await close();
            }
          });
});

/** Nothing is see-through when the OS asks for no transparency: every surface the kits paint is opaque or fully clear. */
describe('with prefers-reduced-transparency every kit surface is opaque', () => {
  for (const style of KITS)
    for (const mode of MODES)
      it(`${style} in ${mode}`, async () => {
        const { tab, close } = await open(VIEWPORTS[0], mode, style);
        try {
          const cdp = await tab.context().newCDPSession(tab);
          await cdp.send('Emulation.setEmulatedMedia', {
            features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
          });
          // Let the transitions the switch starts finish: a surface is read settled, not mid-fade.
          await tab.waitForTimeout(800);
          const read = await tab.evaluate(() => {
            const canvas = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
            if (canvas === null) throw new Error('no canvas');
            const alphaOf = (colour: string): number => {
              canvas.clearRect(0, 0, 1, 1);
              canvas.fillStyle = colour;
              canvas.fillRect(0, 0, 1, 1);
              return canvas.getImageData(0, 0, 1, 1).data[3] ?? 0;
            };
            const root = getComputedStyle(document.documentElement);
            const surfaces: Record<string, number> = {};
            for (const [name, selector] of [
              ['panel', '.kt-panel'],
              ['panel header', '.kt-panel__header'],
              ['button', '.kt-btn:not([data-variant])'],
              ['primary', '.kt-btn[data-variant="primary"]'],
              ['field', 'input.kt-input'],
              ['textarea', '[data-probe="textarea"]'],
              ['menu', '[role="menu"]'],
              ['badge', '.kt-badge'],
              ['choice card', '.fy-cc__card'],
              ['quote', '.md blockquote'],
              ['code', '.md pre'],
              ['table head', '.md th'],
              ['link', '.md a'],
            ] as const) {
              const el = document.querySelector(selector);
              if (el !== null) surfaces[name] = alphaOf(getComputedStyle(el).backgroundColor);
            }
            return {
              emulated: matchMedia('(prefers-reduced-transparency: reduce)').matches,
              surfaces,
              tokens: {
                hover: (() => {
                  const el = document.createElement('i');
                  document.body.append(el);
                  el.style.backgroundColor = root.getPropertyValue('--hover-fill');
                  const a = alphaOf(getComputedStyle(el).backgroundColor);
                  el.remove();
                  return a;
                })(),
                select: (() => {
                  const el = document.createElement('i');
                  document.body.append(el);
                  el.style.backgroundColor = root.getPropertyValue('--select-fill');
                  const a = alphaOf(getComputedStyle(el).backgroundColor);
                  el.remove();
                  return a;
                })(),
              },
            };
          });
          report[`reduced-transparency:${style}:${mode}`] = read;
          expect(read.emulated).toBe(true);
          for (const [name, alpha] of Object.entries(read.surfaces))
            expect([0, 255], `${style} ${mode}: ${name} alpha ${alpha}`).toContain(alpha);
          // The highlight and the smudge tokens (Anti-Posh's tints) are opaque too.
          if (style === 'antiposh') {
            expect(read.tokens.hover, 'the hover smudge').toBe(255);
            expect(read.tokens.select, 'the highlighter').toBe(255);
          }
        } finally {
          await close();
        }
      });
});

/**
 * Optional: `FY_GENZ_ANTIPOSH_KIT_SHOTS=<dir>` writes the fake-data specimen (the theme matrix scene) of Studio and each style, 1280 + 390,
 * light + dark, on the style's default palette, plus a close crop of each spinner at four fixed times: the shots the PR's verdict reads.
 */
describe.skipIf(shotsDirectory === '')('shots', () => {
  for (const style of ['studio', 'genz', 'antiposh'] as const)
    for (const viewport of VIEWPORTS)
      for (const mode of MODES)
        it(`${style} ${viewport.name} ${mode}`, async () => {
          const { tab, close } = await open(viewport, mode, style);
          try {
            // The specimen paints its own opaque page cover over the body; a shot of the STYLE shows the field it lays down (dots or grid, grain).
            await tab.addStyleTag({ content: '[data-specimen] { background: transparent !important; }' });
            await tab.screenshot({
              fullPage: false,
              path: join(shotsDirectory, `${style}-${viewport.name}-${mode}.png`),
            });
            if (viewport.name === '1280') {
              await tab.evaluate(selector => {
                const svg = document.querySelector(selector) as SVGElement;
                svg.setAttribute('width', '96');
                svg.setAttribute('height', '96');
              }, PROBE);
              for (const time of [50, 250, 450, 650]) {
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
                const box = await tab.locator(PROBE).boundingBox();
                if (box !== null)
                  await tab.screenshot({
                    clip: { x: box.x - 4, y: box.y - 4, width: box.width + 8, height: box.height + 8 },
                    fullPage: true,
                    path: join(shotsDirectory, `spinner-${style}-${mode}-${time}.png`),
                  });
              }
            }
          } finally {
            await close();
          }
        });
});
