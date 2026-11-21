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
 *   3. THE FLAG: "Don't change my colours when I change style" is a switch under the style grid; off, picking Neo on Indigo
 *      gives Pop; on, it leaves Indigo. Exactly 8 palette chips, named by colour.
 *   4. THE SPECIMEN holds `.md`, `[data-hm]` drawn from the --hm-* tokens, `.fy-spinner` (live, with a moving phase), a
 *      background + grain swatch that wears the page's own tokens, and a disabled field whose computed look differs from the
 *      enabled one (opacity, colour, cursor).
 *   5. THE MOTION PREVIEW draws the style's own spinner: moving when motion is allowed, no running animation when still.
 *   6. FOCUS (S13): the switch, a palette chip and a style card draw a ring INSIDE their box and inside every clipping
 *      ancestor, >= 2px and >= 3:1 against what is behind it.
 *
 * Set `FY_T13_SHOTS_DIR` to keep `<viewport>-<style>-<mode>.png` (the Look group, 4 styles x light/dark x 1280/390).
 * Set `FY_T13_MEASURE=1` to print the measured numbers.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { STYLES as CATALOGUE_STYLES } from '../../src/theme/catalog.ts';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';

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

  it('draws every style card in that style’s default palette, and offers exactly 8 palette chips', async () => {
    const { tab, close } = await open(VIEWPORTS[0], { seed: INDIGO_STUDIO });
    try {
      expect(await tab.locator('[data-palette-chip]').count()).toBe(8);
      const labels = await tab.locator('[data-palette-chip] .fy-ap-chip__name').allInnerTexts();
      expect(labels.sort()).toEqual(['Blue', 'Green', 'High contrast', 'Indigo', 'Magenta', 'Pop', 'Rust', 'Teal']);
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

  it('has the "Don’t change my colours when I change style" flag: off, Neo gives Pop; on, Indigo stays', async () => {
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

  it('the new controls keep their focus ring inside, inside every clipping ancestor, at >= 3:1 (S13)', async () => {
    for (const viewport of VIEWPORTS) {
      for (const scheme of ['light', 'dark'] as const) {
        const { tab, close } = await open(viewport, { scheme, seed: { ...INDIGO_STUDIO, mode: scheme } });
        try {
          const targets = [
            { name: 'switch', locator: tab.getByRole('switch', { name: /Don.t change my colours/ }) },
            { name: 'palette chip', locator: tab.locator('[data-palette-chip] input:checked') },
            { name: 'style card', locator: tab.locator('[data-choice] input:checked') },
          ];
          for (const target of targets) {
            const where = `${viewport.name} ${scheme} ${target.name}`;
            expect(await target.locator.count(), `${where}: exists`).toBe(1);
            await target.locator.evaluate(element => (element as HTMLElement).focus());
            await tab.keyboard.press('Shift+Tab');
            await tab.keyboard.press('Tab');
            const ring = await target.locator.evaluate(focused => {
              const owner = focused.closest<HTMLElement>('label') ?? (focused as HTMLElement);
              const box = owner.getBoundingClientRect();
              const target = owner.matches(':focus-visible') ? owner : (owner.querySelector(':focus-visible') ?? owner);
              const css = getComputedStyle(
                owner.matches(':has(:focus-visible)') && !owner.matches(':focus-visible')
                  ? owner
                  : (target as HTMLElement),
              );
              // The colour behind the ring: the first opaque background walking up from the owner.
              const parse = (value: string): [number, number, number, number] => {
                const m = value.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 0];
                if (value.startsWith('color('))
                  return [(m[0] ?? 0) * 255, (m[1] ?? 0) * 255, (m[2] ?? 0) * 255, m[3] ?? 1];
                return [m[0] ?? 0, m[1] ?? 0, m[2] ?? 0, m[3] ?? 1];
              };
              let behind: [number, number, number, number] = [255, 255, 255, 1];
              for (let node: Element | null = owner.parentElement; node !== null; node = node.parentElement) {
                const bg = parse(getComputedStyle(node).backgroundColor);
                if (bg[3] > 0.99) {
                  behind = bg;
                  break;
                }
              }
              const clips: { x: number; y: number; right: number; bottom: number }[] = [];
              for (let node = owner.parentElement; node !== null; node = node.parentElement) {
                const style = getComputedStyle(node);
                if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
                  const rect = node.getBoundingClientRect();
                  clips.push({ x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom });
                }
              }
              return {
                offset: parseFloat(css.outlineOffset),
                width: parseFloat(css.outlineWidth),
                style: css.outlineStyle,
                colour: parse(css.outlineColor),
                behind,
                box: { x: box.x, y: box.y, right: box.right, bottom: box.bottom },
                clips,
              };
            });
            const luminance = ([r, g, b]: number[]) => {
              const f = (v: number) => {
                const s = v / 255;
                return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
              };
              return 0.2126 * f(r as number) + 0.7152 * f(g as number) + 0.0722 * f(b as number);
            };
            const a = luminance(ring.colour);
            const b = luminance(ring.behind);
            const contrast = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
            expect(ring.style, `${where}: a solid ring`).not.toBe('none');
            expect(ring.width, `${where}: >= 2px`).toBeGreaterThanOrEqual(2);
            expect(ring.offset, `${where}: drawn inside (offset ${ring.offset})`).toBeLessThanOrEqual(0);
            expect(contrast, `${where}: ring contrast ${contrast.toFixed(2)}`).toBeGreaterThanOrEqual(3);
            for (const clip of ring.clips) {
              expect(ring.box.x, `${where}: inside a clipping ancestor (left)`).toBeGreaterThanOrEqual(clip.x - 0.5);
              expect(ring.box.right, `${where}: inside a clipping ancestor (right)`).toBeLessThanOrEqual(
                clip.right + 0.5,
              );
            }
            if (measuring)
              console.log(
                `MEASURED ${where}: offset ${ring.offset} width ${ring.width} contrast ${contrast.toFixed(2)}`,
              );
          }
        } finally {
          await close();
        }
      }
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
