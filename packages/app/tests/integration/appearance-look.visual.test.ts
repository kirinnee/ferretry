/**
 * r11 T13: THE APPEARANCE PAGE SHOWS WHAT A STYLE IS, in a real browser over fake data (`fixtures/device-controls-scene.tsx`).
 * Owner lines: "let them be a default palette when they select the style ... have it as a flag tho (dont change my color
 * when i change my style)", "make sure things like spinner, animation all are unique to their style", "i dont like the
 * triple dots loading". Each ASSERT below was written first and fails on the base it was built on.
 *
 *   1. NO DOTS: no `.fy-dap-dots`, and a generic probe: no element anywhere on the page has exactly 3 element children that
 *      share one running `animation-name` (the bouncing-dots shape), in 4 styles.
 *   2. STYLE CARDS draw in their style's DEFAULT palette (what a pick gives), not the page's: the card's `data-palette` is the
 *      catalogue's `defaultPalette` and its computed `--accent` is that palette's own accent.
 *   3. THE FLAG: "Don't change my colours when I change style" is a switch under the style grid; off, picking Neo on Inkwell
 *      gives Pop Art; on, it leaves Inkwell. One chip per catalogue palette, named by the one map.
 *   4. THE SPECIMEN holds `.md`, `[data-hm]` drawn from the --hm-* tokens, `.fy-spinner` (live, with a moving phase), a
 *      background + grain swatch that wears the page's own tokens, and a disabled field whose computed look differs from the
 *      enabled one (opacity, colour, cursor).
 *   5. THE MOTION PREVIEW draws the style's own spinner: moving when motion is allowed, no running animation when still.
 *      The swatch's GRAIN is asserted on Glass (a grain-bearing style): the `::after` image is the page's own at the style's opacity,
 *      and the read goes to `none` when the image is removed.
 *   6. FOCUS (S13): the switch, a palette chip and a style card draw a ring >= 2px, INSIDE the box (outline width + offset <= 0),
 *      inside every clipping ancestor's padding box on both axes, and >= 3:1 against what is PAINTED behind it (the border and fill
 *      under the stroke, composited). Gen Z's style card is judged like every other control (r11 T12 drew its ring inside, clear of its border).
 *
 * Set `FY_T13_SHOTS_DIR` to keep `<viewport>-<style>-<mode>.png` (the Look group, 4 styles x light/dark x 1280/390).
 * Set `FY_T13_MEASURE=1` to print the measured numbers.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { PALETTES as CATALOGUE_PALETTES, STYLES as CATALOGUE_STYLES } from '../../src/theme/catalog.ts';
import { COLOUR_TOOLS, type ColourTools, sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(120_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_T13_SHOTS_DIR ?? '';
const measuring = process.env.FY_T13_MEASURE === '1';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-appearance-look-'));
  const child = Bun.spawn(
    [
      process.execPath,
      sceneBuilder,
      '--out',
      directory,
      '--entry',
      resolve(packageRoot, 'fixtures/device-controls-scene.tsx'),
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the appearance scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      return new Response(page, { headers: { 'content-type': 'text/html' } });
    },
  });
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VIEWPORTS = [
  { name: '1280', width: 1_280, height: 3_600, phone: false },
  { name: '390', width: 390, height: 8_000, phone: true },
] as const;
type Viewport = (typeof VIEWPORTS)[number];
const FOUR_STYLES = ['studio', 'neo', 'mission', 'pixel'] as const;

const open = async (viewport: Viewport, options: { seed?: object; scheme?: 'light' | 'dark' } = {}) => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: options.scheme ?? 'light',
    deviceScaleFactor: 1,
    hasTouch: viewport.phone,
    isMobile: viewport.phone,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  tab.setDefaultTimeout(10_000);
  const problems: string[] = [];
  tab.on('pageerror', error => problems.push(error.message));
  const seed = options.seed === undefined ? '' : `?seed=${encodeURIComponent(JSON.stringify(options.seed))}`;
  await tab.goto(`${origin}/settings${seed}`);
  await tab.waitForSelector('[data-specimen]');
  return { tab, problems, close: async () => await context.close() };
};

const INDIGO_STUDIO = { style: 'studio', palette: 'studio', mode: 'light', textScale: 'default' };

/** The generic "three dots" probe: any element with exactly 3 element children that all run the one same animation. */
const threeDots = (tab: Page): Promise<string[]> =>
  tab.evaluate(() => {
    const found: string[] = [];
    for (const element of document.querySelectorAll('*')) {
      const kids = [...element.children];
      if (kids.length !== 3) continue;
      const names = kids.map(kid => getComputedStyle(kid).animationName);
      if (names[0] !== 'none' && names.every(name => name === names[0]))
        found.push(`${element.tagName}.${element.className}`);
    }
    return found;
  });

