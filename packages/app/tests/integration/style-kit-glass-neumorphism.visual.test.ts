/**
 * THE GLASS + NEUMORPHISM STYLE KITS (r11 T9), measured in a real browser on the theme matrix's specimen page
 * (`plugins/conversation/tests/integration/app/fixtures/theme-matrix-scene.tsx`), each style on its DEFAULT palette (Indigo, the
 * `studio` palette id), in both modes at 1280 and 390.
 *
 * The owner's line (turn 4247, item 12): "BG and grainy-ness can help with the style too -- and ... components too, including
 * how markdown looks", "make sure things like spinner, animation all are unique to their style", "design each style to change
 * the hyper media completely", "most of them should not have gradient background", "alot of the super rounded ones are
 * broken". So each style must FILL every slot of the component style contract with its own idiom, not with a padding tweak:
 *
 *   Glass        = frosted panes over a soft grain. A quiet dot lattice and fine grain are the page (no colour wash), panels are
 *                  translucent and blur what is behind them, with ONE frost highlight (the one gradient the style is allowed);
 *                  airy light-weight markdown (frosted code and quote panes, soft rules, tinted links); a spinner that is a soft
 *                  ORBIT (four dots of falling size circling, each breathing a quarter-turn apart); calm motion; hypermedia shaped
 *                  and translucent. The focus ring is drawn inside the control.
 *   Neumorphism  = clay moulded from one ground. No gradient anywhere (a raised thing is two shadows, not a sheen); a fine plaster (dark only: light is one plain ground)
 *                  grain; fat heavy markdown (a code block is a WELL dug in, a table is engraved grooves, links are beads); a
 *                  spinner that is an embossed bead rolling round a groove on a slow ease-in-out; springy slow motion; hypermedia
 *                  shaped and solid. Menus, fields and code blocks are capped at 16px (a pill is for a button, tab or badge).
 *
 * Set `FY_GLASS_NEUMORPHISM_KIT_REPORT=<file>` to write the measured numbers (JSON), the values the PR body quotes.
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
const reportFile = process.env.FY_GLASS_NEUMORPHISM_KIT_REPORT ?? '';
/** A folder to keep one full-page 2x screenshot per style, width and mode (the PR's before/after shots; fake specimen data only). */
const shotsDir = process.env.FY_GLASS_NEUMORPHISM_KIT_SHOTS_DIR ?? '';

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
  directory = await mkdtemp(join(tmpdir(), 'ferretry-glass-neumorphism-kit-'));
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

