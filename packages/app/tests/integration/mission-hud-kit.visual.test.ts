/**
 * THE MISSION + HUD STYLE KITS (r11 T6), measured in a real browser on the theme matrix's specimen page
 * (`plugins/conversation/tests/integration/app/fixtures/theme-matrix-scene.tsx`), each style on its DEFAULT palette (Teal, the
 * `mission` palette id), in both modes at 1280 and 390.
 *
 * The owner's line (turn 4247, item 12): "BG and grainy-ness can help with the style too -- and ... components too, including
 * how markdown looks", "make sure things like spinner, animation all are unique to their style", "design each style to change
 * the hyper media completely", and "most of them should not have gradient background". So each style must FILL every slot of
 * the component style contract with its own idiom, not with a padding tweak:
 *
 *   Mission = an instrument. A ruled 32px grid and no grain; ruled uppercase headings, a registered double-line code frame, a
 *             dashed dimension-line quote and a grid table; a spinner of four turning corner brackets; linear, snappy motion
 *             and a press that never moves the control; hypermedia flat with orthogonal edges.
 *   HUD     = a read-out. Scan-lines, no grain; lit rules under wide-tracked caps, a glowing code frame, a tinted quote panel,
 *             lit horizontal table rules, links as tags; a spinner that is a radar sweep round a bezel of ticks with a centre
 *             ping; quick, exact motion and a 1px press; hypermedia flat with straight edges. The field's ring is drawn inside.
 *
 * Set `FY_MISSION_HUD_KIT_REPORT=<file>` to write the measured numbers (JSON), the values the PR body quotes.
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
const reportFile = process.env.FY_MISSION_HUD_KIT_REPORT ?? '';

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

/** One style on the Teal palette, drawn with its real motion (a spinner's animation is read, not frozen). */
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
      root.setAttribute('data-palette', 'mission');
      root.setAttribute('data-mode', m as string);
    },
    [style, mode] as const,
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
  const box = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10]; };
  return {
    layers: body.backgroundImage.split(/,(?![^()]*\\))/).map((layer) => layer.trim()),
    bgSize: body.backgroundSize,
    bgRepeat: body.backgroundRepeat,
    grain: { image: cs(document.body, '::after').backgroundImage, opacity: cs(document.body, '::after').opacity },
    panelTexture: cs(q('.kt-panel')).backgroundImage,
    h1: { case: h1.textTransform, rule: h1.borderBottomWidth + ' ' + h1.borderBottomStyle, weight: h1.fontWeight },
    pre: { radius: pre.borderTopLeftRadius, shadow: pre.boxShadow !== 'none', border: pre.borderTopWidth + ' ' + pre.borderTopStyle },
    quote: { left: quote.borderLeftStyle + ' ' + quote.borderLeftWidth, bg: quote.backgroundColor !== 'rgba(0, 0, 0, 0)' },
    th: { case: th.textTransform, weight: th.fontWeight },
    td: { left: td.borderLeftStyle, bottom: td.borderBottomStyle },
    link: { decoration: a.textDecorationLine + ' ' + a.textDecorationStyle, weight: a.fontWeight, bg: a.backgroundColor !== 'rgba(0, 0, 0, 0)' },
    spinner: {
      animation: cs(spinner).animationName + ' ' + cs(spinner).animationDuration + ' ' + cs(spinner).animationTimingFunction,
      ring: ring.display,
      parts: [1, 2, 3, 4].map((n) => part(n).display),
      p1: { dash: part(1).strokeDasharray, fill: part(1).fill, animation: part(1).animationName },
      size: box(spinner),
    },
    hm: { shape: token('--hm-shape'), edge: token('--hm-edge'), radius: token('--hm-radius'), stroke: token('--hm-stroke'), header: token('--hm-header') },
    motion: { fast: token('--motion-fast'), base: token('--motion-base'), slow: token('--motion-slow'), ease: token('--ease-standard'), press: token('--press-translate') },
    gradients: [...document.querySelectorAll('.kt-panel, .kt-btn, .kt-input, .kt-badge')].filter((el) => /gradient/.test(getComputedStyle(el).backgroundImage)).length,
  };
})()`;

/** A custom property is read back as authored or as the browser normalises it (`120ms` or `.12s`): compare the time. */
const milliseconds = (value: string): number =>
  value.endsWith('ms') ? Number.parseFloat(value) : Math.round(Number.parseFloat(value) * 1_000);

type Read = {
  layers: string[];
  bgSize: string;
  bgRepeat: string;
  grain: { image: string; opacity: string };
  panelTexture: string;
  h1: { case: string; rule: string; weight: string };
  pre: { radius: string; shadow: boolean; border: string };
  quote: { left: string; bg: boolean };
  th: { case: string; weight: string };
  td: { left: string; bottom: string };
  link: { decoration: string; weight: string; bg: boolean };
  spinner: {
    animation: string;
    ring: string;
    parts: string[];
    p1: { dash: string; fill: string; animation: string };
    size: number[];
  };
  hm: { shape: string; edge: string; radius: string; stroke: string; header: string };
  motion: { fast: string; base: string; slow: string; ease: string; press: string };
  gradients: number;
};

for (const style of ['mission', 'hud'] as const)
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
            expect(read.bgSize.split(',')[0]).toBe(style === 'mission' ? '32px 32px' : '3px 3px');
            expect(read.bgRepeat.split(',')[0]).toBe('repeat');
            expect(Number(read.grain.opacity), 'no grain').toBe(0);
            expect(read.panelTexture).toBe('none');
            expect(read.gradients, 'no gradient on a panel, button, field or badge').toBe(0);
            // MOTION.
            expect(read.motion.press).toBe(style === 'mission' ? '0px' : '1px');
            expect(milliseconds(read.motion.base)).toBe(style === 'mission' ? 120 : 160);
            // HYPERMEDIA slots (read by r12 H5).
            expect(read.hm.shape).toBe('flat');
            expect(read.hm.edge).toBe(style === 'mission' ? 'orthogonal' : 'straight');
            // MARKDOWN.
            expect(read.h1.case).toBe('uppercase');
            expect(read.h1.rule).toBe('1px solid');
            expect(read.th.case).toBe('uppercase');
            expect(read.link.decoration).toBe(style === 'mission' ? 'underline dotted' : 'none solid');
            expect(read.link.weight).toBe('600');
            if (style === 'mission') {
              expect(read.pre.radius, 'a square code frame').toBe('0px');
              expect(read.pre.shadow, 'a registered double-line frame').toBe(true);
              expect(read.quote.left, 'a dashed dimension line').toBe('dashed 1px');
              expect(read.td.left, 'a full grid table').toBe('solid');
              // SPINNER: four turning corner brackets: the ring is hidden, all four parts shown as outlines, in whole eighth-turns.
              expect(read.spinner.ring).toBe('none');
              expect(read.spinner.parts).toEqual(['inline', 'inline', 'inline', 'inline']);
              expect(read.spinner.p1.fill).toBe('none');
              expect(read.spinner.p1.dash).not.toBe('none');
              expect(read.spinner.animation).toContain('2.4s');
              expect(read.spinner.animation).toContain('steps(8');
            } else {
              expect(read.pre.radius).toBe('2px');
              expect(read.pre.shadow, 'a glowing code frame').toBe(true);
              expect(read.quote.left, 'no bar: a tinted panel').toBe('none 0px');
              expect(read.quote.bg).toBe(true);
              expect(read.td.left, 'lit horizontal rules only').toBe('none');
              expect(read.td.bottom).toBe('solid');
              expect(read.link.bg, 'links are tags').toBe(true);
              // SPINNER: a radar: the ring (bezel of ticks + sweeping arc) and ONE part, the centre ping.
              expect(read.spinner.ring).not.toBe('none');
              expect(read.spinner.parts).toEqual(['inline', 'none', 'none', 'none']);
              expect(read.spinner.animation).toContain('1.4s');
              expect(read.spinner.animation).toContain('linear');
            }
          } finally {
            await close();
          }
        });
      });

/** A regression guard, not a proof of new work: HUD's field ring is drawn INSIDE the field (a positive offset is a ring a clipping ancestor can cut). r11 S13's one generic rule already guarantees it; HUD's own rule now agrees with it. */
describe('the HUD field keeps its focus ring inside itself', () => {
  for (const mode of MODES)
    it(`in ${mode}`, async () => {
      const { tab, close } = await open(VIEWPORTS[0], mode, 'hud');
      try {
        const ring = (await tab.evaluate(() => {
          const input = document.querySelector('input.kt-input') as HTMLInputElement;
          input.focus({ focusVisible: true } as FocusOptions);
          const cs = getComputedStyle(input);
          return {
            width: Number.parseFloat(cs.outlineWidth),
            offset: Number.parseFloat(cs.outlineOffset),
            style: cs.outlineStyle,
          };
        })) as { width: number; offset: number; style: string };
        report[`hud-field-ring:${mode}`] = ring;
        expect(ring.style).toBe('solid');
        expect(ring.width).toBeGreaterThanOrEqual(2);
        expect(ring.offset).toBeLessThanOrEqual(-ring.width);
      } finally {
        await close();
      }
    });
});

/**
 * The pattern is really PAINTED, not only declared: with the specimen's own opaque page cover taken off, a 96 x 96 corner of the
 * page screenshot holds lines (Mission: a 1px rule every 32px in both directions; HUD: a 1px row every 3px), each a visible but
 * quiet step from the ground (a few levels of 255, never a wash), at the period the style declares.
 */
describe('the field pattern is painted', () => {
  for (const style of ['mission', 'hud'] as const)
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
            const at = (x: number, y: number) => [
              d[(y * bitmap.width + x) * 4] ?? 0,
              d[(y * bitmap.width + x) * 4 + 1] ?? 0,
              d[(y * bitmap.width + x) * 4 + 2] ?? 0,
            ];
            // Rows (a horizontal line is a row that differs from the row above it), along the left edge column 16 (clear of a vertical rule).
            const column = 16;
            const scale = bitmap.width / 96;
            const rows: number[] = [];
            const lum = (p: number[]) => p[0]! + p[1]! + p[2]!;
            let ground = Number.POSITIVE_INFINITY;
            let line = 0;
            for (let y = 0; y < 96; y += 1) {
              const v = lum(at(Math.round(column * scale), Math.round(y * scale)));
              ground = Math.min(ground, v);
              line = Math.max(line, v);
              rows.push(v);
            }
            return { rows, span: Math.abs(line - ground), scale };
          }, png)) as { rows: number[]; span: number; scale: number };
          const distinct = new Set(painted.rows).size;
          report[`pattern:${style}:${mode}`] = { span: painted.span, distinctLevels: distinct };
          expect(distinct, 'the corner holds more than one level: lines on a ground').toBeGreaterThanOrEqual(2);
          // Three channels summed: at least 6 (about 2 of 255 each) and at most 120 (about 40 each).
          expect(painted.span).toBeGreaterThanOrEqual(6);
          expect(painted.span).toBeLessThanOrEqual(120);
        } finally {
          await close();
        }
      });
});
