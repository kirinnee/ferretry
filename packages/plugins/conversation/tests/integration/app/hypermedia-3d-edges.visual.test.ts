/**
 * THE 3D STAGE'S EDGES AND FILLS, AS THE RENDERER READS THEM, IN EVERY THEME (r12 H4 follow-up, end-list L145; r2 review).
 * Durian's 3D stage draws each box and cylinder with an outline over a fill, and takes both from the CSS tokens on its own
 * host (`.scn3`, inside the `.scn-stage` whose ground is `--surface-2`): a plain thing's edge is `--line-2` over its `--surface`
 * (or `--surface-2`) fill, a muted one's is `--line` over `--surface-3`, a toned one's is its own colour over its soft fill,
 * and a family thing's is `--cK` over `--cK-soft`.
 *
 * WHAT THIS HOLDS IS WHAT THREE.JS GETS. Durian turns a token into a colour with `probe.fillStyle = token;
 * new THREE.Color(probe.fillStyle)`, and a `color-mix()` serialises as `color(srgb …)`, which three.js does not parse (it
 * falls back to WHITE). Measuring canvas pixels hid that: the pixels were right and the renderer's colours were white (dark
 * Studio accent edge 2.77:1, light plain edge 1.00:1). So this reads each token exactly as Durian does, in real Chromium,
 * and feeds the serialised string to the INSTALLED three.js `Color`, then checks, for every style x palette x mode:
 *   1. the three.js colour is the colour the browser draws for the same token (never the white fallback);
 *   2. each edge is >= 3:1 against the fill it sits on and against the stage ground, measured on the three.js colours.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import type { Browser } from 'playwright-core';
import { PALETTES, STYLES } from '@ferretry/app';
import { sharedChromium } from '@ferretry/app/testing/browser';
import { fyRenderIntegrationFixture } from './support/fy-render-integration-fixture.ts';

setDefaultTimeout(300_000);

const packageRoot = import.meta.dir;
let browser: Browser;
let styles = '';
let stageModule = '';
/** The slice of three.js this test uses: its `Color`, parsing a CSS string the way Durian's stage does. */
interface ThreeColor {
  getHexString(): string;
}
let THREE: { Color: new (style: string) => ThreeColor };

beforeAll(async () => {
  browser = await sharedChromium();
  const durian = dirname(
    createRequire(join(packageRoot, '../../../package.json')).resolve('durian-hypermedia/package.json'),
  );
  const { buildCss } = (await import(join(durian, 'scripts/build-css.ts'))) as { buildCss: () => string };
  // The same three.js Durian's stage runs on (its own dependency).
  THREE = (await import(createRequire(join(durian, 'package.json')).resolve('three'))) as typeof THREE;
  const theme = await readFile(join(packageRoot, '../../../app/hypermedia/dh-theme.css'), 'utf8');
  const fixture = await fyRenderIntegrationFixture();
  styles = `${fixture.appCss}\n${buildCss()}\n${theme}`;
  // The app's own module, transpiled (no bundling: it imports nothing) and loaded as a module in the page.
  const source = await readFile(join(packageRoot, '../../../app/hypermedia/stage-colours.ts'), 'utf8');
  stageModule = new Bun.Transpiler({ loader: 'ts' }).transformSync(source);
}, 280_000);

afterAll(() => undefined);

/** Every token Durian's stage reads (`readColours` in its `anim3d.ts`). */
const TOKENS = [
  'surface',
  'surface-2',
  'surface-3',
  'line',
  'line-2',
  'ink',
  'muted',
  'faint',
  'acc',
  'acc-soft',
  'acc-softer',
  'good',
  'good-soft',
  'warn',
  'warn-soft',
  'hot',
  'hot-soft',
  'bad',
  ...[1, 2, 3, 4, 5, 6, 7, 8].flatMap(k => [`c${k}`, `c${k}-soft`]),
];

