/**
 * THE CHART SERIES (`--viz-1` … `--viz-8`) KEEP APART IN EVERY PALETTE AND MODE, and stay readable on the page. A chart
 * (an `fy-render` `chart`, a Mermaid diagram) names a slot, never a colour, so two slots that resolve to one colour draw two
 * series the reader cannot tell apart. The default mapping (`tokens/base-palette.css`) reads hues every palette already
 * restates; Hacker, Vintage, Vaporwave, Mesh, Aurora, Afterglow and Briefing give two of those hues ONE colour (E14b: the
 * first full integration run found 30 look/pair collisions), so each restates the slots it needs in its own file.
 *
 * This resolves the REAL stylesheet in Chromium, for every palette in both modes, and requires:
 *  - the first five slots at least 60 apart in RGB (of 441) and all eight at least 30 (what `base-palette.css` claims);
 *  - every series 3:1 against the page surface it is drawn on (a graphic object, WCAG 1.4.11).
 */
import { beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import type { Page } from 'playwright-core';
import { ALL_PALETTE_IDS, sharedChromium } from '../support/browser/index.ts';
import { readThemeCss } from '../../src/testing/theme-css.ts';

setDefaultTimeout(60_000);

const SLOTS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

/** The palettes whose own file restates series slots (E14b): they were built to a tighter bar, every pair 45 apart, and keep it. */
const REPAIRED = new Set(['hacker', 'vintage', 'vaporwave', 'mesh', 'aurora', 'afterglow', 'briefing']);

interface Look {
  readonly series: readonly (readonly number[])[];
  readonly surface: readonly number[];
  readonly bg: readonly number[];
}

let page: Page;
beforeAll(async () => {
  const browser = await sharedChromium();
  const context = await browser.newContext();
  page = await context.newPage();
  await page.setContent(`<!doctype html><html><head><style>${readThemeCss()}</style></head><body></body></html>`);
}, 120_000);

const looksOf = async (palette: string, mode: string): Promise<Look> =>
  await page.evaluate(
    ([id, tone]) => {
      const root = document.documentElement;
      root.setAttribute('data-style', 'studio');
      root.setAttribute('data-palette', id as string);
      root.setAttribute('data-mode', tone as string);
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
      const style = getComputedStyle(root);
      const rgb = (token: string): number[] => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = '#000';
        context.fillStyle = style.getPropertyValue(token).trim();
        context.fillRect(0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
      };
      return {
        series: [1, 2, 3, 4, 5, 6, 7, 8].map(slot => rgb(`--viz-${slot}`)),
        surface: rgb('--surface'),
        bg: rgb('--bg'),
      };
    },
    [palette, mode] as const,
  );

const distance = (a: readonly number[], b: readonly number[]): number =>
  Math.hypot(...[0, 1, 2].map(at => (a[at] ?? 0) - (b[at] ?? 0)));

const luminance = (colour: readonly number[]): number => {
  const [r, g, b] = colour.map(channel => {
    const unit = channel / 255;
    return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
};

const contrast = (a: readonly number[], b: readonly number[]): number => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
};

describe('the chart series', () => {
  for (const mode of ['light', 'dark'] as const) {
    for (const palette of ALL_PALETTE_IDS) {
      it(`${palette}-${mode}: no two series are near-duplicates, and each reads 3:1 on the page`, async () => {
        const look = await looksOf(palette, mode);
        expect(look.series.length).toBe(SLOTS.length);
        const near: string[] = [];
        for (let a = 0; a < look.series.length; a += 1)
          for (let b = a + 1; b < look.series.length; b += 1) {
            const apart = distance(look.series[a] ?? [], look.series[b] ?? []);
            const floor = a < 5 && b < 5 ? 60 : REPAIRED.has(palette) ? 45 : 30;
            if (apart < floor) near.push(`viz-${a + 1} ~ viz-${b + 1} (${Math.round(apart)})`);
          }
        expect({ palette, mode, near }).toEqual({ palette, mode, near: [] });

        const faint: string[] = [];
        for (const [index, colour] of look.series.entries()) {
          const ratio = Math.min(contrast(colour, look.surface), contrast(colour, look.bg));
          if (ratio < 3) faint.push(`viz-${index + 1} ${ratio.toFixed(2)}:1`);
        }
        expect({ palette, mode, faint }).toEqual({ palette, mode, faint: [] });
      });
    }
  }
});