/** What the focus-ring probe reads off the control that holds keyboard focus (all measured in the page). */
interface FocusRing {
  readonly style: string;
  readonly width: number;
  readonly offset: number;
  /** How far the ring's outer edge sits outside the control's border box, px (0 = drawn inside it). */
  readonly reach: number;
  /** The lowest contrast of the ring colour against anything the ring is painted over: the page outside it, the control's border, the control's fill. */
  readonly worst: number;
  readonly behind: readonly { readonly what: string; readonly ratio: number }[];
  /** Set when the control paints a background-image, which the colour arithmetic cannot read. */
  readonly gradient: boolean;
  /** One line per clipping ancestor whose PADDING box the ring's outer rect crosses, on any of the four sides. */
  readonly clipped: readonly string[];
}

/**
 * The page function: the ring of the focused control, measured as the browser painted it. The ring is a band `width` thick whose outer edge
 * sits `offset + width` outside the border box (negative = inside). Walking inward from the border box edge it overlays, in order, whatever lies
 * OUTSIDE the box (the page behind it), then the control's BORDER, then its FILL, so the ring is judged against each of those it overlaps.
 */
const measureFocusRing = (): FocusRing | null => {
  const colour = (window as unknown as { __colour: ColourTools }).__colour;
  const active = document.activeElement as HTMLElement | null;
  if (active === null || active === document.body) return null;
  const drawn = (element: Element): boolean => {
    const css = getComputedStyle(element);
    return (
      css.outlineStyle !== 'none' && Number.parseFloat(css.outlineWidth) > 0 && colour.rgba(css.outlineColor)[3] > 0
    );
  };
  // A visually-hidden radio (1px, sr-only) draws a 1px outline of its own that nobody can see: the ring a person sees is the card's or the chip's.
  const hidden = active.getBoundingClientRect().width <= 2 && active.getBoundingClientRect().height <= 2;
  let owner: HTMLElement = active;
  if (hidden || !drawn(owner))
    for (let node = active.parentElement; node !== null && node !== document.body; node = node.parentElement)
      if (drawn(node)) {
        owner = node;
        break;
      }
  const css = getComputedStyle(owner);
  const width = css.outlineStyle === 'none' ? 0 : Number.parseFloat(css.outlineWidth);
  const offset = Number.parseFloat(css.outlineOffset) || 0;
  const reach = Math.max(0, offset + width);
  const ink = colour.rgba(css.outlineColor);
  const over = (below: readonly number[]): number => colour.ratio(colour.over(ink, [...below, 1]), below);

  const borders = (['Top', 'Right', 'Bottom', 'Left'] as const).map(side => ({
    width: Number.parseFloat(css.getPropertyValue(`border-${side.toLowerCase()}-width`)),
    colour: colour.rgba(css.getPropertyValue(`border-${side.toLowerCase()}-color`)),
  }));
  const thin = Math.min(...borders.map(border => border.width));
  const thick = Math.max(...borders.map(border => border.width));
  const fill = colour.backdrop(owner);
  const behind: { what: string; ratio: number }[] = [];
  // The band, measured inward from the border box edge, runs from -(offset + width) to -offset.
  const outer = -(offset + width);
  const inner = -offset;
  if (outer < 0) behind.push({ what: 'the page outside', ratio: over(colour.backdrop(owner.parentElement ?? owner)) });
  if (inner > 0 && outer < thick)
    for (const border of borders)
      if (border.width > 0 && border.colour[3] > 0)
        behind.push({ what: 'the border', ratio: over(colour.over(border.colour, [...fill, 1])) });
  if (inner > thin) behind.push({ what: 'the fill', ratio: over(fill) });

  const clips = (element: Element): boolean => {
    const style = getComputedStyle(element);
    return (
      style.overflowX !== 'visible' ||
      style.overflowY !== 'visible' ||
      /paint|content|strict/.test(style.contain) ||
      style.clipPath !== 'none'
    );
  };
  const rect = owner.getBoundingClientRect();
  const box = {
    left: rect.left - reach,
    top: rect.top - reach,
    right: rect.right + reach,
    bottom: rect.bottom + reach,
  };
  const clipped: string[] = [];
  for (let node = owner.parentElement; node !== null && node !== document.documentElement; node = node.parentElement) {
    if (!clips(node)) continue;
    const frame = node.getBoundingClientRect();
    const pad = {
      left: frame.left + node.clientLeft,
      top: frame.top + node.clientTop,
      right: frame.left + node.clientLeft + node.clientWidth,
      bottom: frame.top + node.clientTop + node.clientHeight,
    };
    for (const side of ['left', 'top'] as const)
      if (box[side] < pad[side] - 0.5)
        clipped.push(
          `${node.tagName.toLowerCase()}.${node.className} ${side}: ${(pad[side] - box[side]).toFixed(1)}px`,
        );
    for (const side of ['right', 'bottom'] as const)
      if (box[side] > pad[side] + 0.5)
        clipped.push(
          `${node.tagName.toLowerCase()}.${node.className} ${side}: ${(box[side] - pad[side]).toFixed(1)}px`,
        );
  }
  return {
    style: css.outlineStyle,
    width,
    offset,
    reach,
    worst: behind.length === 0 ? 0 : Math.min(...behind.map(part => part.ratio)),
    behind,
    gradient: css.backgroundImage !== 'none',
    clipped,
  };
};

