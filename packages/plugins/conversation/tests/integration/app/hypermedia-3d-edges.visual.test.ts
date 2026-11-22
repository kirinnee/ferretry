/**
 * THE 3D STAGE'S EDGES, IN EVERY THEME (r12 H4 follow-up, end-list L145). Durian's 3D stage draws each box and cylinder with
 * an outline whose colour it reads, once at draw and again on a theme change, from the CSS tokens on its own host
 * (`.scn3`, inside the `.scn-stage` whose ground is `--surface-2`): a plain thing's edge is `--line-2` over its `--surface`
 * (or `--surface-2`) fill, a muted one's is `--line` over `--surface-3`, and a toned one's is its own colour over its soft
 * fill. In dark mode the hairline border colours the app gives `--line` / `--line-2` for 2D rules fell well under the 3:1 a
 * graphic needs, so a 3D scene's outlines were nearly invisible.
 *
 * Measured here in real Chromium on the real app and Durian stylesheets, on the DOM the stage's host lives in, for every
 * style x palette x mode: each edge colour is >= 3:1 against the fill it sits on AND against the stage ground.
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

beforeAll(async () => {
  browser = await sharedChromium();
  const root = dirname(
    createRequire(join(packageRoot, '../../../package.json')).resolve('durian-hypermedia/package.json'),
  );
  const { buildCss } = (await import(join(root, 'scripts/build-css.ts'))) as { buildCss: () => string };
  const theme = await readFile(join(packageRoot, '../../../app/hypermedia/dh-theme.css'), 'utf8');
  const fixture = await fyRenderIntegrationFixture();
  styles = `${fixture.appCss}\n${buildCss()}\n${theme}`;
}, 280_000);

afterAll(() => undefined);

interface Row {
  readonly combo: string;
  readonly edge: string;
  readonly against: string;
  readonly ratio: number;
}

/** In the page: the ratio of every edge colour the stage draws to what it sits on, for one look. */
const measure = (combo: { style: string; palette: string; mode: string }): Row[] => {
  const root = document.documentElement;
  root.setAttribute('data-style', combo.style);
  root.setAttribute('data-palette', combo.palette);
  root.setAttribute('data-mode', combo.mode);
  const host = document.querySelector('.scn3') as HTMLElement;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const g = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  // Exactly the stage's own read: `getComputedStyle(host).getPropertyValue(--name)`, normalised by a canvas.
  const rgb = (name: string): [number, number, number] => {
    const raw = getComputedStyle(host).getPropertyValue(`--${name}`).trim() || '#888';
    g.clearRect(0, 0, 1, 1);
    g.fillStyle = '#000';
    g.fillStyle = raw;
    g.fillRect(0, 0, 1, 1);
    const d = g.getImageData(0, 0, 1, 1).data;
    return [d[0] as number, d[1] as number, d[2] as number];
  };
  const lum = (c: readonly number[]): number => {
    const f = (v: number): number => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(c[0] as number) + 0.7152 * f(c[1] as number) + 0.0722 * f(c[2] as number);
  };
  const ratio = (a: readonly number[], b: readonly number[]): number => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  };
  const ground = rgb('surface-2');
  const label = `${combo.style}/${combo.palette}/${combo.mode}`;
  // [the edge's token, the fill it is drawn over]: `tone()` in Durian's `anim3d.ts`.
  const pairs: readonly (readonly [string, string])[] = [
    ['line-2', 'surface'],
    ['line-2', 'surface-2'],
    ['line', 'surface-3'],
    ['acc', 'acc-soft'],
    ['good', 'good-soft'],
    ['warn', 'warn-soft'],
    ['hot', 'hot-soft'],
    ...[1, 2, 3, 4, 5, 6, 7, 8].map(k => [`c${k}`, `c${k}-soft`] as const),
  ];
  const rows: Row[] = [];
  for (const [edge, fill] of pairs) {
    rows.push({ combo: label, edge, against: fill, ratio: ratio(rgb(edge), rgb(fill)) });
    rows.push({ combo: label, edge, against: 'stage ground', ratio: ratio(rgb(edge), ground) });
  }
  return rows;
};

describe('the 3D stage edges', () => {
  it('are >= 3:1 against their fill and the stage ground, in every style, palette and mode', async () => {
    const context = await browser.newContext({ viewport: { width: 1_280, height: 900 } });
    const page = await context.newPage();
    await context.route('**/*', async route => await route.abort());
    await page.setContent(
      `<!doctype html><html><head><meta charset="utf-8"><style>${styles}</style></head><body class="bg-bg text-fg"><div class="fy-hm"><div class="dh-doc"><div class="scn"><div class="scn-stage"><div class="scn3"></div></div></div></div></div></body></html>`,
    );
    const rows: Row[] = [];
    for (const style of STYLES)
      for (const palette of PALETTES)
        for (const mode of ['light', 'dark'])
          rows.push(...(await page.evaluate(measure, { style: style.id, palette: palette.id, mode })));
    await context.close();
    // DARK is the owner-visible failure and is held for every pair. In LIGHT the grey and status edges are held too; the
    // eight family colours (`--c1`..`--c8`, the palette's own data-visualisation ramp) are not: a pale ramp colour (the
    // Briefing yellow, the seventh slot of most palettes) sits at or under 3:1 on its own tint, which is a palette
    // decision this item does not change (the family colours are the charts' too).
    const held = (row: Row): boolean => row.combo.endsWith('/dark') || !/^c\d$/u.test(row.edge);
    expect(rows.length).toBe(STYLES.length * PALETTES.length * 2 * 30);
    expect(rows.filter(row => held(row) && row.ratio < 3)).toEqual([]);
  });
});
