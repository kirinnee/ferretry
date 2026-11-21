/**
 * THE SWISS + EXAGGERATED STYLE KITS (r11 T8), measured in a real browser on the theme matrix's specimen page
 * (`plugins/conversation/tests/integration/app/fixtures/theme-matrix-scene.tsx`), each style on its DEFAULT palette (Swiss: Blue,
 * the `geist` palette id; Exaggerated: Indigo, the `studio` palette id), in both modes at 1280 and 390.
 *
 * The owner's line (turn 4247, item 12): "BG and grainy-ness can help with the style too -- and ... components too, including
 * how markdown looks", "make sure things like spinner, animation all are unique to their style", "design each style to change
 * the hyper media completely", "text might be too large for some (like exaggerated minimalism)" and "most of them should not
 * have gradient background". Each style fills every slot of the component style contract with its own idiom:
 *
 *   Swiss       = a poster on a grid. A 24px baseline grid, no grain; a heavy ink rule over the page title, a hairline over each
 *                 section, a code block topped by the same heavy rule, a ruled table with BOLD CAPS heads, bold underlined links;
 *                 a spinner that is ONE BAR SWEEPING a hairline (a leader and a fainter trailer); linear, instant motion; flat
 *                 hypermedia with a heavy 2px stroke.
 *   Exaggerated = emptiness, enormous. One registration dot every 128px; thin titles, a quiet hairline under each section, a
 *                 light italic quote, a table of one hairline per row; a spinner that is a solid square BREATHING slowly inside a
 *                 hairline that RIPPLES outward; a long calm ease; flat hairline hypermedia. Display is capped (<= 3.25rem) and
 *                 the prose is 1rem.
 *
 * Set `FY_SWISS_EXAGGERATED_KIT_REPORT=<file>` to write the measured numbers (JSON), the values the PR body quotes, and
 * `FY_SWISS_EXAGGERATED_SHOTS_DIR=<dir>` to keep `<style>-<width>-<mode>.png` (the specimen page, fake data).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const conversationScenes = resolve(packageRoot, '../../../plugins/conversation/tests/integration/app/fixtures');
const reportFile = process.env.FY_SWISS_EXAGGERATED_KIT_REPORT ?? '';
const shotsDir = process.env.FY_SWISS_EXAGGERATED_SHOTS_DIR ?? '';

const MODES = ['light', 'dark'] as const;
const VIEWPORTS = [
  { name: '1280', width: 1_280, phone: false },
  { name: '390', width: 390, phone: true },
] as const;
/** Each kit's default palette id (T1's table: Swiss Blue = `geist`, Exaggerated Indigo = `studio`). */
const DEFAULT_PALETTE = { swiss: 'geist', exaggerated: 'studio' } as const;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;
const report: Record<string, unknown> = {};

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-mission-hud-kit-'));
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
  style: string,
  palette: string = DEFAULT_PALETTE[style as keyof typeof DEFAULT_PALETTE] ?? 'studio',
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
  const h1 = cs(q('.md h1'));
  const pre = cs(q('.md pre'));
  const quote = cs(q('.md blockquote'));
  const th = cs(q('.md th'));
  const td = cs(q('.md td'));
  const a = cs(q('.md a'));
  const md = cs(q('.md p'));
  const display = Math.max(...[...document.querySelectorAll('[data-specimen] h1, .fy-page h1')].map((h) => Number.parseFloat(getComputedStyle(h).fontSize)));
  const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return {
    layers: body.backgroundImage.split(/,(?![^()]*\\))/).map((layer) => layer.trim()),
    bgSize: body.backgroundSize,
    grain: { image: cs(document.body, '::after').backgroundImage, opacity: cs(document.body, '::after').opacity },
    panelTexture: cs(q('.kt-panel')).backgroundImage,
    h1: { rule: h1.borderBottomWidth + ' ' + h1.borderBottomStyle, weight: h1.fontWeight, size: Number.parseFloat(h1.fontSize) },
    h2: { rule: token('--md-h2-rule'), size: token('--md-h2-size') },
    pre: { radius: pre.borderTopLeftRadius, shadow: pre.boxShadow !== 'none', border: pre.borderTopWidth + ' ' + pre.borderTopStyle },
    quote: { left: quote.borderLeftStyle + ' ' + quote.borderLeftWidth, bg: quote.backgroundColor !== 'rgba(0, 0, 0, 0)', italic: quote.fontStyle, pad: Number.parseFloat(quote.paddingLeft) },
    th: { case: th.textTransform, weight: th.fontWeight },
    td: { left: td.borderLeftStyle, bottom: td.borderBottomStyle },
    link: { decoration: a.textDecorationLine + ' ' + a.textDecorationStyle, weight: a.fontWeight },
    prosePx: Number.parseFloat(md.fontSize),
    displayRem: display / rem,
    spinner: { ring: ring.display, parts: [1, 2, 3, 4].map((n) => part(n).display) },
    hm: { shape: token('--hm-shape'), edge: token('--hm-edge'), radius: token('--hm-radius'), stroke: token('--hm-stroke'), header: token('--hm-header'), fill: token('--hm-node-fill-alpha') },
    motion: { fast: token('--motion-fast'), base: token('--motion-base'), slow: token('--motion-slow'), pop: token('--motion-pop'), press: token('--press-translate'), select: token('--select-pop') },
    gradients: [...document.querySelectorAll('.kt-panel, .kt-btn, .kt-input, .kt-badge')].filter((el) => /gradient/.test(getComputedStyle(el).backgroundImage)).length,
  };
})()`;

/** A custom property is read back as authored or as the browser normalises it (`120ms` or `.12s`): compare the time. */
const milliseconds = (value: string): number =>
  value.endsWith('ms') ? Number.parseFloat(value) : Math.round(Number.parseFloat(value) * 1_000);

type Read = {
  layers: string[];
  bgSize: string;
  grain: { image: string; opacity: string };
  panelTexture: string;
  h1: { rule: string; weight: string; size: number };
  h2: { rule: string; size: string };
  pre: { radius: string; shadow: boolean; border: string };
  quote: { left: string; bg: boolean; italic: string; pad: number };
  th: { case: string; weight: string };
  td: { left: string; bottom: string };
  link: { decoration: string; weight: string };
  prosePx: number;
  displayRem: number;
  spinner: { ring: string; parts: string[] };
  hm: { shape: string; edge: string; radius: string; stroke: string; header: string; fill: string };
  motion: { fast: string; base: string; slow: string; pop: string; press: string; select: string };
  gradients: number;
};

for (const style of ['swiss', 'exaggerated'] as const)
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
            expect(read.bgSize.split(',')[0]).toBe(style === 'swiss' ? '24px 24px' : '128px 128px');
            expect(Number(read.grain.opacity), 'no grain').toBe(0);
            expect(read.panelTexture).toBe('none');
            expect(read.gradients, 'no gradient on a panel, button, field or badge').toBe(0);
            // HYPERMEDIA slots (read by r12 H5).
            expect(read.hm.shape).toBe('flat');
            expect(read.hm.edge).toBe('straight');
            expect(read.hm.radius).toBe('0px');
            expect(read.hm.fill).toBe('0');
            expect(read.hm.stroke).toBe(style === 'swiss' ? '2px' : '1px');
            expect(read.hm.header).toBe(style === 'swiss' ? 'band' : 'none');
            // MOTION.
            if (style === 'swiss') {
              expect(milliseconds(read.motion.base)).toBe(90);
              expect(milliseconds(read.motion.pop), 'a blink').toBe(50);
              expect(read.motion.select, 'no pop').toBe('1');
            } else {
              expect(milliseconds(read.motion.base), 'a long calm ease').toBe(360);
              expect(milliseconds(read.motion.pop)).toBe(420);
              expect(read.motion.select).toBe('1');
            }
            // THE OWNER'S "TOO LARGE" LINE (Exaggerated): display <= 3.25rem and prose 1rem at both widths; Swiss display stays small.
            expect(read.displayRem, 'the display text is no larger than 3.25rem').toBeLessThanOrEqual(3.25);
            if (style === 'exaggerated') {
              expect(read.prosePx, 'prose is 1rem to 1.1rem').toBeGreaterThanOrEqual(16);
              expect(read.prosePx).toBeLessThanOrEqual(17.6);
            }
            // MARKDOWN.
            expect(read.pre.radius, 'a square code block').toBe('0px');
            if (style === 'swiss') {
              expect(read.h1.rule, 'a heavy ink rule under the title').toBe('3px solid');
              expect(read.h1.weight).toBe('700');
              expect(read.h2.rule, 'a hairline under a section').toMatch(/^1px solid /u);
              expect(read.pre.shadow, 'the heavy rule across the top of a code block').toBe(true);
              expect(read.quote.left, 'no bar: a flat tinted block').toBe('none 0px');
              expect(read.quote.bg, 'a flat block of the surface step').toBe(true);
              expect(read.quote.italic).toBe('normal');
              expect(read.quote.pad).toBeGreaterThan(14);
              expect(read.th.case).toBe('uppercase');
              expect(read.th.weight).toBe('700');
              expect(read.td.left, 'rules only').toBe('none');
              expect(read.td.bottom).toBe('solid');
              expect(read.link.decoration).toBe('underline solid');
              expect(read.link.weight).toBe('700');
            } else {
              expect(read.h1.rule, 'no rule under the title').toBe('0px none');
              expect(read.h1.weight, 'a hair-thin title').toBe('200');
              expect(read.h1.size, 'the title is the big one').toBeGreaterThan(30);
              expect(read.h2.rule, 'one quiet hairline under a section').toMatch(/^1px solid /u);
              expect(read.pre.shadow, 'a plain ruled frame').toBe(false);
              expect(read.quote.left).toBe('none 0px');
              expect(read.quote.italic, 'a light italic quote').toBe('italic');
              expect(read.th.case).toBe('none');
              expect(read.td.left).toBe('none');
              expect(read.td.bottom).toBe('solid');
              expect(read.link.weight).toBe('400');
            }
            // SPINNER (the ring is hidden for both; the parts differ).
            expect(read.spinner.ring).toBe('none');
            expect(read.spinner.parts).toEqual(
              style === 'swiss' ? ['inline', 'inline', 'inline', 'none'] : ['none', 'inline', 'inline', 'none'],
            );
          } finally {
            await close();
          }
        });
      });

/** A regression guard: the style's own field and choice-card rings are drawn INSIDE the control (r11 S13 measure). */
describe('the Swiss and Exaggerated focus rings stay inside their control', () => {
  for (const style of ['swiss', 'exaggerated'] as const)
    for (const mode of MODES)
      it(`${style} in ${mode}`, async () => {
        const { tab, close } = await open(VIEWPORTS[0], mode, style);
        try {
          const ring = (await tab.evaluate(() => {
            const input = document.querySelector('input.kt-input') as HTMLInputElement;
            input.focus({ focusVisible: true } as FocusOptions);
            const cs = getComputedStyle(input);
            const field = {
              width: Number.parseFloat(cs.outlineWidth),
              offset: Number.parseFloat(cs.outlineOffset),
              style: cs.outlineStyle,
            };
            // A choice card (the scene has none): the style draws its own ring on the card when the control inside takes focus.
            const card = document.createElement('div');
            card.className = 'fy-cc__card';
            card.innerHTML = '<button type="button">Choose</button>';
            document.body.append(card);
            (card.querySelector('button') as HTMLElement).focus({ focusVisible: true } as FocusOptions);
            const tick = document.createElement('span');
            tick.className = 'fy-cc__check';
            card.append(tick);
            const tickRadius = getComputedStyle(tick).borderTopLeftRadius;
            const ccs = getComputedStyle(card);
            const cardRing = { style: ccs.outlineStyle, offset: Number.parseFloat(ccs.outlineOffset), tickRadius };
            card.remove();
            return { ...field, card: cardRing };
          })) as {
            width: number;
            offset: number;
            style: string;
            card: { style: string; offset: number; tickRadius: string };
          };
          report[`ring:${style}:${mode}`] = ring;
          expect(ring.style).toBe('solid');
          expect(ring.width).toBeGreaterThanOrEqual(2);
          expect(ring.offset).toBeLessThanOrEqual(-ring.width);
          expect(ring.card.offset, "a choice card's own ring is never outside it").toBeLessThanOrEqual(0);
          expect(ring.card.tickRadius, "the chosen card's tick is square, not a round badge").toBe('0px');
        } finally {
          await close();
        }
      });
});

/**
 * The pattern is really PAINTED, not only declared: with the specimen's own opaque page cover taken off, a 160 x 160 corner of
 * the page screenshot holds the style's marks (Swiss: a 1px baseline every 24px; Exaggerated: one dot per 128px tile, at its
 * centre), each a visible but quiet step from the ground (a few levels of 255, never a wash).
 */
describe('the field pattern is painted', () => {
  for (const style of ['swiss', 'exaggerated'] as const)
    for (const mode of MODES)
      it(`${style} in ${mode}`, async () => {
        const { tab, close } = await open(VIEWPORTS[0], mode, style);
        try {
          await tab.addStyleTag({
            content:
              '[data-specimen] { background: transparent !important; } [data-specimen] * { visibility: hidden !important; }',
          });
          const png = (await tab.screenshot({ clip: { x: 0, y: 0, width: 160, height: 160 }, type: 'png' })).toString(
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
            const rowsDiffering = new Set<number>();
            let low = Number.POSITIVE_INFINITY;
            let high = 0;
            let previous = -1;
            for (let y = 0; y < bitmap.height; y += 1) {
              let rowSum = 0;
              for (let x = 0; x < bitmap.width; x += 1) {
                const i = (y * bitmap.width + x) * 4;
                const v = (d[i] ?? 0) + (d[i + 1] ?? 0) + (d[i + 2] ?? 0);
                levels.add(v);
                low = Math.min(low, v);
                high = Math.max(high, v);
                rowSum += v;
              }
              if (previous !== -1 && rowSum !== previous) rowsDiffering.add(y);
              previous = rowSum;
            }
            return { distinct: levels.size, span: high - low, changes: rowsDiffering.size, scale: bitmap.width / 160 };
          }, png)) as { distinct: number; span: number; changes: number; scale: number };
          report[`pattern:${style}:${mode}`] = painted;
          expect(painted.distinct, 'lines or dots on a ground').toBeGreaterThanOrEqual(2);
          // Three channels summed: at least 6 (about 2 of 255 each) and at most 150 (about 50 each).
          expect(painted.span).toBeGreaterThanOrEqual(6);
          expect(painted.span).toBeLessThanOrEqual(150);
          // Swiss: a baseline every 24px, so 160px holds 6 rules (each is 2 row changes: on, off); Exaggerated: one small dot only.
          if (style === 'swiss') expect(painted.changes).toBeGreaterThanOrEqual(10);
          else expect(painted.changes).toBeLessThanOrEqual(12);
        } finally {
          await close();
        }
      });
});

/**
 * THE SPINNERS ARE REALLY MOVING (r11 T6 review item 2). The computed `animation-duration` and `animation-timing-function` read
 * above are DECLARATIONS: forcing `animation-name: none !important` on the mark left every one of them passing. These read what
 * the engine is DOING: the live CSS animations on the mark, then every one paused at the same fixed times and the mark's
 * rotation (from its computed matrix) and each part's opacity read back (the STYLE KITS rule: the assert must FAIL with
 * `animation-name: none`; each test below also runs with that injected and proves its own expectation throws).
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
      // CSS animations only (a CSS transition, such as the arc's one-frame dash change under reduced motion, is not the mark's motion).
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

/** A part's computed transform as [scale, translateX, translateY] (the styles use scale + translate only). */
const transformsAt = (
  tab: Page,
  selector: string,
  part: number,
  times: readonly number[],
  disable: boolean,
): Promise<number[][]> =>
  tab.evaluate(
    ([target, n, sampleAt, kill, css]) => {
      let injected: HTMLStyleElement | undefined;
      if (kill) {
        injected = document.createElement('style');
        injected.textContent = css as string;
        document.head.append(injected);
      }
      const svg = document.querySelector(target as string) as SVGElement;
      const el = svg.querySelector(`.fy-spinner__p${n as number}`) as SVGElement;
      const owned = document.getAnimations().filter(animation => {
        const element = (animation.effect as KeyframeEffect).target as Element;
        return animation instanceof CSSAnimation && (element === svg || svg.contains(element));
      });
      const out: number[][] = [];
      for (const time of sampleAt as readonly number[]) {
        for (const animation of owned) {
          animation.pause();
          animation.currentTime = time;
        }
        const m = /matrix\(([^)]+)\)/u.exec(getComputedStyle(el).transform);
        const [a = 1, , , d = 1, e = 0, f = 0] = (m?.[1] ?? '1,0,0,1,0,0').split(',').map(Number);
        out.push([a, d, e, f]);
      }
      for (const animation of owned) animation.play();
      injected?.remove();
      return out;
    },
    [selector, part, times, disable, KILL_ANIMATIONS] as const,
  );

// SWISS: ONE BAR SWEEPING a hairline. Part 1 is the leading bar (5 x 2 units); it slides 9 units, left to right, in 1100ms, linear.
// Part 3 is the trailing bar, the same sweep 12% of a turn (132ms) behind, held at its start until then. Part 2 is the hairline it runs on.
const SWISS_TIMES = [0, 275, 550, 825] as const;
const expectSwissSweeping = (read: MarkRead, lead: number[][], trail: number[][]): void => {
  expect(
    read.active.filter(animation => animation.target === 'mark'),
    'the mark itself does not turn',
  ).toEqual([]);
  expect(read.active.map(animation => `${animation.target}:${animation.name}`).sort()).toEqual([
    'p1:fy-swiss-lead',
    'p3:fy-swiss-trail',
  ]);
  for (const target of ['p1', 'p3']) {
    const one = read.active.find(animation => animation.target === target);
    expect(one).toMatchObject({ state: 'running', duration: 1_100, iterations: 'Infinity' });
  }
  // The stagger: the trailer starts 132ms after the leader (the shorthand on a part resets delay: the style restates it).
  expect(read.active.find(animation => animation.target === 'p1')?.delay).toBe(0);
  near(read.active.find(animation => animation.target === 'p3')?.delay, 132, 0);
  // Phase: tx = 9 * t / 1100 for the leader; the trailer is at its start until 132ms, then the same line shifted.
  for (const [index, time] of SWISS_TIMES.entries()) {
    near(lead[index]?.[2], (9 * time) / 1_100, 1);
    near(trail[index]?.[2], (9 * Math.max(0, time - 132)) / 1_100, 1);
    // A bar, not a square: 5 wide, 2 tall (the 6-unit part scaled to 0.8333 x 0.3333).
    near(lead[index]?.[0], 5 / 6, 3);
    near(lead[index]?.[1], 2 / 6, 3);
  }
};

// EXAGGERATED: a solid square BREATHING (scale .3 -> 1 -> .3 over 3200ms) inside a hairline that RIPPLES outward (scale .4 -> 2.3, fading,
// the same 3200ms, a half turn behind: delay 1600ms).
const EXAGGERATED_TIMES = [0, 1_600, 3_200] as const;
const expectExaggeratedBreathing = (
  read: MarkRead,
  breathe: number[][],
  ripple: number[][],
  rippleOpacity: readonly number[],
): void => {
  expect(
    read.active.filter(animation => animation.target === 'mark'),
    'the mark itself does not turn',
  ).toEqual([]);
  const names = read.active.map(animation => `${animation.target}:${animation.name}`).sort();
  expect(names).toEqual(['p2:fy-exaggerated-breathe', 'p3:fy-exaggerated-ripple']);
  for (const one of read.active)
    expect(one).toMatchObject({ state: 'running', duration: 3_200, iterations: 'Infinity' });
  // The stagger: the ripple starts half a turn after the breath.
  expect(read.active.find(animation => animation.target === 'p2')?.delay).toBe(0);
  expect(read.active.find(animation => animation.target === 'p3')?.delay).toBe(1_600);
  // The breath: .3 at the start, 1 at half a turn, .3 again at the end of the turn (the next turn begins).
  near(breathe[0]?.[0], 0.3, 2);
  near(breathe[1]?.[0], 1, 2);
  near(breathe[2]?.[0], 0.3, 2);
  // The ripple: held at its start (.4, .9 opaque) through its delay, then half way across (1.35, .45) a half turn after that.
  near(ripple[0]?.[0], 0.4, 2);
  near(ripple[1]?.[0], 0.4, 2);
  near(ripple[2]?.[0], 1.35, 2);
  near(rippleOpacity[0], 0.9, 2);
  near(rippleOpacity[1], 0.9, 2);
  near(rippleOpacity[2], 0.45, 2);
};

const readSwiss = async (tab: Page, disable: boolean) => {
  const read = await readMark(tab, PROBE, SWISS_TIMES, disable);
  // (the transform samples are read in a second pass with the same animations paused at the same times)
  const lead = await transformsAt(tab, PROBE, 1, SWISS_TIMES, disable);
  const trail = await transformsAt(tab, PROBE, 3, SWISS_TIMES, disable);
  return { read, lead, trail };
};
const readExaggerated = async (tab: Page, disable: boolean) => {
  const read = await readMark(tab, PROBE, EXAGGERATED_TIMES, disable);
  const breathe = await transformsAt(tab, PROBE, 2, EXAGGERATED_TIMES, disable);
  const ripple = await transformsAt(tab, PROBE, 3, EXAGGERATED_TIMES, disable);
  return { read, breathe, ripple, rippleOpacity: read.opacity.p3 as readonly number[] };
};

describe('the Swiss and Exaggerated spinners are really moving (live animations and phase, not declarations)', () => {
  for (const mode of MODES) {
    it(`Swiss in ${mode}: a bar sweeping a hairline, a trailer 132ms behind`, async () => {
      const { tab, close } = await open(VIEWPORTS[0], mode, 'swiss');
      try {
        const live = await readSwiss(tab, false);
        report[`motion:swiss:${mode}`] = live;
        expect(live.read.display).toEqual(['inline', 'inline', 'inline', 'none']);
        expectSwissSweeping(live.read, live.lead, live.trail);
        // The hairline is still: no animation on it.
        expect(live.read.active.some(animation => animation.target === 'p2')).toBe(false);
        const dead = await readSwiss(tab, true);
        expect(dead.read.active, 'animation-name: none stops every animation').toEqual([]);
        expect(
          () => expectSwissSweeping(dead.read, dead.lead, dead.trail),
          'fails when the bar does not move',
        ).toThrow();
      } finally {
        await close();
      }
    });

    it(`Exaggerated in ${mode}: a square breathing, a hairline rippling a half turn behind`, async () => {
      const { tab, close } = await open(VIEWPORTS[0], mode, 'exaggerated');
      try {
        const live = await readExaggerated(tab, false);
        report[`motion:exaggerated:${mode}`] = live;
        expect(live.read.display).toEqual(['none', 'inline', 'inline', 'none']);
        expectExaggeratedBreathing(live.read, live.breathe, live.ripple, live.rippleOpacity);
        const dead = await readExaggerated(tab, true);
        expect(dead.read.active, 'animation-name: none stops every animation').toEqual([]);
        expect(
          () => expectExaggeratedBreathing(dead.read, dead.breathe, dead.ripple, dead.rippleOpacity),
          'fails when the square does not breathe',
        ).toThrow();
      } finally {
        await close();
      }
    });

    for (const style of ['swiss', 'exaggerated'] as const)
      it(`${style} in ${mode}, reduced motion: the visible parts pulse in place (the ring is hidden, so it cannot)`, async () => {
        const { tab, close } = await open(VIEWPORTS[0], mode, style);
        try {
          await tab.emulateMedia({ reducedMotion: 'reduce' });
          const shown =
            style === 'swiss' ? ['inline', 'inline', 'inline', 'none'] : ['none', 'inline', 'inline', 'none'];
          const expectPulse = (read: MarkRead): void => {
            expect(read.display, 'the parts stay drawn').toEqual(shown);
            expect(read.active.map(animation => animation.name)).toEqual(['fy-spinner-pulse']);
            expect(read.active[0]).toMatchObject({ target: 'mark', state: 'running', duration: 1_600 });
            near(read.markOpacity[0], 1, 2);
            near(read.markOpacity[1], 0.72, 2);
            near(read.markOpacity[2], 1, 2);
          };
          const live = await readMark(tab, PROBE, [0, 800, 1_600], false);
          report[`motion:${style}-reduced:${mode}`] = live;
          expectPulse(live);
          const dead = await readMark(tab, PROBE, [0, 800, 1_600], true);
          expect(() => expectPulse(dead), 'fails when the mark does not pulse').toThrow();
        } finally {
          await close();
        }
      });
  }
});

/**
 * A swatch draws ITS OWN style's mark, whatever the page is wearing (the T6 review's item 3, now for Swiss and Exaggerated):
 * every page style x every swatch style, each swatch's mark read back whole. A Swiss rule that leaked would show a bar sweep in a
 * Studio swatch; an Exaggerated one would hide the ring of a Studio or HUD swatch.
 */
const SIGNATURE = {
  studio: { ring: 'inline', parts: ['none', 'none', 'none', 'none'], animations: ['mark:fy-spinner-turn:900'] },
  mission: {
    ring: 'none',
    parts: ['inline', 'inline', 'inline', 'inline'],
    animations: ['mark:fy-spinner-turn:2400'],
  },
  hud: {
    ring: 'inline',
    parts: ['inline', 'none', 'none', 'none'],
    animations: ['mark:fy-spinner-turn:1400', 'p1:fy-spinner-part:1400'],
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
  },
  swiss: {
    ring: 'none',
    parts: ['inline', 'inline', 'inline', 'none'],
    animations: ['p1:fy-swiss-lead:1100', 'p3:fy-swiss-trail:1100'],
  },
  exaggerated: {
    ring: 'none',
    parts: ['none', 'inline', 'inline', 'none'],
    animations: ['p2:fy-exaggerated-breathe:3200', 'p3:fy-exaggerated-ripple:3200'],
  },
} as const;
type StyleId = keyof typeof SIGNATURE;

describe('a swatch draws its own style’s spinner, on a page of any style', () => {
  for (const pageStyle of ['studio', 'swiss', 'exaggerated', 'mission', 'hud'] as const)
    it(`on a ${pageStyle} page: every swatch style keeps its own mark`, async () => {
      const { tab, close } = await open(VIEWPORTS[0], 'light', pageStyle, 'studio');
      try {
        for (const swatch of Object.keys(SIGNATURE) as StyleId[]) {
          const selector = `[data-swatch][data-style="${swatch}"] svg`;
          await tab.evaluate(
            ([style, source]) => {
              const holder = document.createElement('div');
              holder.setAttribute('data-swatch', '');
              holder.setAttribute('data-style', style as string);
              holder.setAttribute('data-palette', 'studio');
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
 * The same boundary for CONTROLS (the PR 2270 review, item 1): a swatch draws ITS OWN style's controls, whatever the page is
 * wearing. The reference is each style's controls on a page of that style; every swatch of that style, on a page of any style,
 * must read back the same values. A Swiss page rule that leaked would square a Studio swatch's round choice tick; an Exaggerated
 * one would strip the fills of a Studio swatch's input and tick.
 */
const CONTROL_PROBE = `<div class="fy-cc__card" data-selected="true" data-probe-control="card"><span class="fy-cc__check" data-probe-control="check"></span></div><input class="kt-input" data-probe-control="input"><span class="kt-badge" data-probe-control="badge">x</span><div class="kt-bubble" data-probe-control="bubble">x</div><div data-neo-segmented data-probe-control="segmented"><label><input type="radio" checked>x</label></div>`;
const readControls = async (tab: Page, holderSelector: string): Promise<Record<string, Record<string, string>>> =>
  await tab.evaluate(holder => {
    const out: Record<string, Record<string, string>> = {};
    for (const el of document.querySelectorAll(`${holder} [data-probe-control]`)) {
      const style = getComputedStyle(el);
      out[el.getAttribute('data-probe-control') as string] = {
        backgroundColor: style.backgroundColor,
        borderColor: style.borderTopColor,
        borderRadius: style.borderTopLeftRadius,
        borderWidth: style.borderTopWidth,
        boxShadow: style.boxShadow,
        outlineOffset: style.outlineOffset,
      };
    }
    return out;
  }, holderSelector);
const mountControls = async (tab: Page, id: string, swatchStyle: string | null): Promise<void> => {
  await tab.evaluate(
    ([holderId, style, source]) => {
      const holder = document.createElement('div');
      holder.id = holderId as string;
      if (style !== null) {
        holder.setAttribute('data-swatch', '');
        holder.setAttribute('data-style', style as string);
        holder.setAttribute('data-palette', 'studio');
        holder.setAttribute('data-mode', 'light');
      }
      holder.innerHTML = source as string;
      document.body.append(holder);
    },
    [id, swatchStyle, CONTROL_PROBE] as const,
  );
};

describe('a swatch draws its own style’s controls, on a page of any style', () => {
  // HUD is not in this list: its own page rules still reach a swatch of another style (and its own swatch loses them), which is
  // the HUD kit's to scope, not this PR's. Studio, Swiss, Exaggerated and Mission hold the boundary.
  const PAGES = ['studio', 'swiss', 'exaggerated', 'mission'] as const;
  const reference: Record<string, Record<string, Record<string, string>>> = {};
  beforeAll(async () => {
    for (const style of PAGES) {
      const { tab, close } = await open(VIEWPORTS[0], 'light', style, 'studio');
      try {
        await mountControls(tab, 'reference', null);
        reference[style] = await readControls(tab, '#reference');
      } finally {
        await close();
      }
    }
    // The reference has to tell the styles apart, or the comparison below proves nothing.
    expect(reference.swiss?.check?.borderRadius).toBe('0px');
    expect(reference.studio?.check?.borderRadius).not.toBe('0px');
    expect(reference.exaggerated?.input?.backgroundColor).toBe('rgba(0, 0, 0, 0)');
    expect(reference.studio?.input?.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
  }, 180_000);

  for (const pageStyle of PAGES)
    it(`on a ${pageStyle} page: every swatch style keeps its own controls`, async () => {
      const { tab, close } = await open(VIEWPORTS[0], 'light', pageStyle, 'studio');
      try {
        for (const swatch of PAGES) {
          await mountControls(tab, `swatch-${swatch}`, swatch);
          const got = await readControls(tab, `#swatch-${swatch}`);
          report[`controls:${pageStyle}:${swatch}`] = got;
          expect(got, `${swatch} swatch on a ${pageStyle} page`).toEqual(reference[swatch] as typeof got);
        }
      } finally {
        await close();
      }
    });
});