/** One style on the Indigo palette, drawn with its real motion (a spinner's animation is read, not frozen). */
const open = async (
  viewport: (typeof VIEWPORTS)[number],
  mode: 'light' | 'dark',
  style: string,
): Promise<{ tab: Page; close: () => Promise<void> }> => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: 2_400 },
    deviceScaleFactor: shotsDir === '' ? 1 : 2,
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
  (tab as Page & { refused?: string[] }).refused = refused;
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
  const panel = cs(q('.kt-panel'));
  // The specimen has no group pane of its own: a real one is built (a top-level section panel) and read, then removed.
  const pane = document.createElement('section');
  pane.className = 'kt-panel';
  document.body.append(pane);
  const groupPanel = getComputedStyle(pane);
  const groupBlur = groupPanel.backdropFilter;
  const menu = cs(q('[role="menu"]'));
  const area = cs(q('[data-probe="textarea"]'));
  const button = cs(q('.kt-btn:not([data-variant])'));
  const input = cs(q('input.kt-input'));
  const box = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10]; };
  // Split a computed list of layers at the commas that are not inside a function call (a gradient holds many).
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
  pane.remove();
  return {
    layers: split(body.backgroundImage),
    bgSize: body.backgroundSize,
    bgRepeat: body.backgroundRepeat,
    bgColor: body.backgroundColor,
    panelBg: root.getPropertyValue('--panel-bg').trim(),
    grain: { image: cs(document.body, '::after').backgroundImage.slice(0, 40), opacity: cs(document.body, '::after').opacity, blend: cs(document.body, '::after').mixBlendMode },
    panel: { layers: layers(panel.backgroundImage), shadow: panel.boxShadow !== 'none', radius: panel.borderTopLeftRadius },
    groupBlur,
    menu: { radius: menu.borderTopLeftRadius },
    textarea: { radius: area.borderTopLeftRadius },
    button: { radius: button.borderTopLeftRadius, gradient: /gradient/.test(button.backgroundImage), blur: button.backdropFilter },
    field: { gradient: /gradient/.test(input.backgroundImage), shadow: input.boxShadow !== 'none', radius: input.borderTopLeftRadius },
    h1: { case: h1.textTransform, rule: h1.borderBottomWidth + ' ' + h1.borderBottomStyle, weight: h1.fontWeight, size: h1.fontSize },
    h2: { rule: token('--md-h2-rule') },
    pre: { radius: pre.borderTopLeftRadius, shadow: pre.boxShadow, inset: /inset/.test(pre.boxShadow), border: pre.borderTopWidth + ' ' + pre.borderTopStyle },
    quote: { left: quote.borderLeftStyle + ' ' + quote.borderLeftWidth, bg: quote.backgroundColor !== 'rgba(0, 0, 0, 0)', radius: quote.borderTopLeftRadius },
    th: { case: th.textTransform, weight: th.fontWeight },
    td: { left: td.borderLeftStyle, bottom: td.borderBottomStyle },
    link: { decoration: a.textDecorationLine, weight: a.fontWeight, bg: a.backgroundColor !== 'rgba(0, 0, 0, 0)', radius: a.borderTopLeftRadius },
    spinner: {
      animation: cs(spinner).animationName + ' ' + cs(spinner).animationDuration + ' ' + cs(spinner).animationTimingFunction,
      ring: ring.display,
      parts: [1, 2, 3, 4].map((n) => part(n).display),
      p1: { fill: part(1).fill, rx: part(1).rx, width: part(1).width },
      sizes: [1, 2, 3, 4].map((n) => part(n).width),
      stroke: cs(q('[data-probe="spinner"] .fy-spinner-arc')).strokeWidth,
      sweep: cs(q('[data-probe="spinner"] .fy-spinner-arc')).strokeDasharray,
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

interface Read {
  layers: string[];
  bgSize: string;
  bgRepeat: string;
  bgColor: string;
  panelBg: string;
  grain: { image: string; opacity: string; blend: string };
  panel: { layers: string[]; shadow: boolean; radius: string };
  groupBlur: string;
  menu: { radius: string };
  textarea: { radius: string };
  button: { radius: string; gradient: boolean; blur: string };
  field: { gradient: boolean; shadow: boolean; radius: string };
  h1: { case: string; rule: string; weight: string; size: string };
  h2: { rule: string };
  pre: { radius: string; shadow: string; inset: boolean; border: string };
  quote: { left: string; bg: boolean; radius: string };
  th: { case: string; weight: string };
  td: { left: string; bottom: string };
  link: { decoration: string; weight: string; bg: boolean; radius: string };
  spinner: {
    animation: string;
    ring: string;
    parts: string[];
    p1: { fill: string; rx: string; width: string };
    sizes: string[];
    stroke: string;
    sweep: string;
    size: number[];
  };
  hm: { shape: string; edge: string; radius: string; stroke: string; header: string; alpha: string };
  motion: { fast: string; base: string; slow: string; ease: string; press: string };
  gradients: { button: number; field: number; badge: number; choice: number; panels: number };
}

const px = (value: string): number => Number.parseFloat(value);

for (const style of ['glass', 'neumorphism'] as const)
  for (const viewport of VIEWPORTS)
    for (const mode of MODES)
      describe(`the ${style} kit at ${viewport.name} in ${mode}`, () => {
        it('fills every slot of the component style contract with its own idiom', async () => {
          const { tab, close } = await open(viewport, mode, style);
          try {
            if (shotsDir !== '') {
              // Let the style's own transitions (up to 520ms) finish: a shot is the settled page, never a frame mid-fade.
              await tab.waitForTimeout(1_000);
              await tab.screenshot({ fullPage: true, path: join(shotsDir, `${viewport.name}-${style}-${mode}.png`) });
            }
            const read = (await tab.evaluate(READ)) as Read;
            report[`${style}:${viewport.name}:${mode}`] = read;
            // BACKGROUND: no wash under the tile; the grain is a real, inline, painted layer.
            if (style === 'neumorphism' && mode === 'light')
              expect(Number(read.grain.opacity), 'a light clay carries no grain').toBe(0);
            else expect(Number(read.grain.opacity), 'a grain').toBeGreaterThan(0);
            expect(Number(read.grain.opacity), 'a soft grain, never a wash').toBeLessThanOrEqual(0.08);
            expect(read.grain.image, 'the grain is an inline SVG data URI (no request)').toStartWith(
              'url("data:image/svg+xml',
            );
            expect(
              read.layers.filter(layer => /gradient\(/u.test(layer)).length,
              'the page paints at most the style contract tile (one gradient layer), never a wash',
            ).toBe(style === 'glass' ? 1 : 0);
            // NO gradient on a control, a field, a badge or a choice card.
            expect(read.gradients.button + read.gradients.field + read.gradients.badge + read.gradients.choice).toBe(0);
            // HYPERMEDIA slots (read by r12 H5): both are SHAPED, each its own way.
            expect(read.hm.shape).toBe('shaped');
            expect(read.hm.edge).toBe('curve');
            expect(read.hm.header).toBe('band');
            // RADIUS: a multi-line field, a code block, a menu are capped at 16px.
            expect(px(read.textarea.radius)).toBeLessThanOrEqual(16);
            expect(px(read.menu.radius)).toBeLessThanOrEqual(16);
            expect(px(read.pre.radius)).toBeLessThanOrEqual(16);
            if (style === 'glass') {
              expect(read.layers[0], 'the first layer is the style contract dot tile').toMatch(/radial-gradient\(/u);
              expect(read.bgSize.split(',')[0]).toBe('24px 24px');
              expect(read.bgRepeat.split(',')[0]).toBe('repeat');
              expect(read.grain.blend).toBe(mode === 'light' ? 'soft-light' : 'normal');
              // FROST: ONE gradient on a panel (the frost highlight, the one the style may keep) and the pane blurs what is behind it.
              expect(read.panel.layers.length, 'one frost highlight on a panel').toBe(1);
              expect(read.panel.layers[0]).toMatch(/linear-gradient\(/u);
              expect(read.groupBlur, 'a group pane blurs the backdrop').toContain('blur(18px)');
              expect(
                px(read.button.radius),
                'a glass button is a pill (the capped fully-round radius)',
              ).toBeGreaterThanOrEqual(20);
              expect(read.button.blur, 'and a small pane of its own: it blurs what is behind it').toContain(
                'blur(10px)',
              );
              expect(read.motion.press).toBe('1px');
              expect(milliseconds(read.motion.base)).toBe(240);
              expect(milliseconds(read.motion.slow)).toBe(420);
              expect(read.hm.radius).toBe('14px');
              expect(Number(read.hm.alpha)).toBe(0.6);
              // MARKDOWN: airy and light.
              expect(read.h1.case).toBe('none');
              expect(read.h1.rule).toBe('0px none');
              expect(Number(read.h1.weight)).toBeLessThanOrEqual(560);
              expect(read.pre.radius, 'a frosted code pane').toBe('14px');
              expect(read.pre.shadow, 'it floats on a soft shadow').not.toBe('none');
              expect(read.quote.left, 'no bar: a frosted pane').toBe('none 0px');
              expect(read.quote.bg).toBe(true);
              expect(read.quote.radius).toBe('14px');
              expect(read.td.left, 'soft horizontal rules only').toBe('none');
              expect(read.td.bottom).toBe('solid');
              expect(read.link.decoration).toBe('none');
              expect(read.link.bg, 'a link is a tinted tag').toBe(true);
              expect(read.link.weight).toBe('500');
              // SPINNER: the ring is hidden; four dots of falling size, taller than wide nowhere (round).
              expect(read.spinner.ring).toBe('none');
              expect(read.spinner.parts).toEqual(['inline', 'inline', 'inline', 'inline']);
              expect(read.spinner.sizes.map(px), 'a comet: each dot smaller than the one before').toEqual([
                4.2, 3.4, 1.8, 2.6,
              ]);
              expect(read.spinner.p1.rx, 'round dots').toBe('2.1px');
              expect(read.spinner.animation).toContain('1.8s');
              expect(read.spinner.animation).toContain('linear');
            } else {
              expect(
                read.layers.filter(layer => layer !== 'none'),
                'no pattern, no wash, no mesh: nothing on the page',
              ).toEqual([]);
              expect(read.bgColor, 'the page IS the one ground the clay is moulded from').not.toBe('rgba(0, 0, 0, 0)');
              expect(read.grain.blend).toBe('normal');
              if (mode === 'dark') expect(Number(read.grain.opacity)).toBe(0.04);
              expect(read.panel.layers, 'a raised panel is two shadows, not a sheen').toEqual([]);
              expect(read.gradients.panels).toBe(0);
              expect(read.panel.shadow).toBe(true);
              expect(read.field.shadow, 'a field is a well').toBe(true);
              expect(
                px(read.button.radius),
                'a button is still a pill (the capped fully-round radius)',
              ).toBeGreaterThanOrEqual(20);
              expect(read.motion.press).toBe('0px');
              expect(milliseconds(read.motion.base)).toBe(340);
              expect(milliseconds(read.motion.slow)).toBe(520);
              expect(read.hm.radius).toBe('16px');
              expect(Number(read.hm.alpha)).toBe(1);
              // MARKDOWN: heavy and moulded.
              expect(read.h1.case).toBe('none');
              expect(read.h1.rule).toBe('0px none');
              expect(read.h1.weight).toBe('800');
              expect(read.h2.rule, 'an engraved groove under an h2').toContain('groove');
              expect(read.pre.inset, 'a code block is a well dug in').toBe(true);
              expect(read.pre.radius).toBe('14px');
              expect(read.quote.left).toBe('none 0px');
              expect(read.quote.bg).toBe(true);
              expect(read.quote.radius).toBe('16px');
              expect(read.td.left).toBe('none');
              expect(read.td.bottom, 'rows are engraved').toBe('groove');
              expect(read.th.weight).toBe('800');
              expect(read.link.decoration).toBe('none');
              expect(read.link.weight).toBe('800');
              expect(read.link.bg, 'a link is a bead').toBe(true);
              // SPINNER: a bead on a groove: the ring is drawn, the four parts are not; fat stroke, a short bead.
              expect(read.spinner.ring).not.toBe('none');
              expect(read.spinner.parts).toEqual(['none', 'none', 'none', 'none']);
              expect(px(read.spinner.stroke)).toBeGreaterThanOrEqual(3.4);
              expect(px(read.spinner.sweep.split(',')[0] as string)).toBeLessThanOrEqual(9);
              expect(read.spinner.animation).toContain('1.4s');
              expect(read.spinner.animation).toContain('cubic-bezier(0.65, 0, 0.35, 1)');
            }
            expect((tab as Page & { refused?: string[] }).refused, 'the page asked for nothing outside itself').toEqual(
              [],
            );
          } finally {
            await close();
          }
        });
      });

/**
 * The surface is really PAINTED, not only declared: with the specimen's own opaque page cover taken off and every glyph hidden, a
 * 96 x 96 corner of the page screenshot holds more than one level of grey (Glass: dots on a ground under fine grain; Neumorphism DARK:
 * fine grain on a plain ground; Neumorphism LIGHT is one plain ground), each a quiet step from the ground, never a wash.
 */
describe('the field and its grain are painted', () => {
  for (const style of ['glass', 'neumorphism'] as const)
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
          if (style === 'neumorphism' && mode === 'light') {
            // A light clay is one plain ground (its texture is its shadows): the corner is a single level.
            expect(painted.levels, 'one plain ground').toBe(1);
            return;
          }
          expect(painted.levels, 'more than one level: a texture on a ground').toBeGreaterThanOrEqual(3);
          // Three channels summed: a visible but quiet step (at most about 60 of 255 per channel), never a wash.
          expect(painted.span).toBeGreaterThanOrEqual(2);
          expect(painted.span).toBeLessThanOrEqual(180);
        } finally {
          await close();
        }
      });
});

/** A hand-held reader of what the engine is DOING, not what the sheet declares (see the T6 review, item 2). */
interface MarkRead {
  readonly active: readonly {
    readonly target: string;
    readonly name: string;
    readonly state: string;
    readonly delay: number;
    readonly duration: number;
    readonly iterations: string;
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

// GLASS: the whole figure turns at a steady rate (360deg / 1800ms); each dot breathes 1 -> .25 over 1800ms, a quarter-turn apart
// (delays 0, 450, 900, 1350ms for p1, p2, p4, p3 in clockwise order).
const GLASS_TIMES = [1_400, 1_600, 2_000, 3_300] as const;
const GLASS_DELAY = { p1: 0, p2: 450, p4: 900, p3: 1_350 } as const;
const breathe = (time: number, delay: number): number =>
  time < delay ? 0.25 : 1 - 0.75 * (((time - delay) % 1_800) / 1_800);
const expectGlassOrbiting = (read: MarkRead): void => {
  const marks = read.active.filter(animation => animation.target === 'mark');
  expect(marks.length, 'the orbit is one turning animation').toBe(1);
  expect(marks[0]).toMatchObject({
    name: 'fy-spinner-turn',
    state: 'running',
    duration: 1_800,
    iterations: 'Infinity',
  });
  const parts = read.active.filter(animation => animation.target !== 'mark');
  expect(parts.map(animation => `${animation.target}:${animation.delay}`).sort()).toEqual(
    ['p1:0', 'p2:450', 'p3:1350', 'p4:900'].sort(),
  );
  for (const animation of parts)
    expect(animation).toMatchObject({
      name: 'fy-spinner-part',
      state: 'running',
      duration: 1_800,
      iterations: 'Infinity',
    });
  for (const [index, time] of GLASS_TIMES.entries()) near(read.angle[index], ((time % 1_800) / 1_800) * 360, 0);
  // Each dot's opacity at each fixed time is a phase of the same sawtooth, a quarter-turn behind the one before.
  for (const [part, delay] of Object.entries(GLASS_DELAY))
    for (const [index, time] of GLASS_TIMES.entries()) near(read.opacity[part]?.[index], breathe(time, delay), 2);
  // ... which means at one instant the four are at four different brightnesses (a comet's tail), not in unison.
  for (const index of [0, 1, 2])
    expect(new Set(['p1', 'p2', 'p3', 'p4'].map(part => read.opacity[part]?.[index]?.toFixed(2))).size).toBe(4);
};

// NEUMORPHISM: the bead rolls round its groove on an ease-in-out (cubic-bezier(.65, 0, .35, 1)) turn of 1400ms: slow, quick, slow.
const NEUMORPHISM_TIMES = [175, 350, 700, 1_050, 1_225] as const;
const expectNeumorphismRolling = (read: MarkRead): void => {
  const marks = read.active.filter(animation => animation.target === 'mark');
  expect(marks.length, 'the bead is one turning animation').toBe(1);
  expect(marks[0]).toMatchObject({
    name: 'fy-spinner-turn',
    state: 'running',
    duration: 1_400,
    iterations: 'Infinity',
  });
  expect(
    read.active.filter(animation => animation.target !== 'mark'),
    'no part of its own: the ring is the groove and the arc the bead',
  ).toEqual([]);
  // Symmetric ease-in-out: exactly half a turn at half time; a LINEAR turn would read 45, 90, 180, 270, 315.
  near(read.angle[2], 180, 0);
  expect(read.angle[0] as number, 'slow to leave').toBeLessThan(25);
  expect(read.angle[1] as number, 'still under a quarter-turn a quarter of the way in').toBeLessThan(80);
  expect(read.angle[3] as number, 'over three quarters by three quarters of the way').toBeGreaterThan(280);
  expect(read.angle[4] as number, 'slow to arrive').toBeGreaterThan(335);
  for (let index = 1; index < read.angle.length; index += 1)
    expect(read.angle[index] as number).toBeGreaterThan(read.angle[index - 1] as number);
};

describe('the Glass and Neumorphism spinners are really moving (live animations and phase, not declarations)', () => {
  for (const mode of MODES) {
    it(`Glass in ${mode}: a turning orbit of four dots breathing a quarter-turn apart`, async () => {
      const { tab, close } = await open(VIEWPORTS[0], mode, 'glass');
      try {
        const live = await readMark(tab, PROBE, GLASS_TIMES, false);
        report[`motion:glass:${mode}`] = live;
        expect(live.display, 'all four dots drawn').toEqual(['inline', 'inline', 'inline', 'inline']);
        expectGlassOrbiting(live);
        const dead = await readMark(tab, PROBE, GLASS_TIMES, true);
        expect(dead.active, 'animation-name: none stops every animation').toEqual([]);
        expect(() => expectGlassOrbiting(dead), 'the assert fails when the mark does not move').toThrow();
      } finally {
        await close();
      }
    });

    it(`Neumorphism in ${mode}: a bead rolling on a slow ease-in-out turn`, async () => {
      const { tab, close } = await open(VIEWPORTS[0], mode, 'neumorphism');
      try {
        const live = await readMark(tab, PROBE, NEUMORPHISM_TIMES, false);
        report[`motion:neumorphism:${mode}`] = live;
        expect(live.display).toEqual(['none', 'none', 'none', 'none']);
        expectNeumorphismRolling(live);
        const dead = await readMark(tab, PROBE, NEUMORPHISM_TIMES, true);
        expect(dead.active).toEqual([]);
        expect(() => expectNeumorphismRolling(dead), 'the assert fails when the mark does not move').toThrow();
      } finally {
        await close();
      }
    });

    it(`Glass in ${mode}, reduced motion: the VISIBLE dots pulse in place (the ring is hidden, so it cannot)`, async () => {
      const { tab, close } = await open(VIEWPORTS[0], mode, 'glass');
      try {
        await tab.emulateMedia({ reducedMotion: 'reduce' });
        // Let the opacity and stroke transitions the switch starts finish: the pulse is read settled, not mid-fade.
        await tab.waitForTimeout(800);
        const expectPulse = (read: MarkRead): void => {
          expect(read.display, 'the dots stay drawn').toEqual(['inline', 'inline', 'inline', 'inline']);
          expect(read.active.map(animation => animation.name)).toEqual(['fy-spinner-pulse']);
          expect(read.active[0]).toMatchObject({ target: 'mark', state: 'running', duration: 1_600 });
          near(read.markOpacity[0], 1, 2);
          near(read.markOpacity[1], 0.72, 2);
          near(read.markOpacity[2], 1, 2);
          for (const part of ['p1', 'p2', 'p3', 'p4']) expect(read.opacity[part]).toEqual([1, 1, 1]);
        };
        const live = await readMark(tab, PROBE, [0, 800, 1_600], false);
        report[`motion:glass-reduced:${mode}`] = live;
        expectPulse(live);
        const dead = await readMark(tab, PROBE, [0, 800, 1_600], true);
        expect(() => expectPulse(dead), 'the assert fails when the mark does not pulse').toThrow();
      } finally {
        await close();
      }
    });

    it(`Neumorphism in ${mode}, reduced motion: the whole ring pulses in place and the bead becomes a full ring`, async () => {
      const { tab, close } = await open(VIEWPORTS[0], mode, 'neumorphism');
      try {
        await tab.emulateMedia({ reducedMotion: 'reduce' });
        // Let the opacity and stroke transitions the switch starts finish: the pulse is read settled, not mid-fade.
        await tab.waitForTimeout(800);
        const expectPulse = (read: MarkRead): void => {
          expect(read.active.map(animation => animation.name)).toEqual(['fy-spinner-pulse']);
          near(read.markOpacity[0], 1, 2);
          near(read.markOpacity[1], 0.72, 2);
        };
        const live = await readMark(tab, PROBE, [0, 800], false);
        expectPulse(live);
        expect(
          await tab.evaluate(
            selector =>
              getComputedStyle(document.querySelector(`${selector} .fy-spinner-arc`) as Element).strokeDasharray,
            PROBE,
          ),
        ).toBe('100px, 0px');
        const dead = await readMark(tab, PROBE, [0, 800], true);
        expect(() => expectPulse(dead)).toThrow();
      } finally {
        await close();
      }
    });
  }
});

/**
 * A swatch draws ITS OWN style's mark, whatever the page is wearing (the T6 review, item 3): every page style x every swatch
 * style, each swatch's mark read back whole. The two new styles' page rules must not reach a swatch of another style, and a
 * swatch of theirs must draw whole on another style's page.
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
  glass: {
    ring: 'none',
    parts: ['inline', 'inline', 'inline', 'inline'],
    animations: [
      'mark:fy-spinner-turn:1800',
      'p1:fy-spinner-part:1800',
      'p2:fy-spinner-part:1800',
      'p3:fy-spinner-part:1800',
      'p4:fy-spinner-part:1800',
    ],
  },
  neumorphism: { ring: 'inline', parts: ['none', 'none', 'none', 'none'], animations: ['mark:fy-spinner-turn:1400'] },
} as const;
type StyleId = keyof typeof SIGNATURE;

describe('a swatch draws its own style’s spinner, on a page of any style (mixed page x swatch)', () => {
  for (const pageStyle of ['studio', 'mission', 'hud', 'glass', 'neumorphism'] as const)
    it(`on a ${pageStyle} page: all six swatches each keep their own mark`, async () => {
      const { tab, close } = await open(VIEWPORTS[0], 'light', pageStyle);
      try {
        // The probe's own markup, read once off a Studio page's mark (the markup never changes per style).
        const source = await tab.evaluate(selector => (document.querySelector(selector) as Element).outerHTML, PROBE);
        for (const swatch of Object.keys(SIGNATURE) as StyleId[]) {
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
          // The part geometry of a glass swatch is glass's, and only a glass swatch's: a dot is round, a bracket is not.
          const round = await tab.evaluate(
            sel => getComputedStyle(document.querySelector(`${sel} .fy-spinner__p1`) as Element).rx,
            selector,
          );
          expect(
            round === '2.1px',
            `${swatch} swatch on a ${pageStyle} page: only a glass swatch draws a round dot`,
          ).toBe(swatch === 'glass');
          await tab.evaluate(sel => document.querySelector(sel)?.parentElement?.remove(), selector);
        }
      } finally {
        await close();
      }
    });

  it('Glass and Neumorphism page rules do not change a Studio swatch in a Glass or Neumorphism page: the arc keeps its own hand', async () => {
    for (const pageStyle of ['glass', 'neumorphism'] as const) {
      const { tab, close } = await open(VIEWPORTS[0], 'dark', pageStyle);
      try {
        const source = await tab.evaluate(selector => (document.querySelector(selector) as Element).outerHTML, PROBE);
        await tab.evaluate(markup => {
          const holder = document.createElement('div');
          holder.setAttribute('data-swatch', '');
          holder.setAttribute('data-style', 'studio');
          holder.setAttribute('data-palette', 'studio');
          holder.setAttribute('data-mode', 'dark');
          holder.innerHTML = markup as string;
          document.body.append(holder);
        }, source);
        const arc = await tab.evaluate(() => {
          const el = document.querySelector('[data-swatch][data-style="studio"] .fy-spinner-arc') as Element;
          const cs = getComputedStyle(el);
          return { stroke: cs.strokeWidth, dash: cs.strokeDasharray, cap: cs.strokeLinecap };
        });
        expect(arc, `a Studio swatch on a ${pageStyle} page`).toEqual({
          stroke: '2px',
          dash: '32px, 100px',
          cap: 'round',
        });
      } finally {
        await close();
      }
    }
  });
});

/* ======================================================================================================================
   r11 T9 REVIEW (PR 2272): THE KITS' COMPONENT RULES STAY ON THEIR OWN PAGE, AND THE FILLED SEND STAYS FINDABLE.
   Three measured asserts, each red on the head the reviewer read and green after the fix (the PR body quotes the numbers).
   ====================================================================================================================== */

/** The component classes a kit styles, in the markup a Studio swatch preview draws. Each one is read for its paint. */
const SWATCH_CONTROLS = `
  <button class="kt-btn" data-probe="btn">Outline</button>
  <button class="kt-btn" data-variant="primary" data-probe="btn-primary">Primary</button>
  <button class="kt-btn" data-variant="danger" data-probe="btn-danger">Danger</button>
  <button class="kt-btn" data-variant="ghost" data-probe="btn-ghost">Ghost</button>
  <input class="kt-input" data-probe="input">
  <textarea class="kt-input" data-probe="textarea-input"></textarea>
  <div class="kt-composer" data-probe="composer">Composer</div>
  <div class="kt-popover" data-probe="menu">Menu</div>
  <section class="kt-panel" data-probe="panel"><header class="kt-panel__header">Head</header><div class="kt-row" data-probe="row">Row</div><div class="kt-row" data-active="true" data-probe="row-active">Active</div></section>
  <div class="kt-groupcard" data-probe="groupcard">Group</div>
  <div class="kt-tabbar" data-probe="tabbar"><button class="kt-tab" aria-selected="true" data-probe="tab">Tab</button><button class="kt-navpill" aria-selected="true" data-probe="navpill">Pill</button></div>
  <span class="kt-badge" data-probe="badge">Badge</span>
  <div class="fy-cc__card" data-probe="card">Card</div>
  <div class="fy-cc__card" data-selected="true" data-probe="card-selected">Card</div>
  <div class="kt-details" data-probe="details">Details</div>
  <div class="kt-sheet" data-probe="sheet">Sheet</div>`;

/** Every paint property a kit rule could set on those controls, read from a Studio swatch placed in the page. */
const readSwatchControls = (tab: Page, mode: 'light' | 'dark'): Promise<Record<string, Record<string, string>>> =>
  tab.evaluate(
    ([markup, swatchMode]) => {
      const holder = document.createElement('div');
      holder.setAttribute('data-swatch', '');
      holder.setAttribute('data-style', 'studio');
      holder.setAttribute('data-palette', 'studio');
      holder.setAttribute('data-mode', swatchMode as string);
      holder.innerHTML = markup as string;
      document.body.append(holder);
      const out: Record<string, Record<string, string>> = {};
      for (const node of Array.from(holder.querySelectorAll<HTMLElement>('[data-probe]'))) {
        const css = getComputedStyle(node);
        out[node.dataset.probe as string] = {
          background: css.backgroundColor,
          shadow: css.boxShadow,
          blur: css.backdropFilter,
          radius: css.borderTopLeftRadius,
          border: `${css.borderTopStyle} ${css.borderTopWidth} ${css.borderTopColor}`,
          groove: css.borderBottomStyle,
          weight: css.fontWeight,
          tracking: css.letterSpacing,
          padding: css.padding,
          transition: css.transitionProperty,
          outlineOffset: css.outlineOffset,
        };
      }
      holder.remove();
      return out;
    },
    [SWATCH_CONTROLS, mode] as const,
  );

describe('a Studio swatch keeps its own control paint on a Glass or Neumorphism page (mixed page x swatch, controls)', () => {
  for (const mode of MODES)
    it(`${mode}: every control in a Studio swatch reads the same on a Glass and a Neumorphism page as on a Studio page`, async () => {
      const studio = await open(VIEWPORTS[0], mode, 'studio');
      let want: Record<string, Record<string, string>>;
      try {
        want = await readSwatchControls(studio.tab, mode);
      } finally {
        await studio.close();
      }
      for (const pageStyle of ['glass', 'neumorphism'] as const) {
        const { tab, close } = await open(VIEWPORTS[0], mode, pageStyle);
        try {
          const got = await readSwatchControls(tab, mode);
          const drifted: string[] = [];
          for (const [control, props] of Object.entries(want))
            for (const [prop, value] of Object.entries(props))
              if (got[control]?.[prop] !== value)
                drifted.push(`${control}.${prop}: studio page ${value} | ${pageStyle} page ${got[control]?.[prop]}`);
          report[`swatch-controls:${mode}:${pageStyle}`] = { controls: Object.keys(want).length, drifted };
          expect(drifted, `a Studio swatch on a ${pageStyle} page (${mode}) drifted`).toEqual([]);
        } finally {
          await close();
        }
      }
    });
});

describe('the filled Send keeps a keyboard ring you can see, inside the control, in both kits', () => {
  for (const style of ['glass', 'neumorphism'] as const)
    for (const mode of MODES)
      it(`${style} in ${mode}: Send's ring is >= 3:1 against its fill on Indigo and High contrast (it was accent on accent, 1.00:1)`, async () => {
        const chatCss = await readFile(resolve(packageRoot, '../../../plugins/conversation/app/chat/chat.css'), 'utf8');
        const { tab, close } = await open(VIEWPORTS[0], mode, style);
        try {
          await tab.addStyleTag({ content: chatCss });
          const reads: Record<string, unknown> = {};
          for (const palette of ['studio', 'contrast']) {
            const read = await tab.evaluate(paletteId => {
              document.documentElement.setAttribute('data-palette', paletteId);
              document.querySelector('#send-clip')?.remove();
              const clip = document.createElement('div');
              clip.id = 'send-clip';
              clip.style.cssText = 'overflow:hidden;width:max-content;padding:8px';
              clip.innerHTML = '<button class="fy-composer-send">Send</button>';
              document.body.prepend(clip);
              const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
              if (probe === null) throw new Error('no canvas');
              const rgb = (color: string): number[] => {
                probe.clearRect(0, 0, 1, 1);
                probe.fillStyle = color;
                probe.fillRect(0, 0, 1, 1);
                return Array.from(probe.getImageData(0, 0, 1, 1).data);
              };
              const lum = (c: number[]): number =>
                c.slice(0, 3).reduce((sum, v, i) => {
                  const u = v / 255;
                  return sum + (u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i]!;
                }, 0);
              const send = clip.querySelector<HTMLElement>('.fy-composer-send') as HTMLElement;
              send.focus({ preventScroll: true });
              const css = getComputedStyle(send);
              const a = lum(rgb(css.outlineColor));
              const b = lum(rgb(css.backgroundColor));
              return {
                visible: send.matches(':focus-visible'),
                ring: css.outlineColor,
                fill: css.backgroundColor,
                ratio: Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100,
                width: parseFloat(css.outlineWidth),
                offset: parseFloat(css.outlineOffset),
              };
            }, palette);
            reads[palette] = read;
            expect(read.visible, `${style} ${mode} ${palette}: the ring is drawn`).toBe(true);
            expect(
              read.ratio,
              `${style} ${mode} ${palette}: ring ${read.ring} on fill ${read.fill}`,
            ).toBeGreaterThanOrEqual(3);
            // INSIDE the control: the ring never overhangs, so no clipping ancestor can cut it (the clip box above is tight).
            expect(read.offset + read.width, `${style} ${mode} ${palette}: ring overhang`).toBeLessThanOrEqual(0);
          }
          report[`send-ring:${style}:${mode}`] = reads;
        } finally {
          await close();
        }
      });
});

describe('Glass single-line fields are opaque when the OS asks for reduced transparency', () => {
  for (const mode of MODES)
    it(`${mode}: input.kt-input paints alpha 255 with prefers-reduced-transparency: reduce (it read 158/255)`, async () => {
      const { tab, close } = await open(VIEWPORTS[0], mode, 'glass');
      try {
        const cdp = await tab.context().newCDPSession(tab);
        await cdp.send('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
        });
        const read = await tab
          .locator('input.kt-input')
          .first()
          .evaluate(node => {
            const canvas = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
            if (canvas === null) throw new Error('no canvas');
            canvas.fillStyle = getComputedStyle(node).backgroundColor;
            canvas.fillRect(0, 0, 1, 1);
            return {
              emulated: matchMedia('(prefers-reduced-transparency: reduce)').matches,
              background: getComputedStyle(node).backgroundColor,
              alpha: canvas.getImageData(0, 0, 1, 1).data[3],
            };
          });
        report[`reduced-transparency-input:${mode}`] = read;
        expect(read.emulated).toBe(true);
        expect(read.alpha).toBe(255);
      } finally {
        await close();
      }
    });
});