/** Give the control real keyboard focus (so `:focus-visible` draws) and read its ring. */
const focusRing = async (tab: Page, control: ReturnType<Page['locator']>): Promise<FocusRing> => {
  await tab.evaluate(COLOUR_TOOLS);
  await control.evaluate(element => (element as HTMLElement).focus());
  await tab.keyboard.press('Shift+Tab');
  await tab.keyboard.press('Tab');
  const ring = await tab.evaluate(measureFocusRing);
  if (ring === null) throw new Error('nothing holds focus');
  return ring;
};

const FOCUS_TARGETS = (tab: Page) => [
  { name: 'switch', locator: tab.getByRole('switch', { name: /Don.t change my colours/ }) },
  { name: 'palette chip', locator: tab.locator('[data-palette-chip] input:checked') },
  { name: 'style card', locator: tab.locator('[data-choice] input:checked') },
];

/** The owner's S13 rule, as numbers: a visible solid ring >= 2px, drawn inside, inside every clipping padding box, >= 3:1 against what it overlays. */
const judgeRing = (where: string, ring: FocusRing): void => {
  if (measuring)
    console.log(
      `MEASURED ${where}: width ${ring.width} offset ${ring.offset} reach ${ring.reach} worst ${ring.worst.toFixed(2)} (${ring.behind.map(part => `${part.what} ${part.ratio.toFixed(2)}`).join(', ')})`,
    );
  expect(ring.style, `${where}: a solid ring`).not.toBe('none');
  expect(ring.width, `${where}: >= 2px`).toBeGreaterThanOrEqual(2);
  expect(
    ring.reach,
    `${where}: outline width ${ring.width} + offset ${ring.offset} puts it ${ring.reach}px outside`,
  ).toBe(0);
  expect(ring.clipped, `${where}: inside every clipping padding box, on both axes`).toEqual([]);
  expect(ring.gradient, `${where}: the control paints a flat fill the contrast can be read against`).toBe(false);
  expect(
    ring.worst,
    `${where}: contrast against what is painted behind the ring (${ring.behind.map(part => `${part.what} ${part.ratio.toFixed(2)}`).join(', ')})`,
  ).toBeGreaterThanOrEqual(3);
};

const pick = async (tab: Page, style: string): Promise<void> => {
  await tab.locator(`[data-choice="${style}"]`).click();
  await tab.waitForTimeout(400);
};