/** [the edge's token, the fill it is drawn over]: `tone()` in Durian's `anim3d.ts`. */
const PAIRS: readonly (readonly [string, string])[] = [
  ['line-2', 'surface'],
  ['line-2', 'surface-2'],
  ['line', 'surface-3'],
  ['acc', 'acc-soft'],
  ['good', 'good-soft'],
  ['warn', 'warn-soft'],
  ['hot', 'hot-soft'],
  ...[1, 2, 3, 4, 5, 6, 7, 8].map(k => [`c${k}`, `c${k}-soft`] as const),
];

interface Read {
  readonly combo: string;
  readonly token: string;
  /** What `probe.fillStyle` serialises to for the token: the string Durian hands three.js. */
  readonly serialised: string;
  /** The colour the browser draws for the same token (the mix's recipe where the token is a mix), as `#rrggbb`. */
  readonly drawn: string;
}

/** In the page, as Durian's stage does it: every token of one look, read from the stage host after a look change. */
const readLook = async (combo: { style: string; palette: string; mode: string }): Promise<Read[]> => {
  const root = document.documentElement;
  root.setAttribute('data-style', combo.style);
  root.setAttribute('data-palette', combo.palette);
  root.setAttribute('data-mode', combo.mode);
  // The look changed: the part's own observer re-resolves its box, as it does for a reader's switch.
  await new Promise(resolve => setTimeout(resolve, 0));
  const host = document.querySelector('.scn3') as HTMLElement;
  const box = document.querySelector('[data-fy-animation]') as HTMLElement;
  const probe = document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const g = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  const hex = (css: string): string => {
    g.clearRect(0, 0, 1, 1);
    g.fillStyle = '#000';
    g.fillStyle = css;
    g.fillRect(0, 0, 1, 1);
    const d = g.getImageData(0, 0, 1, 1).data;
    return `#${[d[0], d[1], d[2]].map(v => (v as number).toString(16).padStart(2, '0')).join('')}`;
  };
  const label = `${combo.style}/${combo.palette}/${combo.mode}`;
  return window.__fyStageTokens.map(token => {
    // Durian's read, character for character.
    const value = getComputedStyle(host).getPropertyValue(`--${token}`).trim() || '#888';
    probe.fillStyle = '#000';
    probe.fillStyle = value;
    const recipe = getComputedStyle(box).getPropertyValue(`--stage-src-${token}`).trim();
    return { combo: label, token, serialised: String(probe.fillStyle), drawn: hex(recipe === '' ? value : recipe) };
  });
};

declare global {
  interface Window {
    __fyStageTokens: string[];
  }
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>${'%STYLES%'}</style></head><body class="bg-bg text-fg"><div class="fy-hm"><div class="dh-doc"><div class="scn" data-fy-animation><div class="scn-stage"><div class="scn3"></div></div></div></div></div></body></html>`;

const openStage = async () => {
  const context = await browser.newContext({ viewport: { width: 1_280, height: 900 } });
  const page = await context.newPage();
  await context.route('**/*', async route => await route.abort());
  await page.setContent(PAGE.replace('%STYLES%', () => styles));
  await page.addScriptTag({
    type: 'module',
    content: `${stageModule}\nwindow.__fyWatch = watchStageColours;\nwindow.__fyStageTokens = ${JSON.stringify(TOKENS)};\nwindow.__fyStageReady = true;`,
  });
  await page.waitForFunction(() => (window as unknown as { __fyStageReady?: boolean }).__fyStageReady === true);
  await page.evaluate(() => {
    const w = window as unknown as { __fyWatch: (box: HTMLElement) => () => void };
    w.__fyWatch(document.querySelector('[data-fy-animation]') as HTMLElement);
  });
  return { context, page };
};

const luminance = (c: { r: number; g: number; b: number }): number => {
  // The sRGB bytes of a three.js colour (what it draws on screen), as relative luminance.
  const f = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
};

/** What three.js makes of a serialised token, as sRGB bytes. */
const threeRgb = (serialised: string): { r: number; g: number; b: number; hex: string } => {
  const color = new THREE.Color(serialised);
  const hex = `#${color.getHexString()}`;
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
    hex,
  };
};