/** Shots (only when FY_SWISS_EXAGGERATED_SHOTS_DIR is set): the specimen page per style, width and mode, fake data. The style's own
 * motion is waited out (a colour transition caught half way is not the style), the specimen's opaque cover is taken off so the page
 * pattern shows, and the spinner is shot again at 8x. */
describe.skipIf(shotsDir === '')('the specimen shots', () => {
  for (const style of ['swiss', 'exaggerated'] as const)
    for (const viewport of VIEWPORTS)
      for (const mode of MODES)
        it(`${style} ${viewport.name} ${mode}`, async () => {
          const { tab, close } = await open(viewport, mode, style);
          try {
            await tab.addStyleTag({
              content:
                'html, body { height: auto !important; overflow: visible !important; } [data-specimen] { background: transparent !important; }',
            });
            await tab.waitForTimeout(1_200);
            await tab.screenshot({ path: join(shotsDir, `${style}-${viewport.name}-${mode}.png`), fullPage: true });
            if (viewport.name === '1280') {
              // Frozen mid-motion (the bar a third of the way along; the ripple a quarter into its turn), so the shot shows the figure.
              await tab.evaluate(
                frame => {
                  const svg = document.querySelector('[data-probe="spinner"] svg') as SVGElement;
                  svg.setAttribute('width', '96');
                  svg.setAttribute('height', '96');
                  for (const animation of document.getAnimations()) {
                    animation.pause();
                    animation.currentTime = frame;
                  }
                },
                style === 'swiss' ? 400 : 2_600,
              );
              await (await tab.$('[data-probe="spinner"]'))?.screenshot({
                path: join(shotsDir, `${style}-spinner-${mode}.png`),
              });
            }
          } finally {
            await close();
          }
        });
});