describe('r11 T13 · the Appearance page', () => {
  it('has no three dots anywhere, in four styles (1280)', async () => {
    const { tab, problems, close } = await open(VIEWPORTS[0]);
    try {
      for (const style of FOUR_STYLES) {
        await pick(tab, style);
        expect(await tab.locator('.fy-dap-dots').count(), `${style}: no .fy-dap-dots`).toBe(0);
        expect(await threeDots(tab), `${style}: no element with 3 children on one animation`).toEqual([]);
      }
      expect(problems).toEqual([]);
    } finally {
      await close();
    }
  });

  it('draws every style card in that style’s default palette, and offers one chip per catalogue palette', async () => {
    const { tab, close } = await open(VIEWPORTS[0], { seed: INDIGO_STUDIO });
    try {
      expect(await tab.locator('[data-palette-chip]').count()).toBe(CATALOGUE_PALETTES.length);
      const labels = await tab.locator('[data-palette-chip] .fy-ap-chip__name').allInnerTexts();
      expect(labels.sort()).toEqual(CATALOGUE_PALETTES.map(palette => palette.label).sort());
      const pageAccent = await tab.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--accent'),
      );
      const rows = await tab.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('[data-choice]')].map(card => {
          const mini = card.querySelector<HTMLElement>('.fy-ap-mini');
          return {
            style: card.dataset.choice ?? '',
            palette: mini?.dataset.palette ?? null,
            mode: mini?.dataset.mode ?? null,
            accent: mini === null ? null : getComputedStyle(mini).getPropertyValue('--accent'),
          };
        }),
      );
      expect(rows.length).toBe(CATALOGUE_STYLES.length);
      const accentOf = async (palette: string, mode: string) =>
        await tab.evaluate(
          ([p, m]) => {
            const half = document.querySelector<HTMLElement>(
              `[data-palette-chip="${p}"] .fy-ap-chip__half[data-mode="${m}"]`,
            );
            return half === null ? null : getComputedStyle(half).getPropertyValue('--accent');
          },
          [palette, mode],
        );
      let differsFromPage = 0;
      for (const entry of CATALOGUE_STYLES) {
        const row = rows.find(candidate => candidate.style === entry.id);
        expect(row?.palette, `${entry.id}: card palette`).toBe(entry.defaultPalette);
        const own = await accentOf(entry.defaultPalette, row?.mode ?? 'light');
        expect(row?.accent, `${entry.id}: card accent is ${entry.defaultPalette}'s own`).toBe(own);
        if (row?.accent !== pageAccent) differsFromPage += 1;
      }
      // Indigo is the page's palette: every style whose default is not Indigo shows a different accent.
      expect(differsFromPage).toBeGreaterThanOrEqual(
        CATALOGUE_STYLES.filter(entry => entry.defaultPalette !== 'studio').length,
      );
    } finally {
      await close();
    }
  });

  it('has the "Don’t change my colours when I change style" flag: off, Neo gives Pop Art; on, Inkwell stays', async () => {
    const { tab, close } = await open(VIEWPORTS[0], { seed: INDIGO_STUDIO });
    try {
      const flag = tab.getByRole('switch', { name: /Don.t change my colours when I change style/ });
      expect(await flag.count()).toBe(1);
      expect(await flag.getAttribute('aria-checked')).toBe('false');
      await pick(tab, 'neo');
      expect(await tab.evaluate(() => document.documentElement.dataset.palette)).toBe('neo');
      await pick(tab, 'studio');
      await tab.locator('[data-palette-chip="studio"]').click();
      await flag.click();
      expect(await flag.getAttribute('aria-checked')).toBe('true');
      await pick(tab, 'neo');
      const after = await tab.evaluate(() => ({
        style: document.documentElement.dataset.style,
        palette: document.documentElement.dataset.palette,
      }));
      expect(after).toEqual({ style: 'neo', palette: 'studio' });
      // The cards stop advertising a palette the pick will not give: with the flag on they draw in the palette you keep.
      expect(await tab.locator('[data-choice="pixel"] .fy-ap-mini').getAttribute('data-palette')).toBe('studio');
    } finally {
      await close();
    }
  });

  for (const viewport of VIEWPORTS)
    it(`the specimen holds markdown, hypermedia, the style's spinner, a background + grain swatch and a disabled field (${viewport.name})`, async () => {
      const { tab, close } = await open(viewport);
      try {
        for (const style of FOUR_STYLES) {
          await pick(tab, style);
          await tab.waitForTimeout(1_200);
          const read = await tab.evaluate(() => {
            const spec = document.querySelector('[data-specimen]') as HTMLElement;
            const md = spec.querySelector<HTMLElement>('.md');
            const hm = spec.querySelector<HTMLElement>('[data-hm]');
            const spinner = spec.querySelector<SVGElement>('.fy-spinner');
            const swatch = spec.querySelector<HTMLElement>('[data-spec-backdrop]');
            const enabled = spec.querySelector<HTMLInputElement>('input[data-spec-state="focus"]');
            const disabled = spec.querySelector<HTMLInputElement>('input:disabled');
            const look = (element: Element | null) => {
              if (element === null) return null;
              const css = getComputedStyle(element);
              return { opacity: css.opacity, color: css.color, background: css.backgroundColor, cursor: css.cursor };
            };
            const hmNodes = hm === null ? [] : [...hm.querySelectorAll<HTMLElement>('[data-hm-node]')];
            const anim = (spinner?.getAnimations({ subtree: true }) ?? []).filter(a => a.playState === 'running');
            return {
              md:
                md === null
                  ? null
                  : { h: md.querySelector('h1, h2, h3') !== null, code: md.querySelector('pre, code') !== null },
              hm:
                hm === null
                  ? null
                  : {
                      nodes: hmNodes.length,
                      radius: hmNodes[0] === undefined ? '' : getComputedStyle(hmNodes[0]).borderTopLeftRadius,
                      stroke: hmNodes[0] === undefined ? '' : getComputedStyle(hmNodes[0]).borderTopWidth,
                      shape: getComputedStyle(hm).getPropertyValue('--hm-shape').trim(),
                    },
              spinner: spinner === null ? null : { running: anim.length },
              swatch:
                swatch === null
                  ? null
                  : {
                      bg: getComputedStyle(swatch).backgroundColor,
                      pattern: getComputedStyle(swatch).backgroundImage,
                      grain: getComputedStyle(swatch, '::after').backgroundImage,
                    },
              enabled: look(enabled),
              disabled: look(disabled),
              wide: document.documentElement.scrollWidth > window.innerWidth,
            };
          });
          const name = `${viewport.name} ${style}`;
          expect(read.md, `${name}: .md block with a heading and code`).toEqual({ h: true, code: true });
          expect(read.hm?.nodes, `${name}: [data-hm] draws nodes`).toBeGreaterThanOrEqual(3);
          expect(read.hm?.shape, `${name}: [data-hm] reads --hm-shape`).not.toBe('');
          expect(read.spinner?.running, `${name}: the specimen's spinner is live`).toBeGreaterThan(0);
          expect(read.swatch?.bg, `${name}: background swatch`).toBeTruthy();
          expect(read.enabled, `${name}: enabled field`).not.toBeNull();
          expect(read.disabled, `${name}: disabled field`).not.toBeNull();
          const e = read.enabled;
          const d = read.disabled;
          expect(
            Number(d?.opacity) < Number(e?.opacity) || d?.color !== e?.color,
            `${name}: the disabled field looks disabled (opacity ${d?.opacity} vs ${e?.opacity}, colour ${d?.color} vs ${e?.color})`,
          ).toBe(true);
          expect(d?.cursor, `${name}: disabled cursor`).toBe('not-allowed');
          expect(read.wide, `${name}: no sideways overflow`).toBe(false);
          if (measuring) console.log(`MEASURED ${name}: ${JSON.stringify(read)}`);
        }
      } finally {
        await close();
      }
    });

  it('the specimen swatch wears the page’s own pattern and grain tokens (a style with grain shows grain)', async () => {
    const { tab, close } = await open(VIEWPORTS[0]);
    try {
      await pick(tab, 'mission');
      const mission = await tab.evaluate(() => {
        const swatch = document.querySelector('[data-spec-backdrop]') as HTMLElement;
        return getComputedStyle(swatch).backgroundImage;
      });
      await pick(tab, 'studio');
      const studio = await tab.evaluate(() => {
        const swatch = document.querySelector('[data-spec-backdrop]') as HTMLElement;
        return getComputedStyle(swatch).backgroundImage;
      });
      expect(mission, 'mission draws a ruled pattern in its swatch').not.toBe('none');
      expect(studio, 'studio draws no pattern').not.toBe(mission);
    } finally {
      await close();
    }
  });

  for (const scheme of ['light', 'dark'] as const)
    it(`the specimen swatch draws the grain of a grain-bearing style: Glass shows its image at its opacity, Studio none (${scheme})`, async () => {
      const { tab, close } = await open(VIEWPORTS[0], { scheme, seed: { ...INDIGO_STUDIO, mode: scheme } });
      const readGrain = () =>
        tab.evaluate(() => {
          const swatch = document.querySelector('[data-spec-backdrop]') as HTMLElement;
          const after = getComputedStyle(swatch, '::after');
          const page = getComputedStyle(document.body, '::after');
          const box = swatch.getBoundingClientRect();
          return {
            image: after.backgroundImage,
            opacity: after.opacity,
            blend: after.mixBlendMode,
            display: after.display,
            position: after.position,
            swatch: { width: box.width, height: box.height },
            token: getComputedStyle(document.documentElement).getPropertyValue('--grain-alpha').trim(),
            pageImage: page.backgroundImage,
            pageOpacity: page.opacity,
          };
        });
      try {
        await pick(tab, 'studio');
        const none = await readGrain();
        expect(none.image, 'studio has no grain image').toBe('none');
        await pick(tab, 'glass');
        await tab.waitForTimeout(600);
        const grain = await readGrain();
        if (measuring)
          console.log(
            `MEASURED glass ${scheme} grain: ${JSON.stringify({ ...grain, image: grain.image.slice(0, 40) })}`,
          );
        expect(grain.image, 'glass: the swatch layer paints the grain image').toMatch(/^url\("?data:image\/svg/);
        expect(grain.image, 'glass: and it is the page’s own grain image').toBe(grain.pageImage);
        expect(Number(grain.opacity), 'glass: at its own grain opacity').toBe(scheme === 'light' ? 0.07 : 0.05);
        expect(grain.opacity, 'glass: the swatch’s opacity is the page’s').toBe(grain.pageOpacity);
        expect(Number(grain.token), 'glass: --grain-alpha is what the swatch reads').toBe(Number(grain.opacity));
        expect(grain.position, 'the grain layer covers the swatch').toBe('absolute');
        expect(grain.display).not.toBe('none');
        expect(grain.swatch.width, 'the swatch has a size').toBeGreaterThan(40);
        // Sensitivity: take the image away and this read must say so (the old test passed with the image forced to none).
        await tab.addStyleTag({ content: '.fy-spec__backdrop::after{background-image:none!important}' });
        expect((await readGrain()).image, 'with the image removed the probe reads none').toBe('none');
      } finally {
        await close();
      }
    });

  it('the Motion preview draws the style’s own spinner: moving when motion is on, no running animation when still', async () => {
    const { tab, close } = await open(VIEWPORTS[0]);
    try {
      for (const style of FOUR_STYLES) {
        await pick(tab, style);
        await tab.waitForTimeout(600);
        const frames = await tab.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>('.fy-dap-frame--motion')].map(frame => {
            const spinner = frame.querySelector<SVGElement>('.fy-spinner');
            const running = (spinner?.getAnimations({ subtree: true }) ?? []).filter(
              a => a.playState === 'running',
            ).length;
            return { motion: frame.dataset.dapMotion ?? '', hasSpinner: spinner !== null, running };
          }),
        );
        expect(frames.length, `${style}: a motion preview`).toBeGreaterThan(0);
        for (const frame of frames) {
          expect(frame.hasSpinner, `${style}: the preview draws the style's spinner`).toBe(true);
          if (frame.motion === 'moving') expect(frame.running, `${style}: moving`).toBeGreaterThan(0);
          else expect(frame.running, `${style}: still`).toBe(0);
        }
      }
      // Reduced: the preview holds the still frame.
      await tab.locator('[role="radiogroup"][aria-label="Motion"] label', { hasText: 'Reduced' }).click();
      await tab.waitForTimeout(600);
      const still = await tab.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('.fy-dap-frame--motion')].map(frame => ({
          motion: frame.dataset.dapMotion ?? '',
          running: (frame.querySelector('.fy-spinner')?.getAnimations({ subtree: true }) ?? []).filter(
            a => a.playState === 'running',
          ).length,
        })),
      );
      for (const frame of still) {
        expect(frame.motion).toBe('still');
        expect(frame.running).toBe(0);
      }
    } finally {
      await close();
    }
  });

  it('the new controls keep their focus ring inside the control, inside every clipping ancestor (both axes) and >= 3:1 against what is painted behind it (S13)', async () => {
    for (const viewport of VIEWPORTS) {
      for (const scheme of ['light', 'dark'] as const) {
        const { tab, close } = await open(viewport, { scheme, seed: { ...INDIGO_STUDIO, mode: scheme } });
        try {
          for (const target of FOCUS_TARGETS(tab)) {
            const where = `${viewport.name} ${scheme} ${target.name}`;
            const ring = await focusRing(tab, target.locator);
            judgeRing(where, ring);
          }
        } finally {
          await close();
        }
      }
    }
  });

  // Gen Z draws its own style-card ring (`genz.css` `.fy-cc__card:has(:focus-visible)`): r11 T12 pulled it inside the card and clear of its
  // 3px border (the ring used to sit at +5px, then on the border at 2.42:1 light), so the style card is judged in full here like the
  // switch and the palette chips: no pin, the same ring assertion as every other style.
  it('in Gen Z the switch, the palette chips and the style card are all judged in full', async () => {
    for (const scheme of ['light', 'dark'] as const) {
      const { tab, close } = await open(VIEWPORTS[0], { scheme, seed: { ...INDIGO_STUDIO, mode: scheme } });
      try {
        await pick(tab, 'genz');
        for (const target of FOCUS_TARGETS(tab)) {
          const where = `genz ${scheme} ${target.name}`;
          judgeRing(where, await focusRing(tab, target.locator));
        }
      } finally {
        await close();
      }
    }
  });

  it('the focus-ring probe is sensitive: a stroke that reaches outside, or a fill the ring cannot be seen on, is caught', async () => {
    const { tab, close } = await open(VIEWPORTS[0], { seed: INDIGO_STUDIO });
    try {
      const chip = tab.locator('[data-palette-chip] input:checked');
      const clean = await focusRing(tab, chip);
      expect(clean.reach, 'a clean chip ring reaches 0px outside').toBe(0);
      expect(clean.worst, 'and holds >= 3:1').toBeGreaterThanOrEqual(3);
      // 1px outside: the same ring with its offset 1px further out.
      await tab.addStyleTag({
        content: '.fy-ap-chip:has(:focus-visible){outline-offset:calc(-1 * var(--focus-width) + 1px)!important}',
      });
      const outside = await focusRing(tab, chip);
      expect(outside.reach, 'a ring 1px outside reaches 1px').toBe(1);
      // The fill under the stroke is the ring's own colour (the old test passed this).
      await tab.addStyleTag({
        content:
          '.fy-ap-chip{outline-offset:calc(-1 * var(--focus-width))!important}.fy-ap-chip,.fy-ap-chip[data-selected="true"]{background:var(--focus-color)!important;border-color:var(--focus-color)!important}',
      });
      const same = await focusRing(tab, chip);
      expect(same.worst, 'a ring on its own colour has contrast ~1').toBeLessThan(1.5);
    } finally {
      await close();
    }
  });

  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      it(`shots: the Look group in four styles (${viewport.name} ${scheme})`, async () => {
        const { tab, problems, close } = await open(viewport, { scheme, seed: { ...INDIGO_STUDIO, mode: scheme } });
        try {
          for (const style of FOUR_STYLES) {
            await pick(tab, style);
            await tab.waitForTimeout(1_400);
            const group = tab.locator('[data-setting-group="Look"]');
            const png = await group.screenshot();
            if (shotsDir !== '') await Bun.write(join(shotsDir, `${viewport.name}-${style}-${scheme}.png`), png);
            expect(
              await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
              `${style}: no sideways overflow`,
            ).toBe(true);
          }
          expect(problems).toEqual([]);
        } finally {
          await close();
        }
      });
});