const ratio = (a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

const near = (a: string, b: string): boolean =>
  [1, 3, 5].every(i => Math.abs(Number.parseInt(a.slice(i, i + 2), 16) - Number.parseInt(b.slice(i, i + 2), 16)) <= 1);

describe('the 3D stage colours, as three.js reads them', () => {
  it('are the colours the browser draws for each token (never three.js’s white fallback) and edges are >= 3:1, in every style, palette and mode', async () => {
    const { context, page } = await openStage();
    const reads: Read[] = [];
    for (const style of STYLES)
      for (const palette of PALETTES)
        for (const mode of ['light', 'dark'])
          reads.push(...(await page.evaluate(readLook, { style: style.id, palette: palette.id, mode })));
    await context.close();
    expect(reads.length).toBe(STYLES.length * PALETTES.length * 2 * TOKENS.length);

    // 1. What three.js makes of the token IS what the browser draws for it.
    const wrong = reads
      .map(read => ({ ...read, three: threeRgb(read.serialised).hex }))
      .filter(read => !near(read.three, read.drawn));
    expect(
      wrong
        .slice(0, 5)
        .map(read => `${read.combo} --${read.token}: ${read.serialised} -> ${read.three}, browser draws ${read.drawn}`),
    ).toEqual([]);
    expect(wrong.length).toBe(0);

    // 2. The edges, on three.js's colours. EVERY pair is held, in light AND dark, family colours included (`--c1`..`--c8`,
    // the palette's own data-visualisation ramp): a pale ramp colour (the Briefing yellow) on its own tint was under 3:1, so
    // the stage draws a family edge from a deepened copy of the ramp colour (`--stage-src-cK`), never the pale one.
    const byCombo = new Map<string, Map<string, ReturnType<typeof threeRgb>>>();
    for (const read of reads) {
      const tokens = byCombo.get(read.combo) ?? new Map();
      tokens.set(read.token, threeRgb(read.serialised));
      byCombo.set(read.combo, tokens);
    }
    const failing: string[] = [];
    let measured = 0;
    for (const [combo, tokens] of byCombo) {
      const ground = tokens.get('surface-2') as ReturnType<typeof threeRgb>;
      for (const [edge, fill] of PAIRS) {
        const e = tokens.get(edge) as ReturnType<typeof threeRgb>;
        for (const [against, other] of [
          [fill, tokens.get(fill) as ReturnType<typeof threeRgb>],
          ['stage ground', ground],
        ] as const) {
          measured += 1;
          const value = ratio(e, other);
          if (value < 3) failing.push(`${combo} --${edge} on ${against}: ${value.toFixed(2)}`);
        }
      }
    }
    expect(measured).toBe(STYLES.length * PALETTES.length * 2 * PAIRS.length * 2);
    expect(failing.slice(0, 8)).toEqual([]);
    expect(failing.length).toBe(0);
  });

  it('a look change reaches the stage already resolved: a later observer (Durian’s own) reads plain colours three.js parses', async () => {
    const { context, page } = await openStage();
    const result = await page.evaluate(async () => {
      const root = document.documentElement;
      const host = document.querySelector('.scn3') as HTMLElement;
      const probe = document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D;
      const seen: string[] = [];
      // Created AFTER the part's observer, like the 3D stage's, and reading as `readColours` does.
      const durian = new MutationObserver(() => {
        const v = getComputedStyle(host).getPropertyValue('--line-2').trim() || '#888';
        probe.fillStyle = '#000';
        probe.fillStyle = v;
        seen.push(String(probe.fillStyle));
      });
      durian.observe(root, {
        attributes: true,
        attributeFilter: ['data-theme', 'data-palette', 'class', 'style', 'data-mode'],
      });
      root.setAttribute('data-mode', 'dark');
      await new Promise(resolve => setTimeout(resolve, 0));
      root.setAttribute('data-mode', 'light');
      await new Promise(resolve => setTimeout(resolve, 0));
      durian.disconnect();
      return seen;
    });
    await context.close();
    expect(result.length).toBe(2);
    // dark and light differ, and each is a plain hex three.js reads.
    expect(result.every(each => /^#[0-9a-f]{6}$/u.test(each))).toBe(true);
    expect(new Set(result).size).toBe(2);
  });
});
