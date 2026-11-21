/**
 * THE NEO-BRUTALISM + RAW BRUTALISM STYLE KITS (r11 T7), measured in a real browser on the theme matrix's specimen page
 * (`plugins/conversation/tests/integration/app/fixtures/theme-matrix-scene.tsx`), each style on its DEFAULT palette (Pop, the
 * `neo` palette id), in both modes at 1280 and 390.
 *
 * The owner's line (turn 4247, item 12): "BG and grainy-ness can help with the style too -- and ... components too, including
 * how markdown looks", "make sure things like spinner, animation all are unique to their style", "design each style to change
 * the hyper media completely -- some are like 'have shape', some feels flat", "most of them should not have gradient
 * background". So each style must FILL every slot of the component style contract with its own idiom, and the two brutalisms
 * must not read as one another:
 *
 *   Neo = a poster. A halftone dot field, no grain; a 3px-ruled display h1, a boxed code frame that casts the family's hard
 *         offset shadow, a ruled grid table under a highlighter header, links as marker strokes; a spinner that is a hard square
 *         HOPPING in whole steps over its own offset shadow; snappy stepped motion with a 2px press; hypermedia `block`.
 *   Raw = the unstyled web, kept on purpose. A plain flat page (no pattern, no grain); a ruled serif h1, a ruled box for code
 *         with NO shadow, an indented quote with no bar, a 2px grid table, underlined links; a spinner that is a plain outlined
 *         square whose corner marker JUMPS from corner to corner (four whole quarter-turns, nothing eases); no motion at all in
 *         the tokens; hypermedia `ink` (outlined, no offset: Raw casts no shadow of any kind).
 *
 * Set `FY_NEO_RAW_KIT_REPORT=<file>` to write the measured numbers (JSON), the values the PR body quotes.
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
const reportFile = process.env.FY_NEO_RAW_KIT_REPORT ?? '';

const MODES = ['light', 'dark'] as const;
const VIEWPORTS = [
  { name: '1280', width: 1_280, phone: false },
  { name: '390', width: 390, phone: true },
] as const;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;
const report: Record<string, unknown> = {};

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-neo-raw-kit-'));
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

/** One style on the Pop palette (`neo`), drawn with its real motion (a spinner's animation is read, not frozen). */
const open = async (
  viewport: (typeof VIEWPORTS)[number],
  mode: 'light' | 'dark',
  style: string,
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
    ([s, m]) => {
      const root = document.documentElement;
      root.setAttribute('data-style', s as string);
      root.setAttribute('data-palette', 'neo');
      root.setAttribute('data-mode', m as string);
    },
    [style, mode] as const,
  );
  await tab.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
  });
  // Let every colour transition the style switch started settle (a read or a shot taken mid-transition shows the previous mode's colours).
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
  const h1 = cs(q('.md h1'));
  const pre = cs(q('.md pre'));
  const quote = cs(q('.md blockquote'));
  const th = cs(q('.md th'));
  const td = cs(q('.md td'));
  const a = cs(q('.md a'));
  const li = cs(q('.md ul'));
  // A palette token as the colour it paints (through a probe element, so the string is the browser's own).
  const resolve = (name) => { const p = document.createElement('i'); p.style.backgroundColor = 'var(' + name + ')'; document.body.append(p); const c = getComputedStyle(p).backgroundColor; p.remove(); return c; };
  const nav = cs(q('[data-probe="nav"] .fy-tab--active'));
  return {
    navActive: { radius: nav.borderTopLeftRadius, bg: nav.backgroundColor, color: nav.color, weight: nav.fontWeight, shadow: nav.boxShadow },
    ink: { fg: resolve('--fg'), bg: resolve('--bg') },
    navSelBg: resolve('--nav-sel-bg'),
    accentSoft: resolve('--accent-soft'),
    layers: body.backgroundImage.split(/,(?![^()]*\\))/).map((layer) => layer.trim()),
    bgSize: body.backgroundSize,
    grain: { image: cs(document.body, '::after').backgroundImage, opacity: cs(document.body, '::after').opacity },
    panelTexture: cs(q('.kt-panel')).backgroundImage,
    h1: { case: h1.textTransform, rule: h1.borderBottomWidth + ' ' + h1.borderBottomStyle, weight: h1.fontWeight, size: h1.fontSize },
    pre: { radius: pre.borderTopLeftRadius, shadow: pre.boxShadow, border: pre.borderTopWidth + ' ' + pre.borderTopStyle },
    quote: { left: quote.borderLeftStyle + ' ' + quote.borderLeftWidth, bg: quote.backgroundColor !== 'rgba(0, 0, 0, 0)', pad: quote.paddingLeft },
    th: { case: th.textTransform, weight: th.fontWeight, bg: th.backgroundColor !== 'rgba(0, 0, 0, 0)' },
    td: { left: td.borderLeftStyle + ' ' + td.borderLeftWidth, bottom: td.borderBottomStyle + ' ' + td.borderBottomWidth },
    link: { decoration: a.textDecorationLine, weight: a.fontWeight, bg: a.backgroundColor !== 'rgba(0, 0, 0, 0)' },
    marker: li.listStyleType,
    spinner: {
      ring: ring.display,
      parts: [1, 2, 3, 4].map((n) => part(n).display),
      markAnimation: cs(spinner).animationName,
    },
    hm: { shape: token('--hm-shape'), edge: token('--hm-edge'), radius: token('--hm-radius'), stroke: token('--hm-stroke'), header: token('--hm-header'), fill: token('--hm-node-fill-alpha') },
    motion: { fast: token('--motion-fast'), base: token('--motion-base'), pop: token('--motion-pop'), press: token('--press-translate'), pick: token('--select-pop') },
    gradients: [...document.querySelectorAll('.kt-panel, .kt-btn, .kt-input, .kt-badge')].filter((el) => /gradient/.test(getComputedStyle(el).backgroundImage)).length,
  };
})()`;

/** A custom property is read back as authored or as the browser normalises it (`120ms` or `.12s`): compare the time. */
const milliseconds = (value: string): number =>
  value.endsWith('ms') ? Number.parseFloat(value) : Math.round(Number.parseFloat(value) * 1_000);

type Read = {
  navActive: { radius: string; bg: string; color: string; weight: string; shadow: string };
  ink: { fg: string; bg: string };
  navSelBg: string;
  accentSoft: string;
  layers: string[];
  bgSize: string;
  grain: { image: string; opacity: string };
  panelTexture: string;
  h1: { case: string; rule: string; weight: string; size: string };
  pre: { radius: string; shadow: string; border: string };
  quote: { left: string; bg: boolean; pad: string };
  th: { case: string; weight: string; bg: boolean };
  td: { left: string; bottom: string };
  link: { decoration: string; weight: string; bg: boolean };
  marker: string;
  spinner: { ring: string; parts: string[]; markAnimation: string };
  hm: { shape: string; edge: string; radius: string; stroke: string; header: string; fill: string };
  motion: { fast: string; base: string; pop: string; press: string; pick: string };
  gradients: number;
};

for (const style of ['neo', 'raw'] as const)
  for (const viewport of VIEWPORTS)
    for (const mode of MODES)
      describe(`the ${style} kit at ${viewport.name} in ${mode}`, () => {
        it('fills every slot of the component style contract with its own idiom', async () => {
          const { tab, close } = await open(viewport, mode, style);
          try {
            const read = (await tab.evaluate(READ)) as Read;
            report[`${style}:${viewport.name}:${mode}`] = read;
            // No gradient on any surface; no panel texture; no grain.
            expect(read.gradients, 'no gradient on a panel, button, field or badge').toBe(0);
            expect(read.panelTexture).toBe('none');
            expect(Number(read.grain.opacity), 'no grain').toBe(0);
            // Radius: nothing rounded in either brutalism.
            expect(read.pre.radius).toBe('0px');
            expect(read.hm.radius).toBe('0px');
            expect(read.hm.stroke).toBe('2px');
            // The selected item of the settings nav: a square block in the style's own idiom, never Studio's soft accent pill.
            expect(read.navActive.radius, 'a square selected item').toBe('0px');
            expect(read.navActive.bg, "not Studio's soft accent fill").not.toBe(read.accentSoft);
            // The markdown ruled heading.
            expect(read.h1.rule.endsWith('solid')).toBe(true);
            if (style === 'neo') {
              // BACKGROUND: a halftone dot field (the contract tile), no wash under it.
              expect(read.layers[0], 'the first layer is the dot tile').toMatch(/radial-gradient\(/u);
              expect(read.layers.slice(1).filter(layer => /gradient\(/u.test(layer))).toEqual([]);
              expect(read.bgSize.split(',')[0]).toBe('20px 20px');
              // MOTION: snappy and stepped; a hard 2px press; a big pick.
              expect(milliseconds(read.motion.base)).toBe(130);
              expect(milliseconds(read.motion.pop)).toBe(90);
              expect(read.motion.press).toBe('2px');
              expect(Number(read.motion.pick)).toBeGreaterThan(1.05);
              // HYPERMEDIA slots: hard blocks.
              expect(read.hm.shape).toBe('block');
              expect(read.hm.edge).toBe('straight');
              expect(read.hm.header).toBe('band');
              expect(Number(read.hm.fill)).toBe(1);
              // MARKDOWN: a heavy display h1 under a 3px rule; a boxed code frame with the offset shadow; a quote with no bar.
              expect(read.h1.rule).toBe('3px solid');
              expect(read.h1.weight).toBe('900');
              expect(read.pre.border).toBe('2px solid');
              expect(read.pre.shadow, 'the hard offset shadow').toMatch(/\d+px \d+px 0px/u);
              expect(read.quote.left, 'no side bar').toBe('none 0px');
              expect(read.quote.bg, 'a tinted block instead').toBe(true);
              expect(read.td.left).toBe('solid 2px');
              expect(read.th.bg, 'a highlighter header row').toBe(true);
              expect(read.th.case).toBe('uppercase');
              expect(read.link.bg, 'a marker stroke behind a link').toBe(true);
              expect(read.link.weight).toBe('800');
              expect(read.marker).toBe('square');
              // SPINNER: the ring is hidden and the mark does not turn; two parts (shadow + face) hop.
              expect(read.spinner.ring).toBe('none');
              expect(read.spinner.parts).toEqual(['inline', 'inline', 'none', 'none']);
              expect(read.spinner.markAnimation).toBe('none');
              // NAV: the selected item is the family's marker block with its offset shadow.
              expect(read.navActive.bg).toBe(read.navSelBg);
              expect(read.navActive.shadow, 'ruled and casting the hard offset').toMatch(/\d+px \d+px 0px/u);
            } else {
              // BACKGROUND: the plain page. No pattern, no wash, no grain.
              expect(read.layers.filter(layer => layer !== 'none')).toEqual([]);
              // MOTION: nothing eases, nothing pops, nothing travels.
              expect(milliseconds(read.motion.base)).toBe(0);
              expect(milliseconds(read.motion.pop)).toBe(0);
              expect(read.motion.press).toBe('0px');
              expect(Number(read.motion.pick)).toBe(1);
              // HYPERMEDIA slots: outlined ink, no offset (Raw casts no shadow).
              expect(read.hm.shape).toBe('ink');
              expect(read.hm.edge).toBe('orthogonal');
              expect(read.hm.header).toBe('label');
              expect(Number(read.hm.fill)).toBe(0);
              // MARKDOWN: a ruled mono h1; a ruled box for code with no shadow; an indented quote with no bar; a 2px grid; underlined links.
              expect(read.h1.rule).toBe('2px solid');
              expect(read.h1.weight).toBe('700');
              expect(read.pre.border).toBe('2px solid');
              expect(read.pre.shadow, 'no shadow of any kind').toBe('none');
              expect(read.quote.left, 'no side bar').toBe('none 0px');
              expect(read.quote.bg, 'plain paper').toBe(false);
              expect(Number.parseFloat(read.quote.pad), 'indented, as on the unstyled web').toBeGreaterThan(20);
              expect(read.td.left).toBe('solid 2px');
              expect(read.th.bg, 'a plain header row').toBe(false);
              expect(read.th.case).toBe('none');
              expect(read.link.decoration).toBe('underline');
              expect(read.link.bg).toBe(false);
              expect(read.marker).toBe('disc');
              // SPINNER: outlined square + a corner marker; the whole mark turns in whole quarter-turns.
              expect(read.spinner.ring).toBe('none');
              expect(read.spinner.parts).toEqual(['inline', 'inline', 'none', 'none']);
              expect(read.spinner.markAnimation).toBe('fy-spinner-turn');
              // NAV: the selected item is inverted ink on paper, ruled, with no shadow.
              expect(read.navActive.bg).toBe(read.ink.fg);
              expect(read.navActive.color).toBe(read.ink.bg);
              expect(read.navActive.shadow).toBe('none');
            }
          } finally {
            await close();
          }
        });
      });

/**
 * The pattern is really PAINTED, not only declared: with the specimen's own opaque page cover taken off, a 100 x 100 corner of
 * the page screenshot holds the Neo dot at the tile centre (a visible but quiet step from the ground, repeating every 20px),
 * and Raw's corner is ONE flat level (no pattern at all).
 */
describe('the field is painted as declared', () => {
  for (const style of ['neo', 'raw'] as const)
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
            const centres = [10, 30, 50, 70, 90].map(c => lum(c, c));
            const ground = lum(0, 0);
            return { distinct: levels.size, centres, ground };
          }, png)) as { distinct: number; centres: number[]; ground: number };
          report[`pattern:${style}:${mode}`] = painted;
          if (style === 'raw') {
            expect(painted.distinct, 'a flat page: one level').toBe(1);
          } else {
            expect(painted.distinct, 'dots on a ground').toBeGreaterThanOrEqual(2);
            const step = Math.abs(painted.centres[0]! - painted.ground);
            expect(step, 'a visible but quiet dot').toBeGreaterThanOrEqual(6);
            expect(step).toBeLessThanOrEqual(150);
            expect(new Set(painted.centres).size, 'every dot centre paints the same level (period 20px)').toBe(1);
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
 * and the mark's rotation (from its computed matrix) and each part's translation and opacity read back. Each test also runs
 * with `animation-name: none` injected and proves its own expectation throws.
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
  /** Each part's opacity and vertical translation at each sample time. */
  readonly opacity: Readonly<Record<string, readonly number[]>>;
  readonly lift: Readonly<Record<string, readonly number[]>>;
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
      const lift: Record<string, number[]> = { p1: [], p2: [], p3: [], p4: [] };
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
          lift[`p${index + 1}`]?.push(matrix(getComputedStyle(part).transform)[5] ?? 0);
          if (slot === 0) {
            const cs = getComputedStyle(part);
            box[`p${index + 1}`] = [cs.x, cs.y, cs.width, cs.height].map(v => Number.parseFloat(v));
          }
        }
      }
      for (const animation of owned) animation.play();
      const display = parts.map(part => getComputedStyle(part).display);
      injected?.remove();
      return { active, angle, markOpacity, opacity, lift, display, box };
    },
    [selector, times, disable, KILL_ANIMATIONS] as const,
  );

const PROBE = '[data-probe="spinner"] svg';
const near = (actual: number | undefined, expected: number, digits = 1): void =>
  expect(actual ?? Number.NaN).toBeCloseTo(expected, digits);

// NEO: the square hops 4 units up and back over 800ms in whole steps of 1 unit (`steps(4, end)` per half). Height at t:
// t < 400 -> -floor(t / 100); t >= 400 -> -4 + floor((t - 400) / 100). The shadow and the face move as one (delay 0 each).
const NEO_TIMES = [50, 150, 350, 450, 650, 750] as const;
const NEO_LIFT = [0, -1, -3, -4, -2, -1] as const;
const expectNeoHopping = (read: MarkRead): void => {
  expect(
    read.active.filter(animation => animation.target === 'mark'),
    'the mark itself does not turn',
  ).toEqual([]);
  const parts = read.active.filter(animation => animation.target !== 'mark');
  expect(
    parts.map(animation => animation.target).sort(),
    'the shadow and the face animate (the other two parts are not drawn)',
  ).toEqual(['p1', 'p2']);
  for (const animation of parts)
    expect(
      animation,
      `${animation.target}: the base stagger delay is reset, so shadow and face move as one`,
    ).toMatchObject({ name: 'fy-neo-hop', state: 'running', delay: 0, duration: 800, iterations: 'Infinity' });
  for (const [index, lift] of NEO_LIFT.entries()) {
    near(read.lift.p1?.[index], lift, 1);
    near(read.lift.p2?.[index], lift, 1);
  }
};

// RAW: the whole mark turns a quarter at every 300ms of its 1200ms turn (`steps(4, end)`): 0, 0, 90, 180, 270, 270 at these times.
const RAW_TIMES = [100, 290, 310, 610, 910, 1_190] as const;
const RAW_ANGLE = [0, 0, 90, 180, 270, 270] as const;
const expectRawJumping = (read: MarkRead): void => {
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
    'the box and its marker run no animation of their own: the whole figure jumps',
  ).toEqual([]);
  for (const [index, degrees] of RAW_ANGLE.entries()) near(read.angle[index], degrees, 0);
};

describe('the Neo and Raw spinners are really moving (live animations and phase, not declarations)', () => {
  for (const mode of MODES) {
    it(`Neo in ${mode}: a hard square hopping over its offset shadow, in whole steps`, async () => {
      const { tab, close } = await open(VIEWPORTS[0], mode, 'neo');
      try {
        const live = await readMark(tab, PROBE, NEO_TIMES, false);
        report[`motion:neo:${mode}`] = live;
        expect(live.display).toEqual(['inline', 'inline', 'none', 'none']);
        expectNeoHopping(live);
        // The shadow is the same square offset down and right (a hard offset, no blur), the face is above it.
        const [sx, sy, sw, sh] = live.box.p1 as number[];
        const [fx, fy, fw, fh] = live.box.p2 as number[];
        expect(sw).toBe(fw);
        expect(sh).toBe(fh);
        expect((sx as number) - (fx as number), 'the shadow is offset to the right').toBeGreaterThan(1);
        expect((sy as number) - (fy as number), 'and below').toBeGreaterThan(1);
        const dead = await readMark(tab, PROBE, NEO_TIMES, true);
        expect(dead.active, 'animation-name: none stops every animation').toEqual([]);
        expect(() => expectNeoHopping(dead), 'the assert fails when the mark does not move').toThrow();
      } finally {
        await close();
      }
    });

    it(`Raw in ${mode}: an outlined square whose corner marker jumps a quarter-turn at a time`, async () => {
      const { tab, close } = await open(VIEWPORTS[0], mode, 'raw');
      try {
        const live = await readMark(tab, PROBE, RAW_TIMES, false);
        report[`motion:raw:${mode}`] = live;
        expect(live.display).toEqual(['inline', 'inline', 'none', 'none']);
        expectRawJumping(live);
        const dead = await readMark(tab, PROBE, RAW_TIMES, true);
        expect(dead.active).toEqual([]);
        expect(() => expectRawJumping(dead), 'the assert fails when the mark does not move').toThrow();
      } finally {
        await close();
      }
    });

    for (const style of ['neo', 'raw'] as const)
      it(`${style} in ${mode}, reduced motion: the mark pulses in place and nothing hops or jumps`, async () => {
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
              expect(read.opacity[part], `${part} stays drawn`).toEqual([1, 1, 1]);
              expect(read.lift[part], `${part} stays at rest`).toEqual([0, 0, 0]);
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
  hud: {
    ring: 'inline',
    parts: ['inline', 'none', 'none', 'none'],
    animations: ['mark:fy-spinner-turn:1400', 'p1:fy-spinner-part:1400'],
  },
  neo: {
    ring: 'none',
    parts: ['inline', 'inline', 'none', 'none'],
    animations: ['p1:fy-neo-hop:800', 'p2:fy-neo-hop:800'],
  },
  raw: { ring: 'none', parts: ['inline', 'inline', 'none', 'none'], animations: ['mark:fy-spinner-turn:1200'] },
} as const;
type StyleId = keyof typeof SIGNATURE;

describe('a swatch draws its own style’s spinner, on a page of any style', () => {
  for (const pageStyle of ['studio', 'mission', 'hud', 'neo', 'raw'] as const)
    it(`on a ${pageStyle} page: Studio, Mission, HUD, Neo and Raw swatches each keep their own mark`, async () => {
      const { tab, close } = await open(VIEWPORTS[0], 'light', pageStyle);
      try {
        const source = await tab.evaluate(selector => (document.querySelector(selector) as Element).outerHTML, PROBE);
        for (const swatch of Object.keys(SIGNATURE) as StyleId[]) {
          const selector = `[data-swatch][data-style="${swatch}"] svg`;
          await tab.evaluate(
            ([style, markup]) => {
              const holder = document.createElement('div');
              holder.setAttribute('data-swatch', '');
              holder.setAttribute('data-style', style as string);
              holder.setAttribute('data-palette', 'neo');
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
 * Optional: `FY_NEO_RAW_KIT_SHOTS=<dir>` writes the fake-data specimen (the theme matrix scene) of each style, 1280 + 390, light +
 * dark, on the Pop palette (the default palette of both), plus a close crop of each spinner at four fixed times: the shots the PR's
 * verdict reads. Nothing is written otherwise.
 */
const shotsDirectory = process.env.FY_NEO_RAW_KIT_SHOTS ?? '';
describe.skipIf(shotsDirectory === '')('shots', () => {
  for (const style of ['studio', 'neo', 'raw'] as const)
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
              for (const time of [50, 350, 650, 910]) {
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