/**
 * r11 FR3 (gate r11-3, the two blockers). Each assert was written first and is red on the base it was built on.
 *
 *   1. NO SPECIMEN CARD IS CLIPPED BY ITS OWN CORNER (owner: "alot of the super rounded ones are broken"): in every one of the 16
 *      styles, every painted rounded box on the specimen (the Markdown card included) keeps its text boxes inside its own rounded
 *      outline. The Markdown card used the control radius, which is a pill in Glass, Neumorphism, Lucid, Briefing and Gen Z, so it
 *      became a circle and `overflow: hidden` cut the first letters off. (The matrix scene, `theme-matrix.visual.test.ts`, does not
 *      draw the specimen; the specimen belongs to this page, so the same T14 radius/clipping check lives here, over all 16 styles.)
 *   2. A SELECTED CHOICE CARD STAYS READABLE WHILE THE POINTER IS ON IT: after a click the pointer is still on the card, so the hover
 *      look is the look a person sees on every pick. Its title and line keep >= 4.5:1 against the fill painted behind them, in every
 *      style, light and dark (Raw's hover rule outranked its selected rule, so the ink fill was lost and the paper text stayed).
 */

/** Each specimen box that paints something and has a corner radius, and every text box in it that pokes out of the rounded outline. */
const specimenClipped = (): { checked: number; clipped: string[] } => {
  const clipped: string[] = [];
  let checked = 0;
  const scope = document.querySelector('[data-specimen]');
  if (scope === null) return { checked, clipped: ['no [data-specimen] on the page'] };
  const painted = (css: CSSStyleDeclaration): boolean =>
    css.backgroundImage !== 'none' ||
    !/rgba\(\d+, \d+, \d+, 0\)|transparent/.test(css.backgroundColor) ||
    ['Top', 'Right', 'Bottom', 'Left'].some(
      side =>
        css.getPropertyValue(`border-${side.toLowerCase()}-style`) !== 'none' &&
        Number.parseFloat(css.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0,
    );
  const name = (element: Element): string =>
    `${element.tagName.toLowerCase()}.${String(element.className).split(' ')[0]}`;
  for (const box of scope.querySelectorAll<HTMLElement>('*')) {
    const css = getComputedStyle(box);
    const rect = box.getBoundingClientRect();
    // A card is a block: an inline link that wraps over two lines is one box with two line rects, not a card with corners.
    if (css.display === 'inline') continue;
    if (rect.width < 2 || rect.height < 2 || !painted(css)) continue;
    // The four corners' radii, scaled down together the way CSS does when they would overlap (a 999px pill is half the short side).
    const corner = (side: string): [number, number] => {
      const [x, y = x] = css.getPropertyValue(`border-${side}-radius`).split(' ');
      const read = (value: string, whole: number): number =>
        value.endsWith('%') ? (Number.parseFloat(value) / 100) * whole : Number.parseFloat(value) || 0;
      return [read(x as string, rect.width), read(y as string, rect.height)];
    };
    const radii = {
      tl: corner('top-left'),
      tr: corner('top-right'),
      br: corner('bottom-right'),
      bl: corner('bottom-left'),
    };
    const scale = Math.min(
      1,
      rect.width / Math.max(radii.tl[0] + radii.tr[0], radii.bl[0] + radii.br[0], 1),
      rect.height / Math.max(radii.tl[1] + radii.bl[1], radii.tr[1] + radii.br[1], 1),
    );
    for (const key of Object.keys(radii) as (keyof typeof radii)[]) {
      radii[key][0] *= scale;
      radii[key][1] *= scale;
    }
    if (Math.max(...Object.values(radii).flat()) < 1) continue;
    // A point is outside the outline when it lies in a corner's radius square but beyond that corner's ellipse.
    const outside = (x: number, y: number): boolean =>
      (
        [
          ['tl', rect.left, rect.top, 1, 1],
          ['tr', rect.right, rect.top, -1, 1],
          ['br', rect.right, rect.bottom, -1, -1],
          ['bl', rect.left, rect.bottom, 1, -1],
        ] as const
      ).some(([key, cx, cy, sx, sy]) => {
        const [rx, ry] = radii[key];
        if (rx < 1 || ry < 1) return false;
        const dx = (x - cx) * sx;
        const dy = (y - cy) * sy;
        if (dx >= rx || dy >= ry) return false;
        return ((rx - dx) / rx) ** 2 + ((ry - dy) / ry) ** 2 > 1.001;
      });
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if ((node.textContent ?? '').trim() === '') continue;
      const parent = node.parentElement;
      if (parent === null || getComputedStyle(parent).visibility === 'hidden') continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const line of range.getClientRects()) {
        if (line.width < 1 || line.height < 1) continue;
        checked += 1;
        for (const [x, y] of [
          [line.left, line.top],
          [line.right, line.top],
          [line.right, line.bottom],
          [line.left, line.bottom],
        ] as const)
          if (outside(x, y)) {
            clipped.push(
              `${name(box)} cuts "${(node.textContent ?? '').trim().slice(0, 24)}" at (${Math.round(x)},${Math.round(y)})`,
            );
            break;
          }
      }
    }
  }
  return { checked, clipped: [...new Set(clipped)] };
};

/** For every SELECTED choice card on the page, with the pointer on it: the lowest contrast of its text against the fill behind it. */
const selectedCardsHovered = async (
  tab: Page,
): Promise<{ cards: number; worst: { card: string; text: string; ratio: number }[]; painted: number }> => {
  await tab.evaluate(COLOUR_TOOLS);
  const count = await tab.locator('.fy-cc__card[data-selected="true"]').count();
  const worst: { card: string; text: string; ratio: number }[] = [];
  let painted = 0;
  for (let index = 0; index < count; index += 1) {
    const card = tab.locator('.fy-cc__card[data-selected="true"]').nth(index);
    await card.scrollIntoViewIfNeeded();
    await card.hover();
    await tab.waitForTimeout(250);
    const read = await card.evaluate(element => {
      const { backdrop, over, ratio, rgba } = (window as unknown as { __colour: ColourTools }).__colour;
      const label = `${element.getAttribute('data-choice') ?? '?'}`;
      if (!element.matches(':hover')) return { label, hovered: false, gradient: false, rows: [] };
      const rows: { text: string; ratio: number }[] = [];
      for (const text of element.querySelectorAll<HTMLElement>('.fy-cc__title, .fy-cc__line')) {
        const fill = backdrop(text);
        const ink = rgba(getComputedStyle(text).color);
        rows.push({ text: (text.textContent ?? '').trim().slice(0, 24), ratio: ratio(over(ink, [...fill, 1]), fill) });
      }
      return { label, hovered: true, gradient: getComputedStyle(element).backgroundImage !== 'none', rows };
    });
    if (!read.hovered) throw new Error(`the pointer is not on the selected card ${read.label}`);
    if (read.gradient) painted += 1;
    for (const row of read.rows) worst.push({ card: read.label, ...row });
  }
  return { cards: count, worst, painted };
};

describe('r11 FR3 · the Appearance page, every style', () => {
  for (const scheme of ['light', 'dark'] as const)
    for (const viewport of VIEWPORTS)
      it(`no specimen card has its text clipped by its own rounded corner, all ${CATALOGUE_STYLES.length} styles (${viewport.name} ${scheme})`, async () => {
        const { tab, problems, close } = await open(viewport, { scheme, seed: { ...INDIGO_STUDIO, mode: scheme } });
        try {
          const found: string[] = [];
          let checked = 0;
          for (const entry of CATALOGUE_STYLES) {
            await pick(tab, entry.id);
            await tab.waitForTimeout(300);
            const read = await tab.evaluate(specimenClipped);
            checked += read.checked;
            for (const line of read.clipped) found.push(`${entry.id}: ${line}`);
          }
          if (measuring)
            console.log(`MEASURED clip ${viewport.name} ${scheme}: ${checked} text boxes, ${found.length} clipped`);
          expect(checked, 'the probe read text boxes').toBeGreaterThan(CATALOGUE_STYLES.length * 10);
          expect(found, 'no text box leaves its card’s rounded outline').toEqual([]);
          expect(problems).toEqual([]);
        } finally {
          await close();
        }
      });

  for (const scheme of ['light', 'dark'] as const)
    it(`a selected choice card keeps its text >= 4.5:1 against its fill while hovered, all ${CATALOGUE_STYLES.length} styles (${scheme})`, async () => {
      const { tab, problems, close } = await open(VIEWPORTS[0], { scheme, seed: { ...INDIGO_STUDIO, mode: scheme } });
      try {
        const low: string[] = [];
        let rows = 0;
        for (const entry of CATALOGUE_STYLES) {
          await pick(tab, entry.id);
          await tab.waitForTimeout(300);
          const read = await selectedCardsHovered(tab);
          expect(read.cards, `${entry.id}: the page has a selected choice card`).toBeGreaterThan(0);
          rows += read.worst.length;
          if (measuring)
            console.log(
              `MEASURED hover ${entry.id} ${scheme}: ${read.worst.map(row => `${row.card}/${row.text} ${row.ratio.toFixed(2)}`).join(', ')}`,
            );
          for (const row of read.worst)
            if (row.ratio < 4.5)
              low.push(`${entry.id}: card "${row.card}" text "${row.text}" ${row.ratio.toFixed(2)}:1`);
        }
        expect(rows, 'the probe read the selected cards’ text').toBeGreaterThan(CATALOGUE_STYLES.length);
        expect(low, 'every selected card, hovered, stays readable').toEqual([]);
        expect(problems).toEqual([]);
      } finally {
        await close();
      }
    });
});
